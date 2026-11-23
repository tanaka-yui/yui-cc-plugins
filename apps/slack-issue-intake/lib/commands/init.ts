import { createArgs, editArgs, isAllowedEvery, repoAddArgs, shellQuote } from '../automation.ts'
import { die, parseFlags, parseNow } from '../cli.ts'
import { DEFAULT_REPORT, loadConfig, readExisting, repoSetting, saveConfig, validBranches } from '../config.ts'
import { getMeta, migrateToRepos, openDb, setMeta } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  adoptAfterKey,
  CHANNEL_ID_PATTERN,
  COMMAND_DEADLINE_MS,
  DEFAULT_EVERY_MINUTES,
  LABEL_WRITE_PERMISSIONS,
  LAUNCHER_FILE_MODE,
  labelsHashKey,
  MSG_CONFIG_BROKEN,
  MSG_CONFIG_CHANGED,
  MSG_DESTINATION_FIXED,
  MSG_PUSH_REQUIRED,
  MSG_THREAD_TO_ACTIVE,
  REPO_PATTERN,
  SLACK_APP_NAME,
} from '../defaults.ts'
import { ensurePrivateDir } from '../fs.ts'
import { createGh, ensureLabels, findGhPath, ghAuthOk, labelsHash, repoInfo, viewerLogin } from '../github.ts'
import { asArray, asString, get } from '../json.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { orcaArgv, runOrca } from '../orca.ts'
import { homePaths, intakeHome, pluginRoot } from '../paths.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
import { authTest, createSlackClient, fetchLatest } from '../slack-api.ts'
import { formatTs } from '../slack-text.ts'
import { noTokenReason } from '../workspace.ts'

import { chmodSync, copyFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config, RepoSetting } from '../config.ts'
import type { HomePaths } from '../paths.ts'

const destinationError = (home: string): string => MSG_DESTINATION_FIXED.replace('{home}', home)
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
      repo: { type: 'string', multiple: true },
      'default-repo': { type: 'string' },
      existing: { type: 'string', multiple: true },
      'hide-form': { type: 'string', multiple: true },
      branches: { type: 'string', multiple: true },
      every: { type: 'string' },
      'allow-public': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      now: { type: 'string' },
    },
  })
  const home = intakeHome()
  const paths = homePaths(home)
  const base = loadConfig(home)
  if (existsSync(paths.config) && !base) {
    console.error(MSG_CONFIG_BROKEN)
    process.exitCode = 1
    return
  }
  const channel = values.channel ?? base?.channel
  const names = (values.repo ?? base?.repos.map((r) => r.name) ?? []).map((name) =>
    base ? (repoSetting(base, name)?.name ?? name) : name,
  )
  if (
    !names.length ||
    names.some((name) => !REPO_PATTERN.test(name)) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    return die('init', '--repo を確認してください')
  if (base && (channel !== base.channel || base.repos.some((r) => !names.includes(r.name)))) {
    console.error(destinationError(home))
    process.exitCode = 1
    return
  }
  const wantedDefault = values['default-repo'] ?? base?.defaultRepo ?? (names.length === 1 ? names[0] : null)
  const defaultRepo = names.find((name) => name.toLowerCase() === wantedDefault?.toLowerCase())
  if (!defaultRepo) return die('init', '--default-repo を一覧から指定してください')
  const repos: RepoSetting[] = names.map((name) => {
    const old = base ? repoSetting(base, name) : null
    return {
      name,
      form: old?.form ?? true,
      existing: old?.existing ?? 'skip',
      ...(old?.branches ? { branches: [...old.branches] } : {}),
    }
  })
  for (const input of values.existing ?? []) {
    const parts = input.split('=')
    const setting = repos.find((r) => r.name.toLowerCase() === parts[0]?.toLowerCase())
    const mode = readExisting(parts[1])
    if (!setting || parts.length !== 2 || mode === null)
      return die('init', '--existing <repo>=<thread|active|skip> を確認してください')
    setting.existing = mode
  }
  for (const name of values['hide-form'] ?? []) {
    const setting = repos.find((r) => r.name.toLowerCase() === name.toLowerCase())
    if (!setting) return die('init', '--hide-form のリポジトリを確認してください')
    setting.form = false
  }
  // 向き先の候補。<repo>=<b1>,<b2> をリポジトリごとに繰り返す
  for (const input of values.branches ?? []) {
    const at = input.indexOf('=')
    const setting = repos.find((r) => r.name.toLowerCase() === input.slice(0, at).toLowerCase())
    const branches = input
      .slice(at + 1)
      .split(',')
      .map((b) => b.trim())
    if (at < 0 || !setting || !validBranches(branches))
      return die('init', '--branches <repo>=<branch>,<branch> を確認してください')
    setting.branches = branches
  }
  const every = Number(values.every ?? base?.everyMinutes ?? DEFAULT_EVERY_MINUTES)
  if (!channel || !CHANNEL_ID_PATTERN.test(channel) || !isAllowedEvery(every))
    return die('init', '--channel、--repo、--every（60の約数）を確認してください')
  const config: Config = {
    version: 1,
    channel,
    repos,
    defaultRepo,
    report: base?.report ?? DEFAULT_REPORT,
    everyMinutes: every,
    ghPath: base?.ghPath ?? '',
    pluginRoot: pluginRoot(),
    slack: base?.slack ?? { teamId: '', teamUrl: '', botUserId: '', botId: '' },
    github: base?.github ?? { login: '' },
    orca: base?.orca ?? { workspaceSelector: null, automationId: null },
    acceptedPermissions: base?.acceptedPermissions ?? null,
    mention: base?.mention ?? { asked: false, groupId: null, handle: null },
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
    console.error(noTokenReason(home))
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
    if (JSON.stringify(loadConfig(home)) !== JSON.stringify(base)) throw new Error(MSG_CONFIG_CHANGED)
    if (base && !migrateToRepos(db, lease.token, base.defaultRepo, now().toISOString())) throw new Error('lease lost')
    const slack = createSlackClient(token)
    const auth = await authTest(slack, deadline)
    if (!auth.ok) throw new Error(auth.error)
    if (base && auth.info.teamId !== base.slack.teamId) throw new Error(destinationError(home))
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
    if (base && login !== base.github.login) throw new Error(destinationError(home))
    for (const repo of names) {
      const repository = await repoInfo(gh, repo, deadline)
      if (!repository.ok) throw new Error(repository.error)
      if (!repository.info.hasIssuesEnabled) throw new Error('リポジトリの Issues を有効にしてください')
      if (repository.info.visibility === 'PUBLIC' && !values['allow-public'])
        throw new Error('公開リポジトリです。内容を確認して --allow-public を付けてください')
      if (!LABEL_WRITE_PERMISSIONS.includes(repository.info.viewerPermission)) throw new Error(MSG_PUSH_REQUIRED)
    }
    const created: string[] = []
    for (const repo of names) {
      guard()
      const labels = await ensureLabels(gh, repo, true, deadline)
      if (!labels.ok) throw new Error(`${labels.error} ${labels.missing.join(',')}`)
      guard()
      setMeta(db, labelsHashKey(repo), labelsHash())
      created.push(...labels.created)
    }
    for (const repo of repos) {
      guard()
      if (repo.existing === 'thread' && !getMeta(db, adoptAfterKey(repo.name)))
        setMeta(db, adoptAfterKey(repo.name), now().toISOString())
    }
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
    for (const repo of repos)
      if (repo.existing === 'active' && base && repoSetting(base, repo.name)?.existing === 'thread')
        console.log(MSG_THREAD_TO_ACTIVE.replace('{repo}', repo.name))
    console.log(
      `config=${paths.config}\nlauncher=${paths.launcher}\nchannel=${channel}\nrepo=${names.join(',')}\ndefault_repo=${defaultRepo}\nevery=${every}m\nlabels_created=${created.join(',') || 'none'}\naccept_after=${getMeta(db, 'accept_after_ts')}\nworkspace=path:${paths.runDir}\n${registered}\nnext=permissions --show`,
    )
  } catch (error) {
    console.error(maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    releaseLease(db, lease.token)
    db.close()
  }
}
