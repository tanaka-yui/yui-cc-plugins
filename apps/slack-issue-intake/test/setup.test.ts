import { loadConfig } from '../lib/config.ts'
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
  orcaCalls,
  runCliAsync,
  slackCliCalls,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const TARGET = { id: 'C0TARGET01', name: 'issue-intake', is_private: false, is_member: false }
const OTHER = { id: 'C0OTHER001', name: 'general', is_private: false, is_member: true }
const SECRET = { id: 'G0SECRET01', name: 'secret', is_private: true, is_member: true }
const FULL_INPUT = '#Issue-Intake\nacme/app\n\ny\n'

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
    if (r.method === 'bookmarks.add') return { json: { ok: true, bookmark: { id: 'Bk0FORM001' } } }
    return { json: { ok: true, messages: [] } }
  })
  t.after(() => server.close())
  const env: Record<string, string> = {
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
    orca,
    cli,
    calls,
    cliCalls,
    status,
    setup: (input: string, extra: Record<string, string> = {}) => runCliAsync(['setup'], { ...env, ...extra }, input),
  }
}

test('SU1 質問に答えるだけで、アプリ・トークン・設定・ボタン・承認・有効化までそろう', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { SLACK_BOT_TOKEN: 'xoxb-from-shell' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\[1\/8\]/)
  assert.match(r.stdout, /\[8\/8\]/)
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
  assert.equal(config?.repo, 'acme/app')
  assert.equal(config?.everyMinutes, 5)
  const [created] = f.cliCalls('trigger create')
  assert.equal(get(asObject(get(created?.triggerDef, 'inputs')), 'channel_id', 'value'), 'C0TARGET01')
  assert.equal(f.calls('bookmarks.add').length, 1)
  assert.notEqual(config?.acceptedPermissions, null)
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
})

test('SU2 もう一度実行すると、済んだ段を飛ばしてアプリ・ボタン・ブックマークを重ねない', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  const r = await f.setup('')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /済み/)
  assert.equal(f.cliCalls('deploy').length, 1)
  assert.equal(f.cliCalls('trigger create').length, 1)
  assert.equal(f.calls('bookmarks.add').length, 1)
})

test('SU3 マニフェストが変わっていれば、同じチームを指定して deploy し直す', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.setup(FULL_INPUT)).code, 0)
  writeFileSync(slackProject(f.home).manifestHash, 'old\n')
  const r = await f.setup('')
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
  const r = await f.setup('secret\n\nacme/app\n\ny\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /\/invite @Issue Intake/)
  assert.equal(f.calls('conversations.join').length, 0)
  assert.equal(loadConfig(f.home)?.channel, 'G0SECRET01')
})

test('SU7 承認しなければ何も変えずに止まり、次の実行で承認から再開する', async (t) => {
  const f = await fixture(t)
  const r = await f.setup('#issue-intake\nacme/app\n\nn\n')
  assert.equal(r.code, 1)
  assert.equal(f.status(), 'unsafe')
  assert.ok(!orcaCalls(f.orca.log).some((c) => c.includes('--enabled')))
  const again = await f.setup('y\n')
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
  const r = await f.setup('#issue-intake\nacme/app\ny\n\ny\n', { FAKE_GH_VISIBILITY: 'PUBLIC' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /公開/)
  assert.equal(loadConfig(f.home)?.repo, 'acme/app')
})

test('SU10 init が automation の登録で失敗したら、次の実行で init からやり直す', async (t) => {
  const f = await fixture(t)
  const r = await f.setup(FULL_INPUT, { FAKE_ORCA_CREATE: 'fail' })
  assert.equal(r.code, 1)
  assert.equal(loadConfig(f.home)?.orca.automationId, null)
  const again = await f.setup('y\n')
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
  const again = await f.setup('y\n')
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
  const r = await f.setup('issue-intake\nC0TARGET01\nacme/app\n\ny\n')
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
  const r = await f.setup('customers\nacme/app\n\ny\n')
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
  assert.doesNotMatch(r.stdout, /\[1\/8\]/)
})
