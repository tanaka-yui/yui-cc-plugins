import { isAllowedEvery } from '../automation.ts'
import { findChannel, joinChannel, normalizeChannelName } from '../channels.ts'
import { parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { getMeta, openDb } from '../db.ts'
import {
  APP_ID_PATTERN,
  CHANNEL_ID_PATTERN,
  COMMAND_DEADLINE_MS,
  DEFAULT_EVERY_MINUTES,
  ERROR_MISSING_SCOPE,
  FORM_FEATURED_MANUAL,
  FORM_KINDS,
  FORM_META_FEATURED,
  FORM_META_TRIGGER_ID,
  formMetaKey,
  LABEL_WRITE_PERMISSIONS,
  META_LABELS_HASH,
  MSG_CONFIG_BROKEN,
  MSG_PUSH_REQUIRED,
  NODE_MIN_VERSION,
  REPO_PATTERN,
  SETUP_STEPS,
  SETUP_TEXT,
  SLACK_APP_NAME,
} from '../defaults.ts'
import { featureSteps, formTitles } from '../form.ts'
import { createGh, findGhPath, ghAuthOk, labelsHash, repoInfo } from '../github.ts'
import { runOrca } from '../orca.ts'
import { homePaths, intakeHome, pluginRoot } from '../paths.ts'
import { inheritedGrants, permissionStatus } from '../permissions.ts'
import { createPrompter } from '../prompt.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
import { createSlackClient } from '../slack-api.ts'
import {
  deployedApp,
  findSlackCli,
  manifestHash,
  readDeployedHash,
  runDeploy,
  runLink,
  saveDeployedHash,
  slackLoggedIn,
  slackProject,
  writeProject,
} from '../slack-cli.ts'

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { Prompter } from '../prompt.ts'
import type { SlackClient } from '../slack-api.ts'

const STDIN = 0
const STDOUT = 1
const STDERR = 2
const EXIT_FAILED = 1
const EXIT_NO_INPUT = 2

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)

// 子のコマンドも同じ端末へ直接書くので、こちらも同期で書いて順序を崩さない
const out = (text: string): void => {
  writeSync(STDOUT, text)
}
const say = (text: string): void => out(`${maskSecrets(text)}\n`)
const fail = (text: string, code = EXIT_FAILED): number => {
  writeSync(STDERR, `${maskSecrets(text)}\n`)
  return code
}
const exhausted = (): number => fail(`\n${SETUP_TEXT.noInput}`, EXIT_NO_INPUT)
const heading = (n: number, title: string, done = false): void =>
  say(`[${n}/${SETUP_STEPS}] ${title}${done ? ` … ${SETUP_TEXT.done}` : ''}`)
const deadline = (): number => Date.now() + COMMAND_DEADLINE_MS

// 既存のコマンドは子プロセスで呼ぶ。標準入力は渡さない（答えはウィザードだけが読む）。管理用のリースは子がそれぞれ取る
const child = (args: string[]): number =>
  spawnSync(process.execPath, [join(pluginRoot(), 'bin', 'slack-issue-intake.ts'), ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  }).status ?? EXIT_FAILED

const nodeIsRecent = (): boolean => {
  const current = process.versions.node.split('.').map(Number)
  for (const [i, min] of NODE_MIN_VERSION.entries()) {
    const part = current[i] ?? 0
    if (part !== min) return part > min
  }
  return true
}

type Ready = { ok: true; slackCli: string; ghPath: string } | { ok: false; code: number }
const precheck = async (): Promise<Ready> => {
  if (!nodeIsRecent())
    return {
      ok: false,
      code: fail(fill(SETUP_TEXT.nodeTooOld, { min: NODE_MIN_VERSION.join('.'), current: process.versions.node })),
    }
  const ghPath = findGhPath()
  if (!ghPath) return { ok: false, code: fail(SETUP_TEXT.noGh) }
  if (!(await ghAuthOk(createGh(ghPath), deadline()))) return { ok: false, code: fail(SETUP_TEXT.ghLoggedOut) }
  const orca = runOrca(['repo', 'list'])
  if (!orca.ok) return { ok: false, code: fail(fill(SETUP_TEXT.noOrca, { error: orca.stderr.trim() || 'exit' })) }
  const slackCli = findSlackCli()
  if (!slackCli) return { ok: false, code: fail(SETUP_TEXT.noSlackCli) }
  if (!slackLoggedIn(slackCli)) return { ok: false, code: fail(SETUP_TEXT.slackLoggedOut) }
  return { ok: true, slackCli, ghPath }
}

type Picked<T> = { ok: true; value: T } | { ok: false; code: number }

// 本物のクライアントは channel_not_found や missing_scope で以後の呼び出しをすべて止める。
// ウィザードは同じ入力で探し直す（findChannel も ID で見つからなければ名前で探す）ので、呼び出しごとに新しく作る
const perCallClient = (token: string): SlackClient => ({
  call: (method, params, until) => createSlackClient(token).call(method, params, until),
  download: (url, maxBytes, until) => createSlackClient(token).download(url, maxBytes, until),
})

// 見つからなければ招待を案内し、Enter のあと同じ名前（既定値）で探し直す。
// 手作業で作ったアプリは名前で探す権限（channels:read）を持たないので、チャンネル ID をそのまま使う（init が読めるか確かめる）
const pickChannel = async (p: Prompter, token: string): Promise<Picked<string>> => {
  const slack = perCallClient(token)
  let previous: string | undefined
  for (;;) {
    const answer = p.ask(SETUP_TEXT.askChannel, previous)
    if (answer === null) return { ok: false, code: exhausted() }
    if (!answer) continue
    previous = answer
    const found = await findChannel(slack, answer, deadline())
    if (!found.ok && found.error === ERROR_MISSING_SCOPE) {
      const id = normalizeChannelName(answer).toUpperCase()
      if (CHANNEL_ID_PATTERN.test(id)) return { ok: true, value: id }
      say(SETUP_TEXT.channelIdOnly)
      previous = undefined
      continue
    }
    if (!found.ok) return { ok: false, code: fail(fill(SETUP_TEXT.channelFailed, { error: found.error })) }
    if (!found.channel) {
      say(fill(SETUP_TEXT.channelNotFound, { app: SLACK_APP_NAME }))
      continue
    }
    const channel = found.channel
    if (!channel.isPrivate && !channel.isMember) {
      const joined = await joinChannel(slack, channel.id, deadline())
      if (!joined.ok)
        return { ok: false, code: fail(fill(SETUP_TEXT.joinFailed, { error: joined.error, app: SLACK_APP_NAME })) }
    }
    say(fill(SETUP_TEXT.channelChosen, { name: channel.name, id: channel.id }))
    return { ok: true, value: channel.id }
  }
}

// 公開リポジトリは、内容が公開されることを示して y/N で確かめる
const confirmPublic = (p: Prompter, visibility: string): Picked<boolean> => {
  if (visibility !== 'PUBLIC') return { ok: true, value: false }
  say(SETUP_TEXT.publicRepo)
  const accepted = p.confirm(SETUP_TEXT.confirmPublic)
  if (accepted === null) return { ok: false, code: exhausted() }
  if (!accepted) return { ok: false, code: fail(SETUP_TEXT.declined) }
  return { ok: true, value: true }
}

// 間隔は今の値（初回は既定値）を既定にして聞く
const pickEvery = (p: Prompter, current: number): Picked<number> => {
  for (;;) {
    const answer = p.ask(SETUP_TEXT.askEvery, String(current))
    if (answer === null) return { ok: false, code: exhausted() }
    const every = Number(answer)
    if (isAllowedEvery(every)) return { ok: true, value: every }
    say(SETUP_TEXT.badEvery)
  }
}

// 既存のアプリ ID を聞く。空なら新しく作る（null）
const pickAppId = (p: Prompter): Picked<string | null> => {
  for (;;) {
    const answer = p.ask(SETUP_TEXT.askAppId)
    if (answer === null) return { ok: false, code: exhausted() }
    if (!answer) return { ok: true, value: null }
    const id = answer.toUpperCase()
    if (APP_ID_PATTERN.test(id)) return { ok: true, value: id }
    say(SETUP_TEXT.badAppId)
  }
}

// 保存済みのリポジトリで init をやり直す。公開リポジトリなら、もう一度確かめる
const reinit = async (p: Prompter, ghPath: string, repo: string, args: string[]): Promise<number> => {
  const info = await repoInfo(createGh(ghPath), repo, deadline())
  if (!info.ok) return fail(fill(SETUP_TEXT.repoFailed, { error: info.error }))
  const visible = confirmPublic(p, info.info.visibility)
  if (!visible.ok) return visible.code
  return child(['init', ...args, ...(visible.value ? ['--allow-public'] : [])])
}

type RepoChoice = { repo: string; every: number; allowPublic: boolean }
// リポジトリは先に gh で確かめ、公開なら承認を取ってから間隔を聞く
const pickRepo = async (p: Prompter, ghPath: string): Promise<Picked<RepoChoice>> => {
  const gh = createGh(ghPath)
  let repo = ''
  let allowPublic = false
  for (;;) {
    const answer = p.ask(SETUP_TEXT.askRepo)
    if (answer === null) return { ok: false, code: exhausted() }
    if (!REPO_PATTERN.test(answer)) {
      say(SETUP_TEXT.badRepo)
      continue
    }
    const info = await repoInfo(gh, answer, deadline())
    if (!info.ok) {
      say(fill(SETUP_TEXT.repoFailed, { error: info.error }))
      continue
    }
    if (!info.info.hasIssuesEnabled) return { ok: false, code: fail(SETUP_TEXT.noIssues) }
    if (!LABEL_WRITE_PERMISSIONS.includes(info.info.viewerPermission))
      return { ok: false, code: fail(MSG_PUSH_REQUIRED) }
    const visible = confirmPublic(p, info.info.visibility)
    if (!visible.ok) return visible
    allowPublic = visible.value
    repo = answer
    break
  }
  const every = pickEvery(p, DEFAULT_EVERY_MINUTES)
  return every.ok ? { ok: true, value: { repo, every: every.value, allowPublic } } : every
}

const readMeta = (dbFile: string, key: string): string | null => {
  if (!existsSync(dbFile)) return null
  const db = openDb(dbFile)
  try {
    return getMeta(db, key)
  } finally {
    db.close()
  }
}
// 3 つのボタンとおすすめがそろい、0.2 の古いボタンが残っていないときだけ済みにする（残っていれば form で片付ける）。
// 画面で注目にしてもらう印（manual）のときは、form が案内済みなので済みにする（人が注目にしたあと make slack-form で片付ける）
const formDone = (dbFile: string): boolean =>
  FORM_KINDS.every((kind) => readMeta(dbFile, formMetaKey(FORM_META_TRIGGER_ID, kind))) &&
  Boolean(readMeta(dbFile, FORM_META_FEATURED)) &&
  (!readMeta(dbFile, FORM_META_TRIGGER_ID) || readMeta(dbFile, FORM_META_FEATURED) === FORM_FEATURED_MANUAL)

// 7・8段目。permissionStatus で飛ばす段を決め、許可と受け継ぐ許可はどちらも内容を見せて y/N で確かめる
const approve = (p: Prompter, home: string, accepted: string | null): number => {
  const status = permissionStatus(home, accepted)
  if (status === 'accepted') {
    // enable は Orca を呼ぶ前に承認を保存するので、承認済みでも有効化が失敗していることがある。
    // 指紋が一致しているので受け継ぐ許可も承認済み。聞き直さずに enable をやり直す（有効なものを有効にしても変わらない）
    heading(7, SETUP_TEXT.stepPermissions, true)
    heading(8, SETUP_TEXT.stepEnable)
    const inherited = inheritedGrants()
    if (!inherited) return fail(SETUP_TEXT.noInherited)
    return child(['enable', ...(inherited.allow.length || inherited.dirs.length ? ['--accept-inherited'] : [])])
  }
  if (status === 'unsafe') {
    heading(7, SETUP_TEXT.stepPermissions)
    const shown = child(['permissions', '--show'])
    if (shown !== 0) return shown
    const ok = p.confirm(SETUP_TEXT.confirmPermissions)
    if (ok === null) return exhausted()
    if (!ok) return fail(SETUP_TEXT.declined)
    const applied = child(['permissions', '--apply'])
    if (applied !== 0) return applied
  } else heading(7, SETUP_TEXT.stepPermissions, true)
  heading(8, SETUP_TEXT.stepEnable)
  const inherited = inheritedGrants()
  if (!inherited) return fail(SETUP_TEXT.noInherited)
  if (inherited.allow.length === 0 && inherited.dirs.length === 0) return child(['enable'])
  say(SETUP_TEXT.inheritedHeader)
  for (const rule of inherited.allow) say(`  inherited-allow ${rule}`)
  for (const dir of inherited.dirs) say(`  inherited-dir ${dir}`)
  const ok = p.confirm(SETUP_TEXT.confirmInherited)
  if (ok === null) return exhausted()
  if (!ok) return fail(SETUP_TEXT.declined)
  return child(['enable', '--accept-inherited'])
}

const wizard = async (): Promise<number> => {
  const p = createPrompter(STDIN, out)
  const home = intakeHome()
  const paths = homePaths(home)

  heading(1, SETUP_TEXT.stepPrecheck)
  const ready = await precheck()
  if (!ready.ok) return ready.code

  // 2: トークン・アプリ・マニフェストの指紋がそろっていれば飛ばす。トークンだけなら手作業のアプリとして進む
  const project = slackProject(home)
  const app = deployedApp(project)
  const hash = manifestHash()
  const existing = loadConfig(home)
  let token = loadToken(paths.secrets)
  const manualApp = Boolean(token) && !app
  // プラグインを更新するとフックのパスが古くなるので、アプリがあれば毎回書き直す
  if (app) writeProject(project)
  if (manualApp) {
    heading(2, SETUP_TEXT.stepApp, true)
    say(SETUP_TEXT.manualApp)
  } else if (token && readDeployedHash(project) === hash) {
    heading(2, SETUP_TEXT.stepApp, true)
  } else {
    heading(2, SETUP_TEXT.stepApp)
    writeProject(project)
    // 同じチームのアプリを更新する（設定があればそのチーム）。どちらも無い初回は、ワークスペースを Slack CLI に選ばせる。
    // 設定のチームを渡すのは、別のワークスペースのトークンで secrets を上書きしないため
    let teamId = app?.teamId || existing?.slack.teamId || null
    // プロジェクトにアプリの記録が無ければ、既存のアプリをつなぐか新しく作るかを聞く（Slack CLI は名前でアプリを探せない）
    if (!app) {
      const appId = pickAppId(p)
      if (!appId.ok) return appId.code
      if (appId.value) {
        say(fill(SETUP_TEXT.linking, { app: appId.value }))
        const linkCode = runLink(ready.slackCli, project, appId.value, teamId)
        const linked = deployedApp(project)
        if (linkCode !== 0 || !linked) return fail(fill(SETUP_TEXT.linkFailed, { code: String(linkCode) }))
        teamId = linked.teamId
      }
    }
    say(SETUP_TEXT.deploying)
    // 指紋はフックが最初に書く。消しておけば、deploy のあとに指紋があることが「フックまで進んだ」印になる
    rmSync(project.manifestHash, { force: true })
    const code = runDeploy(ready.slackCli, project, teamId)
    const hookRan = readDeployedHash(project) === hash
    // フックが保存したトークンを読み直す
    token = loadToken(paths.secrets)
    if (!token && hookRan) return fail(SETUP_TEXT.noToken)
    if (!token || code !== 0) return fail(fill(SETUP_TEXT.deployFailed, { code: String(code) }))
    saveDeployedHash(project, hash)
  }
  if (!token) return fail(SETUP_TEXT.noToken)

  // 3〜5: 設定と automation がそろっていれば、送り先は変えずに今の設定を見せ、間隔だけ聞き直す。
  // 間隔が変われば init で automation を書き換える。
  // init が automation の登録で失敗すると設定だけが残るので、そのときは保存済みの値で init をやり直す
  if (existing?.orca.automationId) {
    heading(3, SETUP_TEXT.stepChannel, true)
    heading(4, SETUP_TEXT.stepRepo)
    say(
      fill(SETUP_TEXT.currentConfig, {
        channel: existing.channel,
        repo: existing.repo,
        every: String(existing.everyMinutes),
      }),
    )
    const every = pickEvery(p, existing.everyMinutes)
    if (!every.ok) return every.code
    // プラグインの更新でラベルが増えたときは、間隔が同じでも init でラベルを作り直す
    const labelsCurrent = readMeta(paths.db, META_LABELS_HASH) === labelsHash()
    if (every.value === existing.everyMinutes && labelsCurrent) heading(5, SETUP_TEXT.stepInit, true)
    else {
      heading(5, SETUP_TEXT.stepInit)
      const code = await reinit(p, ready.ghPath, existing.repo, ['--every', String(every.value)])
      if (code !== 0) return code
    }
  } else if (existing) {
    heading(3, SETUP_TEXT.stepChannel, true)
    heading(4, SETUP_TEXT.stepRepo, true)
    heading(5, SETUP_TEXT.stepInit)
    const code = await reinit(p, ready.ghPath, existing.repo, [])
    if (code !== 0) return code
  } else {
    heading(3, SETUP_TEXT.stepChannel)
    const channel = await pickChannel(p, token)
    if (!channel.ok) return channel.code
    heading(4, SETUP_TEXT.stepRepo)
    const choice = await pickRepo(p, ready.ghPath)
    if (!choice.ok) return choice.code
    const { repo, every, allowPublic } = choice.value
    heading(5, SETUP_TEXT.stepInit)
    const code = child([
      'init',
      '--channel',
      channel.value,
      '--repo',
      repo,
      '--every',
      String(every),
      ...(allowPublic ? ['--allow-public'] : []),
    ])
    if (code !== 0) return code
  }

  // 6: 手作業のアプリには Slack CLI でボタンを作れないので、Workflow Builder を案内する
  if (manualApp) {
    heading(6, SETUP_TEXT.stepForm, true)
    say(SETUP_TEXT.manualForm)
  } else if (formDone(paths.db)) heading(6, SETUP_TEXT.stepForm, true)
  else {
    heading(6, SETUP_TEXT.stepForm)
    const code = child(['form'])
    if (code !== 0) return code
  }

  const config = loadConfig(home)
  if (!config) return fail(MSG_CONFIG_BROKEN)
  const approved = approve(p, home, config.acceptedPermissions)
  if (approved !== 0) return approved
  // ボットでは入力欄にボタンを出せなかったときは、6段目の出力が流れているので、画面での手順をもう一度示す
  if (readMeta(paths.db, FORM_META_FEATURED) === FORM_FEATURED_MANUAL)
    say(fill(SETUP_TEXT.featureByHand, { steps: featureSteps() }))
  say(fill(SETUP_TEXT.finished, { title: formTitles() }))
  return 0
}

// make setup の本体。聞かれたことに答えるだけで、アプリの作成から automation の有効化まで進める
export const run = async (argv: string[]): Promise<void> => {
  parseFlags('setup', { args: argv, options: {} })
  process.exitCode = await wizard()
}
