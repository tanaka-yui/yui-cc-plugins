import { getMeta, openDb } from '../lib/db.ts'
import { FORM_META_FEATURED, FORM_META_TRIGGER_ID, FORM_META_URL } from '../lib/defaults.ts'
import { renderFormManifest } from '../lib/form.ts'
import { asObject, get } from '../lib/json.ts'
import { homePaths } from '../lib/paths.ts'
import { BOT_ID, BOT_USER, CHANNEL, TEAM_ID, TEAM_URL } from './fixtures/slack-messages.ts'
import {
  fakeGh,
  fakeSlackCli,
  runCliAsync,
  seedSlackApp,
  setupHome,
  slackCliCalls,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const TRIGGER_ID = 'Ft0FAKE001'
const SHORTCUT = `https://slack.com/shortcuts/${TRIGGER_ID}/abc123`
const auth = (teamId = TEAM_ID): SlackReply => ({
  json: { ok: true, user_id: BOT_USER, bot_id: BOT_ID, team_id: teamId, url: TEAM_URL, team: 'acme' },
})
const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  options: { handler?: (r: SlackRequest) => SlackReply | null; seed?: boolean; cliEnv?: Record<string, string> } = {},
) => {
  const { handler = () => null, seed = true, cliEnv = {} } = options
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const cli = fakeSlackCli(tempHome())
  if (seed) await seedSlackApp(home, TEAM_ID)
  const server = await startSlack(
    (r): SlackReply => handler(r) ?? (r.method === 'auth.test' ? auth() : { json: { ok: true } }),
  )
  t.after(() => server.close())
  const env = {
    ...gh.env,
    ...cli.env,
    ...cliEnv,
    ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })),
  }
  const meta = (key: string): string | null => {
    const db = openDb(homePaths(home).db)
    const value = getMeta(db, key)
    db.close()
    return value
  }
  const calls = (method: string): SlackRequest[] => server.requests.filter((r) => r.method === method)
  const cliCalls = (sub: string) => slackCliCalls(cli.log).filter((c) => c.argv.slice(0, 2).join(' ') === sub)
  return { home, server, meta, calls, cliCalls, form: (args: string[] = []) => runCliAsync(['form', ...args], env) }
}

test('FO1 Slack CLI でリンクを作ってチャンネルのメンバーに限り、おすすめワークフローにして入力欄にボタンを出す。再実行で重ねない', async (t) => {
  const f = await fixture(t)
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`url=${SHORTCUT}`))
  const [created] = f.cliCalls('trigger create')
  for (const arg of ['--trigger-def', '--app', 'deployed', '--team', TEAM_ID, '--skip-update', '--no-color'])
    assert.ok(created?.argv.includes(arg), arg)
  assert.deepEqual(get(asObject(get(created?.triggerDef, 'inputs')), 'channel_id'), { value: CHANNEL })
  assert.equal(created?.hadBotToken, false)
  const [granted] = f.cliCalls('trigger access')
  const argv = granted?.argv.join(' ') ?? ''
  assert.ok(argv.includes(`--trigger-id ${TRIGGER_ID} --channels ${CHANNEL} --grant --include-app-collaborators=false`))
  assert.deepEqual(f.calls('workflows.featured.add')[0]?.params, { channel_id: CHANNEL, trigger_ids: TRIGGER_ID })
  assert.equal(f.calls('bookmarks.add').length, 0)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), TRIGGER_ID)
  assert.equal(f.meta(FORM_META_URL), SHORTCUT)
  assert.equal(f.meta(FORM_META_FEATURED), TRIGGER_ID)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.cliCalls('trigger create').length, 1)
  assert.equal(f.calls('workflows.featured.add').length, 1)
  assert.equal(f.cliCalls('trigger access').length, 2)
})
test('FO2 Slack CLI がボタンを作れなければ、Workflow Builder の手順へ案内して何も残さない', async (t) => {
  const f = await fixture(t, { cliEnv: { FAKE_SLACK_CLI_TRIGGER_FAIL: 'workflow_not_found' } })
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.match(r.stderr, /workflow_not_found/)
  assert.match(r.stderr, /Workflow Builder/)
  assert.equal(f.cliCalls('trigger access').length, 0)
  assert.equal(f.calls('workflows.featured.add').length, 0)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), null)
})
test('FO3 おすすめにできなければ画面での手順を示し、再実行ではリンクを作り直さずにおすすめだけやり直す', async (t) => {
  let refuse = true
  const f = await fixture(t, {
    handler: (r) => {
      if (r.method !== 'workflows.featured.add' || !refuse) return null
      refuse = false
      return { json: { ok: false, error: 'not_in_channel' } }
    },
  })
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not_in_channel/)
  assert.match(r.stderr, /おすすめ/)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), TRIGGER_ID)
  assert.equal(f.meta(FORM_META_FEATURED), null)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.cliCalls('trigger create').length, 1)
  assert.equal(f.meta(FORM_META_FEATURED), TRIGGER_ID)
})
test('FO4 トークンのワークスペースが設定と違えば何も作らない', async (t) => {
  const f = await fixture(t, { handler: (r) => (r.method === 'auth.test' ? auth('T0OTHER01') : null) })
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.match(r.stderr, /ワークスペース/)
  assert.equal(f.cliCalls('trigger create').length, 0)
})
test('FO5 --manifest は設定なしで出し、make setup のアプリが無ければ案内して止まる', async (t) => {
  const env = { SLACK_ISSUE_INTAKE_HOME: tempHome(), SLACK_ISSUE_INTAKE_API_BASE: 'http://127.0.0.1:9/api' }
  const printed = await runCliAsync(['form', '--manifest'], env)
  assert.equal(printed.code, 0, printed.stderr)
  assert.equal(printed.stdout, `${renderFormManifest()}\n`)
  const missing = await runCliAsync(['form'], env)
  assert.equal(missing.code, 2)
  const f = await fixture(t, { seed: false })
  const noApp = await f.form()
  assert.equal(noApp.code, 2)
  assert.match(noApp.stderr, /make setup/)
  assert.equal(f.cliCalls('trigger create').length, 0)
})
test('FO6 Slack CLI が見つからなければ案内して exit 2 で止まる', async (t) => {
  const f = await fixture(t, { cliEnv: { SLACK_ISSUE_INTAKE_SLACK_CLI: '', PATH: '/usr/bin:/bin', HOME: tempHome() } })
  const r = await f.form()
  assert.equal(r.code, 2)
  assert.match(r.stderr, /slack login/)
  assert.equal(f.cliCalls('trigger create').length, 0)
})

test('FO7 プラグインの更新で古くなった hooks.json を、ボタンを作る前に書き直す', async (t) => {
  const f = await fixture(t)
  const { slackProject } = await import('../lib/slack-cli.ts')
  const { writeFileSync, readFileSync } = await import('node:fs')
  const project = slackProject(f.home)
  writeFileSync(project.hooks, JSON.stringify({ hooks: { deploy: '/old/node /old/bin.ts slack-hook deploy' } }))
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.ok(readFileSync(project.hooks, 'utf8').includes(process.execPath))
})
