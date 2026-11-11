import { createArgs, editArgs, isAllowedEvery, repoAddArgs, shellQuote } from '../automation.ts'
import { die, parseFlags, parseNow } from '../cli.ts'
import { loadConfig, saveConfig } from '../config.ts'
import { getMeta, openDb, setMeta } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  CHANNEL_ID_PATTERN,
  COMMAND_DEADLINE_MS,
  DEFAULT_EVERY_MINUTES,
  LABEL_WRITE_PERMISSIONS,
  LAUNCHER_FILE_MODE,
  REPO_PATTERN,
  SLACK_APP_NAME,
} from '../defaults.ts'
import { ensurePrivateDir } from '../fs.ts'
import { createGh, ensureLabels, findGhPath, ghAuthOk, repoInfo, viewerLogin } from '../github.ts'
import { asArray, asString, get } from '../json.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { orcaArgv, runOrca } from '../orca.ts'
import { homePaths, intakeHome, pluginRoot } from '../paths.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
import { authTest, createSlackClient, fetchLatest } from '../slack-api.ts'
import { formatTs } from '../slack-text.ts'

import { chmodSync, copyFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '../config.ts'
import type { HomePaths } from '../paths.ts'

const destinationError = '送り先は変更できません。~/.slack-issue-intake を退避してから設定し直してください'
const installLauncher = (paths: HomePaths): void => {
  ensurePrivateDir(paths.binDir)
  ensurePrivateDir(paths.runDir)
  copyFileSync(join(pluginRoot(), 'bin/launch.ts'), paths.launcherScript)
  writeFileSync(
    paths.launcher,
    `#!/bin/sh\nNODE=${shellQuote(process.execPath)}\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" ${shellQuote(paths.launcherScript)} "$@"\n`,
    { mode: LAUNCHER_FILE_MODE },
  )
  chmodSync(paths.launcher, LAUNCHER_FILE_MODE)
}
const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const register = (home: string, config: Config, paths: HomePaths, guard: () => void): string => {
  guard()
  const added = runOrca(repoAddArgs(paths.runDir))
  if (!added.ok || !asString(get(added.json ?? undefined, 'result', 'repo', 'id'))) {
    const listed = runOrca(['repo', 'list'])
    const repos = asArray(get(listed.json ?? undefined, 'result', 'repos'))
    if (!listed.ok || !repos?.some((r) => realPath(asString(get(r, 'path')) ?? '') === realPath(paths.runDir)))
      throw new Error(`orca repo add に失敗しました: ${added.stderr || listed.stderr}`)
  }
  guard()
  config.orca.workspaceSelector = `path:${paths.runDir}`
  saveConfig(home, config)
  let created = config.orca.automationId === null
  if (config.orca.automationId) {
    guard()
    const edited = runOrca(editArgs(config.orca.automationId, config, paths, home))
    if (!edited.ok) {
      const listed = runOrca(['automations', 'list'])
      const items = asArray(get(listed.json ?? undefined, 'result', 'automations'))
      if (!listed.ok || !items || items.some((a) => get(a, 'id') === config.orca.automationId))
        throw new Error(`orca automations edit に失敗しました: ${edited.stderr}`)
      created = true
    }
  }
  if (created) {
    guard()
    const result = runOrca(createArgs(config, paths, home))
    const id = asString(get(result.json ?? undefined, 'result', 'automation', 'id'))
    if (!result.ok || !id) throw new Error(`orca automations create に失敗しました: ${result.stderr}`)
    guard()
    config.orca.automationId = id
    saveConfig(home, config)
  }
  return `automation=${config.orca.automationId} (${created ? 'created' : 'updated'})`
}
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('init', {
    args: argv,
    options: {
      channel: { type: 'string' },
      repo: { type: 'string' },
      every: { type: 'string' },
      'allow-public': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      now: { type: 'string' },
    },
  })
  const home = intakeHome()
  const paths = homePaths(home)
  const base = loadConfig(home)
  const channel = values.channel ?? base?.channel
  const repo = values.repo ?? base?.repo
  const every = Number(values.every ?? base?.everyMinutes ?? DEFAULT_EVERY_MINUTES)
  if (!channel || !CHANNEL_ID_PATTERN.test(channel) || !repo || !REPO_PATTERN.test(repo) || !isAllowedEvery(every))
    return die('init', '--channel、--repo、--every（60の約数）を確認してください')
  if (base && (channel !== base.channel || repo !== base.repo)) {
    console.error(destinationError)
    process.exitCode = 1
    return
  }
  const config: Config = {
    version: 1,
    channel,
    repo,
    everyMinutes: every,
    ghPath: base?.ghPath ?? '',
    pluginRoot: pluginRoot(),
    slack: base?.slack ?? { teamId: '', teamUrl: '', botUserId: '', botId: '' },
    github: base?.github ?? { login: '' },
    orca: base?.orca ?? { workspaceSelector: null, automationId: null },
    acceptedPermissions: base?.acceptedPermissions ?? null,
  }
  if (values['dry-run']) {
    const quote = (arg: string): string => (/^[\w@%+=:,./#-]+$/.test(arg) ? arg : JSON.stringify(arg))
    for (const args of [
      repoAddArgs(paths.runDir),
      base?.orca.automationId ? editArgs(base.orca.automationId, config, paths, home) : createArgs(config, paths, home),
    ])
      console.log(`orca: ${orcaArgv(args).map(quote).join(' ')}`)
    return
  }
  const token = loadToken(paths.secrets)
  if (!token) {
    console.error('set-token を先に実行してください')
    process.exitCode = 2
    return
  }
  const at = parseNow('init', values.now)
  const now = () => (values.now ? new Date(at) : new Date())
  const deadline = Date.now() + COMMAND_DEADLINE_MS
  ensurePrivateDir(home)
  const db = openDb(paths.db)
  const lease = acquireLease(db, 'admin', null, now(), ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error('処理中です。少し待ってから再実行してください')
    db.close()
    process.exitCode = 1
    return
  }
  const guard = (): void => {
    if (!renewLease(db, lease.token, now(), ADMIN_LEASE_MS)) throw new Error('lease lost')
  }
  try {
    const slack = createSlackClient(token)
    const auth = await authTest(slack, deadline)
    if (!auth.ok) throw new Error(auth.error)
    if (base && auth.info.teamId !== base.slack.teamId) throw new Error(destinationError)
    const latest = await fetchLatest(slack, channel, 1, deadline)
    if (!latest.ok)
      throw new Error(
        latest.error === 'not_in_channel'
          ? `チャンネルにボットを招待してください: /invite @${SLACK_APP_NAME}`
          : latest.error,
      )
    const path = findGhPath()
    if (!path) throw new Error('gh がありません。インストールしてください')
    config.ghPath = path
    const gh = createGh(path)
    if (!(await ghAuthOk(gh, deadline))) throw new Error('gh auth login を実行してください')
    const login = await viewerLogin(gh, deadline)
    if (!login) throw new Error('GitHub のログイン名が取れません')
    if (base && login !== base.github.login) throw new Error(destinationError)
    const repository = await repoInfo(gh, repo, deadline)
    if (!repository.ok) throw new Error(repository.error)
    if (!repository.info.hasIssuesEnabled) throw new Error('リポジトリの Issues を有効にしてください')
    if (repository.info.visibility === 'PUBLIC' && !values['allow-public'])
      throw new Error('公開リポジトリです。内容を確認して --allow-public を付けてください')
    guard()
    const labels = await ensureLabels(
      gh,
      repo,
      LABEL_WRITE_PERMISSIONS.includes(repository.info.viewerPermission),
      deadline,
    )
    if (!labels.ok) throw new Error(`${labels.error} ${labels.missing.join(',')}`)
    guard()
    config.slack = {
      teamId: auth.info.teamId,
      teamUrl: auth.info.teamUrl,
      botUserId: auth.info.userId,
      botId: auth.info.botId,
    }
    config.github = { login }
    saveConfig(home, config)
    if (!getMeta(db, 'accept_after_ts')) {
      const boundary = formatTs(Math.floor(now().getTime() / 1000))
      setMeta(db, 'accept_after_ts', boundary)
      setMeta(db, 'cursor_ts', boundary)
    }
    guard()
    installLauncher(paths)
    const registered = register(home, config, paths, guard)
    console.log(
      `config=${paths.config}\nlauncher=${paths.launcher}\nchannel=${channel}\nrepo=${repo}\nevery=${every}m\nlabels_created=${labels.created.join(',') || 'none'}\naccept_after=${getMeta(db, 'accept_after_ts')}\nworkspace=path:${paths.runDir}\n${registered}\nnext=permissions --show`,
    )
  } catch (error) {
    console.error(maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    releaseLease(db, lease.token)
    db.close()
  }
}
