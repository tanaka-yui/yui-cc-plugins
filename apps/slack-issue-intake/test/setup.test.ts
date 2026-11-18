import { loadConfig } from '../lib/config.ts'
import { openDb, setMeta } from '../lib/db.ts'
import { FORM_META_TRIGGER_ID, labelsHashKey, SETUP_STEPS } from '../lib/defaults.ts'
import { asObject, get } from '../lib/json.ts'
import { homePaths } from '../lib/paths.ts'
import { permissionStatus } from '../lib/permissions.ts'
import { loadToken, saveToken } from '../lib/secrets.ts'
import { slackProject } from '../lib/slack-cli.ts'
import { BOT_ID, BOT_USER, TEAM_ID, TEAM_URL } from './fixtures/slack-messages.ts'
import {
  fakeGh,
  fakeOrca,
  fakeSlackCli,
  ghCalls,
  orcaCalls,
  runCli,
  runCliAsync,
  runLauncherAsync,
  slackCliCalls,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const TARGET = { id: 'C0TARGET01', name: 'issue-intake', is_private: false, is_member: false }
const OTHER = { id: 'C0OTHER001', name: 'general', is_private: false, is_member: true }
const SECRET = { id: 'G0SECRET01', name: 'secret', is_private: true, is_member: true }
// 1行目は既存のアプリ ID（空なら新しく作る）
// 1行目は既存のアプリ ID、最後の空行の手前はメンションするグループ（空ならメンションしない）
const FULL_INPUT = '\n#Issue-Intake\nacme/app\n\n\n\n\ny\n'

const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  override: (r: SlackRequest) => SlackReply | null = () => null,
) => {
  const home = tempHome()
  const claudeHome = tempHome()
  const gh = fakeGh(tempHome())
  const orca = fakeOrca(tempHome())
  const cli = fakeSlackCli(tempHome())
  let scans = 0
  const server = await startSlack((r: SlackRequest): SlackReply => {
    const replaced = override(r)
    if (replaced) return replaced
    if (r.method === 'auth.test')
      return { json: { ok: true, user_id: BOT_USER, bot_id: BOT_ID, team_id: TEAM_ID, url: TEAM_URL, team: 'acme' } }
    if (r.method === 'conversations.list') {
      // 名前で探し直すたびに 1 ページ目から読む。目的のチャンネルは 2 ページ目にある
      if (!r.params.cursor) {
        scans += 1
        return { json: { ok: true, channels: [OTHER], response_metadata: { next_cursor: 'p2' } } }
      }
      const channels = scans >= 2 ? [TARGET, SECRET] : [TARGET]
      return { json: { ok: true, channels, response_metadata: { next_cursor: '' } } }
    }
    return { json: { ok: true, messages: [] } }
  })
  t.after(() => server.close())
  const env: Record<string, string> = {
    HOME: tempHome(),
    SLACK_ISSUE_INTAKE_HOME: home,
    SLACK_ISSUE_INTAKE_CLAUDE_HOME: claudeHome,
    SLACK_ISSUE_INTAKE_API_BASE: server.url,
    FAKE_SLACK_CLI_TEAM: TEAM_ID,
    ...gh.env,
    ...orca.env,
    ...cli.env,
    PATH: `${dirname(gh.ghPath)}:${process.env.PATH}`,
  }
  const calls = (method: string): SlackRequest[] => server.requests.filter((r) => r.method === method)
  const cliCalls = (sub: string) => slackCliCalls(cli.log).filter((c) => c.argv.join(' ').startsWith(sub))
  const status = () => {
    const previous = process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
    process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = claudeHome
    try {
      return permissionStatus(home, loadConfig(home)?.acceptedPermissions ?? null)
    } finally {
      if (previous === undefined) delete process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
      else process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = previous
    }
  }
  return {
    home,
    claudeHome,
    gh,
    orca,
    cli,
    calls,
    cliCalls,
    status,
    launch: (launcher: string, args: string[], extra: Record<string, string> = {}) =>
      runLauncherAsync(launcher, args, { ...env, ...extra }),
    setup: (input: string, extra: Record<string, string> = {}, args: string[] = ['setup']) =>
      runCliAsync(args, { ...env, ...extra }, input),
  }
}

test('SU1 質問に答えるだけで、アプリ・トークン・設定・ボタン・承認・有効化までそろう', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { SLACK_BOT_TOKEN: 'xoxb-from-shell' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\[1\/10\]/)
  assert.ok(r.stdout.includes('起票のチャンネル: https://slack.com/app_redirect?channel=C0TARGET01&team=T0ACME001'))
  assert.ok(r.stdout.includes('Slack のアプリで開くなら: slack://channel?team=T0ACME001&id=C0TARGET01'))
  assert.ok(r.stdout.includes('--name <名前> inspect --raw'))
  assert.match(r.stdout, /\[10\/10\]/)
  const deploys = f.cliCalls('deploy')
  assert.equal(deploys.length, 1)
  assert.equal(deploys[0]?.hadBotToken, false)
  assert.ok(!deploys[0]?.argv.includes('--team'))
  assert.equal(loadToken(homePaths(f.home).secrets), 'xoxb-fake-deployed')
  assert.ok(!`${r.stdout}${r.stderr}`.includes('xoxb-fake-deployed'))
  assert.ok(!`${r.stdout}${r.stderr}`.includes('xoxb-from-shell'))
  assert.deepEqual(
    f.calls('conversations.join').map((c) => c.params.channel),
    ['C0TARGET01'],
  )
  const config = loadConfig(f.home)
  assert.equal(config?.channel, 'C0TARGET01')
  assert.equal(config?.defaultRepo, 'acme/app')
  assert.equal(config?.everyMinutes, 5)
  const created = f.cliCalls('trigger create')
  assert.equal(created.length, 3)
  for (const c of created) assert.equal(get(asObject(get(c.triggerDef, 'inputs')), 'channel_id', 'value'), 'C0TARGET01')
  assert.deepEqual(f.calls('workflows.featured.add')[0]?.params, {
    channel_id: 'C0TARGET01',
    trigger_ids: 'Ft0FAKEBUG,Ft0FAKEREQ,Ft0FAKEFEA',
  })
  assert.match(r.stdout, /ボタン（「バグを報告」「要望を送る」「新機能を提案」）のどれか/)
  assert.equal(f.calls('bookmarks.add').length, 0)
  assert.notEqual(config?.acceptedPermissions, null)
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
})

test('SU2 もう一度実行すると、済んだ段を飛ばしてアプリ・ボタンを重ねない', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const r = await f.setup('\n\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /済み/)
  assert.equal(f.cliCalls('deploy').length, 1)
  assert.equal(f.cliCalls('trigger create').length, 3)
  assert.equal(f.calls('workflows.featured.add').length, 1)
})

test('SU23 0.2 の古いボタンが残っていれば、6 段目で form をもう一度走らせて片付ける', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const db = openDb(homePaths(f.home).db)
  setMeta(db, FORM_META_TRIGGER_ID, 'Ft0FAKEFOR')
  db.close()
  const r = await f.setup('\n\n')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.cliCalls('trigger create').length, 3)
  assert.deepEqual(
    f.cliCalls('trigger delete').map((c) => c.argv[3]),
    ['Ft0FAKEFOR'],
  )
})

test('SU3 マニフェストが変わっていれば、同じチームを指定して deploy し直す', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  writeFileSync(slackProject(f.home).manifestHash, 'old\n')
  const r = await f.setup('\n\n')
  assert.equal(r.code, 0, r.stderr)
  const deploys = f.cliCalls('deploy')
  assert.equal(deploys.length, 2)
  const argv = deploys[1]?.argv ?? []
  assert.equal(argv[argv.indexOf('--team') + 1], TEAM_ID)
})

test('SU4 フックがトークンを受け取れなければ、set-token の手順を示して止まる', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { FAKE_SLACK_CLI_NO_TOKEN: '1' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /set-token/)
  assert.ok(r.stderr.includes('node bin/slack-issue-intake.ts --name <名前> set-token'))
  assert.ok(r.stderr.includes('make setup NAME=<名前>'))
  assert.equal(loadConfig(f.home), null)
})

test('SU5 Slack CLI が無い・未ログインなら、何も作らずに止まる', async (t) => {
  const f = await fixture(t)
  const gh = fakeGh(tempHome())
  const missing = await f.setup(FULL_INPUT, {
    HOME: tempHome(),
    PATH: dirname(gh.ghPath),
    SLACK_ISSUE_INTAKE_SLACK_CLI: '',
  })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /Slack CLI/)
  const loggedOut = await f.setup(FULL_INPUT, { FAKE_SLACK_CLI_LOGGED_OUT: '1' })
  assert.equal(loggedOut.code, 1)
  assert.match(loggedOut.stderr, /slack login/)
  assert.equal(f.cliCalls('deploy').length, 0)
  assert.equal(loadConfig(f.home), null)
})

test('SU6 見つからないチャンネルはボットの招待を待ち、Enter のあとに探し直す', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('\nsecret\n\nacme/app\n\n\n\n\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\/invite @Issue Intake/)
  assert.equal(f.calls('conversations.join').length, 0)
  assert.equal(loadConfig(f.home)?.channel, 'G0SECRET01')
})

test('SU7 承認しなければ何も変えずに止まり、次の実行で承認から再開する', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('\n#issue-intake\nacme/app\n\n\n\n\nn\n')
  assert.equal(r.code, 1)
  assert.equal(f.status(), 'unsafe')
  assert.ok(!orcaCalls(f.orca.log).some((c) => c.includes('--enabled')))
  const again = await f.setup('\n\ny\n')
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.status(), 'accepted')
  assert.equal(f.cliCalls('deploy').length, 1)
})

test('SU8 入力が途中で尽きたら、ターミナルで実行するよう示して止まる', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /ターミナルで make setup/)
})

test('SU9 公開リポジトリは内容が公開されると示して確かめ、承認したら --allow-public で init する', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('\n#issue-intake\nacme/app\ny\n\n\n\n\ny\n', { FAKE_GH_VISIBILITY: 'PUBLIC' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /公開/)
  assert.ok(r.stdout.includes('acme/app は公開リポジトリです'))
  assert.equal(loadConfig(f.home)?.defaultRepo, 'acme/app')
})

test('SU10 init が automation の登録で失敗したら、次の実行で init からやり直す', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { FAKE_ORCA_CREATE: 'fail' })
  assert.equal(r.code, 1)
  assert.equal(loadConfig(f.home)?.orca.automationId, null)
  const again = await f.setup('\ny\n')
  assert.equal(again.code, 0, again.stderr)
  assert.equal(loadConfig(f.home)?.orca.automationId, 'auto-1')
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
})

test('SU11 受け継ぐ許可は一覧を見せて確かめ、承認しなければ有効にしない', async (t) => {
  const f = await fixture(t)
  mkdirSync(f.claudeHome, { recursive: true })
  writeFileSync(join(f.claudeHome, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }))
  const r = await f.setup(`${FULL_INPUT}n\n`)
  assert.equal(r.code, 1)
  assert.match(r.stdout, /inherited-allow Bash\(git status\)/)
  assert.ok(!orcaCalls(f.orca.log).some((c) => c.includes('--enabled')))
  const again = await f.setup('\n\ny\n')
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
})

test('SU12 手作業のアプリ（名前で探す権限なし）は deploy せず、チャンネル ID で進めてフォームは手順を示す', async (t) => {
  const f = await fixture(t, (r): SlackReply | null =>
    r.method === 'conversations.list' || r.method === 'conversations.info'
      ? { json: { ok: false, error: 'missing_scope' } }
      : null,
  )
  saveToken(homePaths(f.home).secrets, 'xoxb-manual-token')
  const r = await f.setup('issue-intake\nC0TARGET01\nacme/app\n\n\n\n\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /チャンネル ID/)
  assert.match(r.stdout, /Workflow Builder/)
  assert.equal(f.cliCalls('deploy').length, 0)
  assert.equal(f.cliCalls('trigger create').length, 0)
  assert.equal(loadConfig(f.home)?.channel, 'C0TARGET01')
  assert.equal(loadToken(homePaths(f.home).secrets), 'xoxb-manual-token')
})

test('SU13 ID の形に見える名前は、ID で見つからなくても名前で探し直す（本物のクライアントは致命エラーで止まる）', async (t) => {
  const f = await fixture(t, (r): SlackReply | null =>
    r.method === 'conversations.info'
      ? { json: { ok: false, error: 'channel_not_found' } }
      : r.method === 'conversations.list'
        ? {
            json: {
              ok: true,
              channels: [{ id: 'C0CUSTOM01', name: 'customers', is_private: false, is_member: true }],
              response_metadata: { next_cursor: '' },
            },
          }
        : null,
  )
  const r = await f.setup('\ncustomers\nacme/app\n\n\n\n\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(loadConfig(f.home)?.channel, 'C0CUSTOM01')
})

test('SU14 フックがトークンを受け取れず set-token で登録したあとは、deploy し直さずに続きから進む', async (t) => {
  const f = await fixture(t)
  const noToken = { FAKE_SLACK_CLI_NO_TOKEN: '1' }
  assert.equal((await f.setup(FULL_INPUT, noToken)).code, 1)
  saveToken(homePaths(f.home).secrets, 'xoxb-set-by-hand')
  const r = await f.setup(FULL_INPUT, noToken)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.cliCalls('deploy').length, 1)
  assert.equal(loadConfig(f.home)?.channel, 'C0TARGET01')
})

test('SU15 知らない引数は使用法の誤りとして exit 2 で止まり、何も始めない', async (t) => {
  const f = await fixture(t)
  const r = await runCliAsync(['setup', '--foo'], { SLACK_ISSUE_INTAKE_HOME: f.home }, '')
  assert.equal(r.code, 2)
  assert.doesNotMatch(r.stdout, /\[1\/10\]/)
})

test('SU16 有効化が Orca で失敗しても、次の実行で聞き直さずに有効化をやり直す', async (t) => {
  const f = await fixture(t)
  mkdirSync(f.claudeHome, { recursive: true })
  writeFileSync(join(f.claudeHome, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }))
  const r = await f.setup(`${FULL_INPUT}y\n`, { FAKE_ORCA_EDIT: 'fail' })
  assert.equal(r.code, 1)
  assert.equal(f.status(), 'accepted')
  const again = await f.setup('\n\n')
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
})

test('SU17 フックより前に deploy が失敗したら、set-token ではなく deploy の失敗を示す', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { FAKE_SLACK_CLI_DEPLOY_FAIL: '1' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /slack deploy に失敗しました/)
  assert.doesNotMatch(r.stderr, /set-token/)
})

test('SU18 設定があってトークンもアプリも無ければ、設定のチームを指定して deploy する', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  rmSync(homePaths(f.home).secrets)
  rmSync(slackProject(f.home).dir, { recursive: true })
  const r = await f.setup('\n\n\n')
  assert.equal(r.code, 0, r.stderr)
  const argv = f.cliCalls('deploy')[1]?.argv ?? []
  assert.equal(argv[argv.indexOf('--team') + 1], TEAM_ID)
})

test('SU19 既存のアプリ ID を入力すると、slack app link でつないでから同じアプリを deploy する', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('bad-id\na0exist0001\n#issue-intake\nacme/app\n\n\n\n\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /A で始まる/)
  const [linked] = f.cliCalls('app link')
  assert.deepEqual(linked?.argv.slice(0, 6), ['app', 'link', '--app', 'A0EXIST0001', '--environment', 'deployed'])
  const deploys = f.cliCalls('deploy')
  assert.equal(deploys.length, 1)
  const argv = deploys[0]?.argv ?? []
  assert.equal(argv[argv.indexOf('--team') + 1], TEAM_ID)
  const apps = JSON.parse(readFileSync(slackProject(f.home).apps, 'utf8'))
  assert.deepEqual(Object.keys(apps.apps), ['A0EXIST0001'])
})

test('SU20 slack app link が失敗したら、deploy せずに止まる', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('A0EXIST0001\n', { FAKE_SLACK_CLI_LINK_FAIL: '1' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /slack app link に失敗しました/)
  assert.equal(f.cliCalls('deploy').length, 0)
})

test('SU21 設定があれば今の設定を見せて間隔だけ聞き直し、変えたら init で automation を書き換える', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const before = orcaCalls(f.orca.log).length
  const kept = await f.setup('\n\n')
  assert.equal(kept.code, 0, kept.stderr)
  assert.match(kept.stdout, /チャンネル C0TARGET01、リポジトリ acme\/app（既定の起票先 acme\/app）、確認の間隔 5 分/)
  assert.ok(
    !orcaCalls(f.orca.log)
      .slice(before)
      .some((c) => c.includes('--trigger')),
  )
  const changed = await f.setup('\n10\n')
  assert.equal(changed.code, 0, changed.stderr)
  assert.equal(loadConfig(f.home)?.everyMinutes, 10)
  const edit = orcaCalls(f.orca.log).find((c) => c[1] === 'edit' && c.includes('--trigger'))
  assert.equal(edit?.[edit.indexOf('--trigger') + 1], '*/10 * * * *')
  assert.equal(loadConfig(f.home)?.channel, 'C0TARGET01')
})

test('SU24 labels_hash が今と違えば、間隔が同じでも 5 段で init をやり直す', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const db = openDb(homePaths(f.home).db)
  setMeta(db, labelsHashKey('acme/app'), 'old')
  db.close()
  const before = ghCalls(f.gh.log).length
  const r = await f.setup('\n\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`\\[5/${SETUP_STEPS}\\] [^\\n]*init[^\\n…]*\\n`))
  assert.ok(
    ghCalls(f.gh.log)
      .slice(before)
      .some((c) => c.argv.slice(0, 2).join(' ') === 'label list'),
  )
  const again = await f.setup('\n\n')
  assert.match(again.stdout, new RegExp(`\\[5/${SETUP_STEPS}\\] [^\\n]*済み`))
})

test('SU25 6段: mention.asked が false なら聞き、空なら --none、名前なら --group を呼ぶ。asked なら済み', async (t) => {
  const f = await fixture(t, (r): SlackReply | null =>
    r.method === 'usergroups.list'
      ? { json: { ok: true, usergroups: [{ id: 'S0DEV0001', handle: 'dev-member', name: 'Dev Member' }] } }
      : null,
  )
  // 見つからない名前のあとは聞き直し、2 回目の名前で保存する
  const r = await f.setup('\n#Issue-Intake\nacme/app\n\n\n\nnobody\n@dev-member\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\[6\/10\] 通知でメンションするグループ/)
  assert.deepEqual(loadConfig(f.home)?.mention, { asked: true, groupId: 'S0DEV0001', handle: 'dev-member' })
  assert.equal(f.calls('usergroups.list').length, 2)
  const again = await f.setup('\n\n')
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /\[6\/10\] [^\n]*済み/)
  assert.equal(f.calls('usergroups.list').length, 2)
  const empty = await fixture(t)
  assert.equal((await empty.setup(FULL_INPUT)).code, 0)
  assert.deepEqual(loadConfig(empty.home)?.mention, { asked: true, groupId: null, handle: null })
})

test('SU22 ボットで入力欄にボタンを出せなければ、6段目で止めずに進め、最後に管理画面での手順をもう一度示す', async (t) => {
  const f = await fixture(t, (r): SlackReply | null =>
    r.method === 'workflows.featured.add' ? { json: { ok: false, error: 'restricted_action' } } : null,
  )
  const r = await f.setup(FULL_INPUT)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\[10\/10\]/)
  const tail = r.stdout.slice(r.stdout.indexOf('[10/10]'))
  assert.match(tail, /おすすめアプリに追加/)
  assert.ok(tail.includes('https://slack.com/app_redirect?channel=C0TARGET01&team=T0ACME001'))
  const again = await f.setup('\n\n')
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.calls('workflows.featured.add').length, 1)
  assert.match(again.stdout, /おすすめアプリに追加/)
})

test('SU26 初回に複数のリポジトリを設定し、フォームを deploy し直す', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('\n#Issue-Intake\nacme/app\nacme/web\n\n\n\n\nthread\n\n\ny\n')
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.deepEqual(loadConfig(f.home)?.repos, [
    { name: 'acme/app', form: true, existing: 'skip' },
    { name: 'acme/web', form: true, existing: 'thread' },
  ])
  assert.equal(loadConfig(f.home)?.defaultRepo, 'acme/app')
  const db = openDb(homePaths(f.home).db)
  assert.ok(db.prepare("SELECT value FROM meta WHERE key='adopt_after:acme/web'").get()?.value)
  db.close()
  for (const repo of ['acme/app', 'acme/web'])
    assert.ok(ghCalls(f.gh.log).some((c) => c.argv[0] === 'label' && c.argv[1] === 'list' && c.argv.includes(repo)))
  assert.equal(f.cliCalls('deploy').length, 2)
  const { manifestHash } = await import('../lib/slack-cli.ts')
  assert.equal(readFileSync(slackProject(f.home).manifestHash, 'utf8').trim(), manifestHash(['acme/app', 'acme/web']))
  assert.ok(!r.stdout.includes('ターミナルで make setup'))
})
test('SU27 リポジトリを追加し、既存のボタンを重ねず deploy し直す', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const r = await f.setup('acme/web\n\n\nthread\n\n')
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(loadConfig(f.home)?.repos.length, 2)
  assert.equal(f.cliCalls('deploy').length, 2)
  assert.equal(f.cliCalls('trigger create').length, 3)
})
test('SU28 報告の材料を見つけて設定し、無ければ案内する', async (t) => {
  const f = await fixture(t)
  const dir = join(f.claudeHome, 'config/orca-team-dispatch-task/auto/main')
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 'report.json')
  writeFileSync(source, readFileSync(join(import.meta.dirname, 'fixtures/auto-report.json')))
  const r = await f.setup('\n#Issue-Intake\nacme/app\n\n\n\n\n\n\n08:30\ny\n')
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.deepEqual(loadConfig(f.home)?.report, { channel: null, dailyAt: '08:30', source })
  const db = openDb(homePaths(f.home).db)
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='report_asked'").get()?.value, '1')
  db.close()
  const empty = await fixture(t)
  const skipped = await empty.setup(FULL_INPUT)
  assert.equal(skipped.code, 0, skipped.stderr + skipped.stdout)
  assert.ok(skipped.stdout.includes('--auto の報告の材料が見つかりません'))
  assert.equal(loadConfig(empty.home)?.report.source, null)
})

test('MW3 --name before the subcommand selects the home; after it is left alone', () => {
  const user = tempHome()
  const base = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '', SLACK_ISSUE_INTAKE_CLAUDE_HOME: tempHome() }
  for (const args of [
    ['--name', 'BAD', 'status'],
    ['--name', 'slack-app', 'status'],
    ['--name'],
    ['--name=', 'status'],
  ]) {
    const r = runCli(args, base)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.stderr, /^slack-issue-intake: /m)
  }
  assert.deepEqual(readdirSync(user), [])
  const conflict = runCli(['--name', 'ws2', 'status'], { ...base, SLACK_ISSUE_INTAKE_HOME: tempHome() })
  assert.equal(conflict.code, 2)
  assert.match(conflict.stderr, /SLACK_ISSUE_INTAKE_HOME/)
  const config = join(user, '.slack-issue-intake-ws2', 'config.json')
  for (const args of [
    ['--name', 'ws2', 'status'],
    ['--name=ws2', 'status'],
  ]) {
    const r = runCli(args, base)
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(`config=${config}\n`), r.stdout)
  }
  // 後ろの --name は status の引数のまま（status の parseArgs が断る。入口の衝突の検査は働かない）
  const after = runCli(['status', '--name', 'ws2'], { ...base, SLACK_ISSUE_INTAKE_HOME: tempHome() })
  assert.equal(after.code, 2)
  assert.match(after.stderr, /^status: /m)
})
test('MW4 setup under a named home keeps every child, the deploy hook and the automation in that home', async (t) => {
  const f = await fixture(t)
  const user = tempHome()
  const r = await f.setup(FULL_INPUT, { SLACK_ISSUE_INTAKE_HOME: '', HOME: user }, ['--name', 'ws2', 'setup'])
  assert.equal(r.code, 0, r.stderr)
  const named = join(user, '.slack-issue-intake-ws2')
  assert.equal(loadToken(homePaths(named).secrets), 'xoxb-fake-deployed') // deploy フック（環境で届いたホーム）
  assert.equal(loadConfig(named)?.channel, 'C0TARGET01') // init の子
  assert.ok(existsSync(slackProject(named).hooks)) // <ホーム>-slack-app
  assert.ok(!existsSync(join(user, '.slack-issue-intake')))
  assert.ok(!existsSync(join(user, '.slack-issue-intake-slack-app')))
  const create = orcaCalls(f.orca.log).find((c) => c[0] === 'automations' && c[1] === 'create')
  assert.deepEqual(create?.slice(2, 4), ['--name', 'slack-issue-intake-ws2'])
  assert.ok(r.stdout.includes('NAME=ws2'))
  assert.ok(r.stdout.includes('--name ws2'))
})

test('MW9 名前つきの setup のあとも既存ホームの承認と poll を保つ', async (t) => {
  const f = await fixture(t)
  const user = realpathSync(tempHome())
  const legacy = join(user, '.slack-issue-intake'),
    named = join(user, '.slack-issue-intake-ws2')
  const first = await f.setup(FULL_INPUT, { HOME: user, SLACK_ISSUE_INTAKE_HOME: legacy })
  assert.equal(first.code, 0, first.stderr)
  const original = loadConfig(legacy)?.acceptedPermissions
  assert.ok(original)
  const second = await f.setup(FULL_INPUT, { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }, ['--name', 'ws2', 'setup'])
  assert.equal(second.code, 0, second.stderr)
  const env = { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }
  for (const home of [legacy, named]) {
    const status = await f.launch(homePaths(home).launcher, ['status'], env)
    assert.equal(status.code, 0, status.stderr)
    assert.ok(status.stdout.includes(`config=${homePaths(home).config}\n`))
    assert.match(status.stdout, /^permissions=accepted$/m)
    assert.match((await f.launch(homePaths(home).launcher, ['poll'], env)).stdout, /^result=idle\b/m)
  }
  assert.equal(loadConfig(legacy)?.acceptedPermissions, original)
  const script = homePaths(legacy).launcherScript
  writeFileSync(script, readFileSync(script, 'utf8').replace(/LAUNCHER_VERSION = \d+/, 'LAUNCHER_VERSION = 0'))
  const old = await f.launch(homePaths(legacy).launcher, ['poll'], env)
  assert.match(old.stdout, /^result=idle\b/m)
  assert.match(old.stderr, /ランチャーが古い版です/)
  assert.deepEqual(
    orcaCalls(f.orca.log)
      .filter((c) => c[1] === 'create')
      .map((c) => c[3]),
    ['slack-issue-intake', 'slack-issue-intake-ws2'],
  )
})

test('NR7 名前の答えの続きは setup の質問が読む', async (t) => {
  const f = await fixture(t)
  const user = tempHome()
  const r = await f.setup(`ws2\n${FULL_INPUT}`, { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }, [
    '--ask-name=setup',
    'setup',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(loadConfig(join(user, '.slack-issue-intake-ws2'))?.channel, 'C0TARGET01')
  assert.ok(
    r.stderr.includes('ワークスペースの名前（英小文字・数字・-）') &&
      !r.stdout.includes('ワークスペースの名前（英小文字・数字・-）'),
  )
})
test('NR8 名前なしのホームは最初に 1 回知らせ、変更しない', async (t) => {
  const f = await fixture(t)
  const user = tempHome(),
    legacy = join(user, '.slack-issue-intake')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'secrets.json'), '{}')
  const r = await f.setup(FULL_INPUT, { HOME: user, SLACK_ISSUE_INTAKE_HOME: '' }, ['--name', 'ws2', 'setup'])
  assert.equal(r.code, 0, r.stderr)
  const notice = '名前なしのホーム（~/.slack-issue-intake）は使わなくなりました'
  assert.equal(r.stdout.split(notice).length - 1, 1)
  assert.ok(r.stdout.indexOf(notice) < r.stdout.indexOf('[1/10]'))
  assert.deepEqual(readdirSync(legacy), ['secrets.json'])
  assert.equal(readFileSync(join(legacy, 'secrets.json'), 'utf8'), '{}')
})

test('UX1 既存 Issue は y/n と従来の thread/skip を大文字小文字を区別せず受け付ける', async (t) => {
  const f = await fixture(t)
  const input = `${[
    '',
    '#Issue-Intake',
    'acme/app, acme/web, acme/api',
    '',
    '',
    'maybe',
    'YES',
    '',
    'n',
    '',
    'Thread',
    '',
    '',
    'y',
  ].join('\n')}\n`
  const r = await f.setup(input)
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.deepEqual(
    loadConfig(f.home)?.repos.map((r) => [r.name, r.existing]),
    [
      ['acme/app', 'thread'],
      ['acme/web', 'skip'],
      ['acme/api', 'thread'],
    ],
  )
  assert.ok(r.stdout.includes('Slack から作っていないものも、スレッドを立てて管理しますか（y/n） [n]: '))
  assert.ok(r.stdout.includes('y / n のどれかを入力してください'))
})
test('UX2 まとめ入力の誤り・重複・読めないリポジトリだけを名指しして飛ばす', async (t) => {
  const f = await fixture(t)
  const input = `${[
    '',
    '#Issue-Intake',
    'acme/app, BAD, ACME/APP,, other/missing、acme/web',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'y',
  ].join('\n')}\n`
  const r = await f.setup(input, { FAKE_GH_MISSING_REPOS: 'other/missing' })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.deepEqual(
    loadConfig(f.home)?.repos.map((r) => r.name),
    ['acme/app', 'acme/web'],
  )
  for (const text of [
    'BAD は owner/name の形ではありません。飛ばします',
    'ACME/APP は入力済みです。飛ばします',
    'other/missing を確かめられません（',
    '）。飛ばします',
    'カンマ区切り',
    '終わりなら空のまま Enter',
  ])
    assert.ok(r.stdout.includes(text), text)
  const viewed = ghCalls(f.gh.log)
    .filter((c) => c.argv[0] === 'repo' && c.argv[1] === 'view')
    .map((c) => c.argv[2])
  assert.deepEqual(viewed.slice(0, 3), ['acme/app', 'other/missing', 'acme/web'])
  assert.ok(!viewed.includes('BAD') && !viewed.includes('ACME/APP'))
})
test('UX3 Issues 無効・push 権限不足なら対象リポジトリを示して止める', async (t) => {
  for (const [extra, repos, want] of [
    [{ FAKE_GH_NO_ISSUES_REPOS: 'acme/web' }, 'acme/app, acme/web', 'acme/web: リポジトリの Issues が無効です'],
    [{ FAKE_GH_PERMISSION: 'READ' }, 'acme/app', 'acme/app: Issue に重複防止用のラベルを付けるため'],
  ] as const) {
    const f = await fixture(t)
    const r = await f.setup(`${['', '#Issue-Intake', repos].join('\n')}\n`, extra)
    assert.equal(r.code, 1, r.stderr + r.stdout)
    assert.ok(r.stderr.includes(want), r.stderr)
    assert.equal(loadConfig(f.home), null)
  }
})
test('UX4 再実行で追加するときも複数のリポジトリを一度に入れられる', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const r = await f.setup(`${['acme/web，acme/api', '', '', '', '', '', ''].join('\n')}\n`)
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.deepEqual(
    loadConfig(f.home)?.repos.map((r) => r.name),
    ['acme/app', 'acme/web', 'acme/api'],
  )
  assert.ok(r.stdout.includes('無いか、終わりなら空のまま Enter'))
})
