import { isAllowedEvery } from '../automation.ts'
import { findChannel, joinChannel, normalizeChannelName, perCallClient } from '../channels.ts'
import { csv, parseFlags } from '../cli.ts'
import { formRepos, loadConfig } from '../config.ts'
import { getMeta, openDb } from '../db.ts'
import {
  APP_ID_PATTERN,
  CHANNEL_ID_PATTERN,
  COMMAND_DEADLINE_MS,
  DAILY_AT_PATTERN,
  DEFAULT_DAILY_AT,
  DEFAULT_EVERY_MINUTES,
  ERROR_MISSING_SCOPE,
  FORM_FEATURED_MANUAL,
  FORM_KINDS,
  FORM_META_FEATURED,
  FORM_META_TRIGGER_ID,
  formMetaKey,
  LABEL_WRITE_PERMISSIONS,
  labelsHashKey,
  META_REPORT_ASKED,
  MSG_CONFIG_BROKEN,
  MSG_PUSH_REQUIRED,
  NODE_MIN_VERSION,
  REPO_ANSWER_COMMAS,
  REPO_PATTERN,
  SETUP_STEPS,
  SETUP_TEXT,
  SLACK_APP_NAME,
} from '../defaults.ts'
import { channelAppLink, channelLink, featureSteps, formTitles } from '../form.ts'
import { createGh, findGhPath, ghAuthOk, labelsHash, repoInfo } from '../github.ts'
import { runOrca } from '../orca.ts'
import { homePaths, intakeHome, nameOfHome, pluginRoot } from '../paths.ts'
import { inheritedGrants, permissionStatus } from '../permissions.ts'
import { createPrompter } from '../prompt.ts'
import { findReportSources } from '../report.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
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
import { cliCommand, legacyHomeNotice, makeCommand } from '../workspace.ts'

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { RepoSetting } from '../config.ts'
import type { Prompter } from '../prompt.ts'

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
const exhausted = (): number =>
  fail(`\n${fill(SETUP_TEXT.noInput, { setup: makeCommand(intakeHome(), 'setup') })}`, EXIT_NO_INPUT)
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
const confirmPublic = (p: Prompter, visibility: string, repo: string): Picked<boolean> => {
  if (visibility !== 'PUBLIC') return { ok: true, value: false }
  say(fill(SETUP_TEXT.publicRepo, { repo }))
  const accepted = p.confirm(fill(SETUP_TEXT.confirmPublic, { repo }))
  if (accepted === null) return { ok: false, code: exhausted() }
  if (!accepted)
    return { ok: false, code: fail(fill(SETUP_TEXT.declined, { setup: makeCommand(intakeHome(), 'setup') })) }
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

const reinit = async (p: Prompter, ghPath: string, repos: readonly string[], args: string[]): Promise<number> => {
  let allowPublic = false
  for (const repo of repos) {
    const info = await repoInfo(createGh(ghPath), repo, deadline())
    if (!info.ok) return fail(fill(SETUP_TEXT.repoFailed, { repo, error: info.error }))
    const visible = confirmPublic(p, info.info.visibility, repo)
    if (!visible.ok) return visible.code
    allowPublic ||= visible.value
  }
  return child(['init', ...args, ...(allowPublic ? ['--allow-public'] : [])])
}

type RepoChoice = {
  repos: RepoSetting[]
  added: RepoSetting[]
  defaultRepo: string
  every: number
  allowPublic: boolean
}
// リポジトリは先に gh で確かめ、公開なら承認を取ってから間隔を聞く

const pickRepo = async (
  p: Prompter,
  ghPath: string,
  base: readonly RepoSetting[] = [],
  baseDefault?: string,
  everyDefault = DEFAULT_EVERY_MINUTES,
): Promise<Picked<RepoChoice>> => {
  const gh = createGh(ghPath)
  const repos = base.map((r) => ({ ...r }))
  const added: RepoSetting[] = []
  let allowPublic = false
  for (;;) {
    const answer = p.ask(
      base.length ? SETUP_TEXT.askAddRepo : repos.length ? SETUP_TEXT.askMoreRepo : SETUP_TEXT.askRepo,
    )
    if (answer === null) return { ok: false, code: exhausted() }
    const names = csv(answer.replace(REPO_ANSWER_COMMAS, ','))
    if (!names.length) {
      if (repos.length) break
      say(SETUP_TEXT.needRepo)
      continue
    }
    const seen = new Set(repos.map((r) => r.name.toLowerCase()))
    for (const name of names) {
      if (!REPO_PATTERN.test(name)) {
        say(fill(SETUP_TEXT.badRepo, { repo: name }))
        continue
      }
      const key = name.toLowerCase()
      if (seen.has(key)) {
        say(fill(SETUP_TEXT.duplicateRepo, { repo: name }))
        continue
      }
      seen.add(key)
      const info = await repoInfo(gh, name, deadline())
      if (!info.ok) {
        say(fill(SETUP_TEXT.repoSkipped, { repo: name, error: info.error.trim() }))
        continue
      }
      if (!info.info.hasIssuesEnabled)
        return { ok: false, code: fail(fill(SETUP_TEXT.repoStopped, { repo: name, reason: SETUP_TEXT.noIssues })) }
      if (!LABEL_WRITE_PERMISSIONS.includes(info.info.viewerPermission))
        return { ok: false, code: fail(fill(SETUP_TEXT.repoStopped, { repo: name, reason: MSG_PUSH_REQUIRED })) }
      if (!base.length) {
        const visible = confirmPublic(p, info.info.visibility, name)
        if (!visible.ok) return visible
        allowPublic ||= visible.value
      }
      const setting: RepoSetting = { name, form: true, existing: 'skip' }
      repos.push(setting)
      added.push(setting)
    }
  }
  let defaultRepo = baseDefault ?? repos[0]?.name ?? ''
  if (!base.length && repos.length > 1)
    for (;;) {
      const answer = p.ask(SETUP_TEXT.askDefaultRepo, defaultRepo)
      if (answer === null) return { ok: false, code: exhausted() }
      const found = repos.find((r) => r.name.toLowerCase() === answer.toLowerCase())
      if (found) {
        defaultRepo = found.name
        break
      }
      say(SETUP_TEXT.badDefaultRepo)
    }
  for (const repo of added) {
    if (repo.name !== defaultRepo)
      for (;;) {
        const answer = p.ask(fill(SETUP_TEXT.askShowInForm, { repo: repo.name }), 'y')
        if (answer === null) return { ok: false, code: exhausted() }
        if (['y', 'yes', 'n', 'no'].includes(answer.toLowerCase())) {
          repo.form = ['y', 'yes'].includes(answer.toLowerCase())
          break
        }
        say(fill(SETUP_TEXT.badChoice, { options: 'y / n' }))
      }
    for (;;) {
      const answer = p.ask(fill(SETUP_TEXT.askExisting, { repo: repo.name }), 'n')
      if (answer === null) return { ok: false, code: exhausted() }
      const choice = answer.toLowerCase()
      if (['y', 'yes', 'thread', 'n', 'no', 'skip'].includes(choice)) {
        repo.existing = ['y', 'yes', 'thread'].includes(choice) ? 'thread' : 'skip'
        break
      }
      say(fill(SETUP_TEXT.badChoice, { options: 'y / n' }))
    }
  }
  const every = pickEvery(p, everyDefault)
  return every.ok ? { ok: true, value: { repos, added, defaultRepo, every: every.value, allowPublic } } : every
}
const repoArgs = (choice: RepoChoice): string[] => [
  ...choice.repos.flatMap((r) => ['--repo', r.name]),
  ...(choice.repos.length > 1 ? ['--default-repo', choice.defaultRepo] : []),
  ...choice.added.flatMap((r) => [
    '--existing',
    `${r.name}=${r.existing}`,
    ...(!r.form ? ['--hide-form', r.name] : []),
  ]),
  '--every',
  String(choice.every),
]

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

// 8・9段目。permissionStatus で飛ばす段を決め、許可と受け継ぐ許可はどちらも内容を見せて y/N で確かめる
const approve = (p: Prompter, home: string, accepted: string | null): number => {
  const status = permissionStatus(home, accepted)
  if (status === 'accepted') {
    // enable は Orca を呼ぶ前に承認を保存するので、承認済みでも有効化が失敗していることがある。
    // 指紋が一致しているので受け継ぐ許可も承認済み。聞き直さずに enable をやり直す（有効なものを有効にしても変わらない）
    heading(9, SETUP_TEXT.stepPermissions, true)
    heading(10, SETUP_TEXT.stepEnable)
    const inherited = inheritedGrants()
    if (!inherited) return fail(SETUP_TEXT.noInherited)
    return child(['enable', ...(inherited.allow.length || inherited.dirs.length ? ['--accept-inherited'] : [])])
  }
  if (status === 'unsafe') {
    heading(9, SETUP_TEXT.stepPermissions)
    const shown = child(['permissions', '--show'])
    if (shown !== 0) return shown
    const ok = p.confirm(SETUP_TEXT.confirmPermissions)
    if (ok === null) return exhausted()
    if (!ok) return fail(fill(SETUP_TEXT.declined, { setup: makeCommand(intakeHome(), 'setup') }))
    const applied = child(['permissions', '--apply'])
    if (applied !== 0) return applied
  } else heading(9, SETUP_TEXT.stepPermissions, true)
  heading(10, SETUP_TEXT.stepEnable)
  const inherited = inheritedGrants()
  if (!inherited) return fail(SETUP_TEXT.noInherited)
  if (inherited.allow.length === 0 && inherited.dirs.length === 0) return child(['enable'])
  say(SETUP_TEXT.inheritedHeader)
  for (const rule of inherited.allow) say(`  inherited-allow ${rule}`)
  for (const dir of inherited.dirs) say(`  inherited-dir ${dir}`)
  const ok = p.confirm(SETUP_TEXT.confirmInherited)
  if (ok === null) return exhausted()
  if (!ok) return fail(fill(SETUP_TEXT.declined, { setup: makeCommand(intakeHome(), 'setup') }))
  return child(['enable', '--accept-inherited'])
}

const wizard = async (): Promise<number> => {
  const p = createPrompter(STDIN, out)
  const home = intakeHome()
  const paths = homePaths(home)
  const name = nameOfHome(home)
  if (name !== null) say(fill(SETUP_TEXT.namedHome, { name, home }))
  const legacy = legacyHomeNotice()
  if (legacy !== null) say(legacy)

  heading(1, SETUP_TEXT.stepPrecheck)
  const ready = await precheck()
  if (!ready.ok) return ready.code

  // 2: トークン・アプリ・マニフェストの指紋がそろっていれば飛ばす。トークンだけなら手作業のアプリとして進む
  const project = slackProject(home)
  const app = deployedApp(project)
  const existing = loadConfig(home)
  const hash = manifestHash(existing ? formRepos(existing) : [])
  let token = loadToken(paths.secrets)
  const manualApp = Boolean(token) && !app
  const deploy = (expected: string, teamId: string | null): number => {
    writeProject(project)
    say(SETUP_TEXT.deploying)
    rmSync(project.manifestHash, { force: true })
    const code = runDeploy(ready.slackCli, project, teamId)
    const hookRan = readDeployedHash(project) === expected
    token = loadToken(paths.secrets)
    if (!token && hookRan)
      return fail(
        fill(SETUP_TEXT.noToken, {
          setup: makeCommand(intakeHome(), 'setup'),
          setToken: cliCommand(intakeHome(), 'set-token'),
        }),
      )
    if (!hookRan || !token || code !== 0) return fail(fill(SETUP_TEXT.deployFailed, { code: String(code) }))
    saveDeployedHash(project, expected)
    return 0
  }
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
    const deployed = deploy(hash, teamId)
    if (deployed !== 0) return deployed
  }
  if (!token)
    return fail(
      fill(SETUP_TEXT.noToken, {
        setup: makeCommand(intakeHome(), 'setup'),
        setToken: cliCommand(intakeHome(), 'set-token'),
      }),
    )

  // 3〜5: 設定と automation がそろっていれば、送り先は変えずに今の設定を見せ、間隔だけ聞き直す。
  // 間隔が変われば init で automation を書き換える。
  // init が automation の登録で失敗すると設定だけが残るので、そのときは保存済みの値で init をやり直す
  if (existing?.orca.automationId) {
    heading(3, SETUP_TEXT.stepChannel, true)
    heading(4, SETUP_TEXT.stepRepo)
    say(
      fill(SETUP_TEXT.currentConfig, {
        channel: existing.channel,
        repos: existing.repos.map((r) => r.name).join('、'),
        default: existing.defaultRepo,
        every: String(existing.everyMinutes),
      }),
    )
    const choice = await pickRepo(p, ready.ghPath, existing.repos, existing.defaultRepo, existing.everyMinutes)
    if (!choice.ok) return choice.code
    // プラグインの更新でラベルが増えたときは、間隔が同じでも init でラベルを作り直す
    const labelsCurrent = existing.repos.every((r) => readMeta(paths.db, labelsHashKey(r.name)) === labelsHash())
    if (choice.value.added.length === 0 && choice.value.every === existing.everyMinutes && labelsCurrent)
      heading(5, SETUP_TEXT.stepInit, true)
    else {
      heading(5, SETUP_TEXT.stepInit)
      const code = await reinit(
        p,
        ready.ghPath,
        choice.value.repos.map((r) => r.name),
        repoArgs(choice.value),
      )
      if (code !== 0) return code
    }
  } else if (existing) {
    heading(3, SETUP_TEXT.stepChannel, true)
    heading(4, SETUP_TEXT.stepRepo, true)
    heading(5, SETUP_TEXT.stepInit)
    const code = await reinit(
      p,
      ready.ghPath,
      existing.repos.map((r) => r.name),
      [],
    )
    if (code !== 0) return code
  } else {
    heading(3, SETUP_TEXT.stepChannel)
    const channel = await pickChannel(p, token)
    if (!channel.ok) return channel.code
    heading(4, SETUP_TEXT.stepRepo)
    const choice = await pickRepo(p, ready.ghPath)
    if (!choice.ok) return choice.code

    heading(5, SETUP_TEXT.stepInit)
    const code = child([
      'init',
      '--channel',
      channel.value,
      ...repoArgs(choice.value),
      ...(choice.value.allowPublic ? ['--allow-public'] : []),
    ])
    if (code !== 0) return code
  }

  // 6: ステータスの通知でメンションするグループ。一度答えたら（空でも）聞き直さない。変えるときは mention を直接実行する
  const configured = loadConfig(home)
  if (!configured) return fail(MSG_CONFIG_BROKEN)
  if (configured.mention.asked) heading(6, SETUP_TEXT.stepMention, true)
  else {
    heading(6, SETUP_TEXT.stepMention)
    // 見つからない・権限が無いときは、子が理由を示すので聞き直す
    for (;;) {
      const answer = p.ask(SETUP_TEXT.askMention)
      if (answer === null) return exhausted()
      if (child(answer ? ['mention', '--group', answer] : ['mention', '--none']) === 0) break
    }
  }

  const reportConfig = loadConfig(home)
  if (!reportConfig) return fail(MSG_CONFIG_BROKEN)
  if (reportConfig.report.source !== null || readMeta(paths.db, META_REPORT_ASKED))
    heading(7, SETUP_TEXT.stepReport, true)
  else {
    heading(7, SETUP_TEXT.stepReport)
    const sources = findReportSources()
    if (!sources.length) say(fill(SETUP_TEXT.reportNotFound, { report: cliCommand(home, 'report --source <path>') }))
    else {
      say(SETUP_TEXT.reportFound)
      for (const [i, source] of sources.entries()) say(`  ${i + 1}. ${source}`)
      for (;;) {
        const answer = p.ask(SETUP_TEXT.askReportSource, '1')
        if (answer === null) return exhausted()
        const n = Number(answer)
        if (!Number.isInteger(n) || n < 0 || n > sources.length) continue
        if (n === 0) {
          if (child(['report', '--source', 'none']) === 0) break
          continue
        }
        const channel = p.ask(SETUP_TEXT.askReportChannel)
        if (channel === null) return exhausted()
        let dailyAt: string
        for (;;) {
          const answer = p.ask(SETUP_TEXT.askDailyAt, DEFAULT_DAILY_AT)
          if (answer === null) return exhausted()
          if (DAILY_AT_PATTERN.test(answer)) {
            dailyAt = answer
            break
          }
          say(SETUP_TEXT.badDailyAt)
        }
        if (
          child([
            'report',
            '--source',
            sources[n - 1] ?? '',
            '--channel',
            channel || 'default',
            '--daily-at',
            dailyAt,
          ]) === 0
        )
          break
      }
    }
  }
  const formConfig = loadConfig(home)
  if (!formConfig) return fail(MSG_CONFIG_BROKEN)
  if (!manualApp && readDeployedHash(project) !== manifestHash(formRepos(formConfig))) {
    const code = deploy(manifestHash(formRepos(formConfig)), deployedApp(project)?.teamId || formConfig.slack.teamId)
    if (code !== 0) return code
  }
  // 8: 手作業のアプリには Slack CLI でボタンを作れないので、Workflow Builder を案内する
  if (manualApp) {
    heading(8, SETUP_TEXT.stepForm, true)
    say(SETUP_TEXT.manualForm)
  } else if (formDone(paths.db)) heading(8, SETUP_TEXT.stepForm, true)
  else {
    heading(8, SETUP_TEXT.stepForm)
    const code = child(['form'])
    if (code !== 0) return code
  }

  const config = loadConfig(home)
  if (!config) return fail(MSG_CONFIG_BROKEN)
  const approved = approve(p, home, config.acceptedPermissions)
  if (approved !== 0) return approved
  // ボットでは入力欄にボタンを出せなかったときは、7段目の出力が流れているので、画面での手順をもう一度示す
  if (readMeta(paths.db, FORM_META_FEATURED) === FORM_FEATURED_MANUAL)
    say(fill(SETUP_TEXT.featureByHand, { steps: featureSteps(config.channel, config.slack.teamId || null) }))
  say(fill(SETUP_TEXT.finished, { title: formTitles(), inspect: cliCommand(home, 'inspect --raw') }))
  say(fill(SETUP_TEXT.finishedLink, { link: channelLink(config.channel, config.slack.teamId || null) }))
  if (config.slack.teamId)
    say(fill(SETUP_TEXT.finishedAppLink, { link: channelAppLink(config.channel, config.slack.teamId) }))
  return 0
}

// make setup の本体。聞かれたことに答えるだけで、アプリの作成から automation の有効化まで進める
export const run = async (argv: string[]): Promise<void> => {
  parseFlags('setup', { args: argv, options: {} })
  process.exitCode = await wizard()
}
