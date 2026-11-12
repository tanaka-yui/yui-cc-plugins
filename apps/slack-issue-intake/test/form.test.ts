import { getMeta, openDb, setMeta } from '../lib/db.ts'
import { FORM_KINDS, FORM_META_FEATURED, FORM_META_TRIGGER_ID, FORM_META_URL, formMetaKey } from '../lib/defaults.ts'
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

const IDS = ['Ft0FAKEBUG', 'Ft0FAKEREQ', 'Ft0FAKEFEA']
const JOINED = IDS.join(',')
const LEGACY_ID = 'Ft0FAKEFOR'
const shortcut = (id: string): string => `https://slack.com/shortcuts/${id}/abc123`
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
  const seedMeta = (key: string, value: string): void => {
    const db = openDb(homePaths(home).db)
    setMeta(db, key, value)
    db.close()
  }
  const calls = (method: string): SlackRequest[] => server.requests.filter((r) => r.method === method)
  const cliCalls = (sub: string) => slackCliCalls(cli.log).filter((c) => c.argv.slice(0, 2).join(' ') === sub)
  return {
    home,
    server,
    meta,
    seedMeta,
    calls,
    cliCalls,
    form: (args: string[] = []) => runCliAsync(['form', ...args], env),
  }
}

test('FO1 Slack CLI で 3 つのボタンを作ってチャンネルのメンバーに限り、1 回でおすすめにする。再実行で重ねない', async (t) => {
  const f = await fixture(t)
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  const created = f.cliCalls('trigger create')
  assert.deepEqual(
    created.map((c) => get(c.triggerDef, 'workflow')),
    FORM_KINDS.map((k) => `#/workflows/${k.workflowId}`),
  )
  for (const c of created) {
    for (const arg of ['--trigger-def', '--app', 'deployed', '--team', TEAM_ID, '--skip-update', '--no-color'])
      assert.ok(c.argv.includes(arg), arg)
    assert.deepEqual(get(asObject(get(c.triggerDef, 'inputs')), 'channel_id'), { value: CHANNEL })
    assert.equal(c.hadBotToken, false)
  }
  const granted = f.cliCalls('trigger access').map((c) => c.argv.join(' '))
  for (const id of IDS)
    assert.ok(
      granted.some((a) =>
        a.includes(`--trigger-id ${id} --channels ${CHANNEL} --grant --include-app-collaborators=false`),
      ),
    )
  assert.deepEqual(
    f.calls('workflows.featured.add').map((c) => c.params),
    [{ channel_id: CHANNEL, trigger_ids: JOINED }],
  )
  assert.equal(f.calls('bookmarks.add').length, 0)
  FORM_KINDS.forEach((kind, i) => {
    assert.equal(f.meta(formMetaKey(FORM_META_TRIGGER_ID, kind)), IDS[i])
    assert.equal(f.meta(formMetaKey(FORM_META_URL, kind)), shortcut(IDS[i] ?? ''))
    assert.match(r.stdout, new RegExp(`trigger.${kind.key}=${IDS[i]}`))
    assert.match(r.stdout, new RegExp(`url.${kind.key}=${shortcut(IDS[i] ?? '')}`))
  })
  assert.equal(f.meta(FORM_META_FEATURED), JOINED)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.cliCalls('trigger create').length, 3)
  assert.equal(f.calls('workflows.featured.add').length, 1)
  assert.equal(f.cliCalls('trigger access').length, 6)
  assert.equal(f.cliCalls('trigger delete').length, 0)
})
test('FO2 Slack CLI がボタンを作れなければ、Workflow Builder の手順へ案内して何も残さない', async (t) => {
  const f = await fixture(t, { cliEnv: { FAKE_SLACK_CLI_TRIGGER_FAIL: 'workflow_not_found' } })
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.match(r.stderr, /workflow_not_found/)
  assert.match(r.stderr, /Workflow Builder/)
  assert.equal(f.cliCalls('trigger access').length, 0)
  assert.equal(f.calls('workflows.featured.add').length, 0)
  for (const kind of FORM_KINDS) assert.equal(f.meta(formMetaKey(FORM_META_TRIGGER_ID, kind)), null)
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
  assert.deepEqual(
    FORM_KINDS.map((k) => f.meta(formMetaKey(FORM_META_TRIGGER_ID, k))),
    IDS,
  )
  assert.equal(f.meta(FORM_META_FEATURED), null)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.cliCalls('trigger create').length, 3)
  assert.equal(f.meta(FORM_META_FEATURED), JOINED)
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
test('FO6 ボットにおすすめにする権限が無ければ、管理画面での手順を示して止めずに終わり、再実行ではもう一度試す', async (t) => {
  const f = await fixture(t, {
    handler: (r) =>
      r.method === 'workflows.featured.add' ? { json: { ok: false, error: 'restricted_action' } } : null,
  })
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /restricted_action/)
  assert.match(r.stderr, /おすすめ/)
  assert.match(r.stderr, /管理画面/)
  assert.match(r.stderr, /おすすめアプリに追加/)
  assert.match(r.stdout, /featured=manual/)
  assert.equal(f.meta(FORM_META_FEATURED), 'manual')
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.calls('workflows.featured.add').length, 2)
  assert.equal(f.cliCalls('trigger create').length, 3)
})
test('FO8 0.2 の 1 つのボタンは、新しい 3 つをおすすめにしたあとで外して消す', async (t) => {
  const f = await fixture(t)
  f.seedMeta(FORM_META_TRIGGER_ID, LEGACY_ID)
  f.seedMeta(FORM_META_URL, shortcut(LEGACY_ID))
  f.seedMeta(FORM_META_FEATURED, LEGACY_ID)
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  const order = f.server.requests.map((q) => q.method).filter((m) => m.startsWith('workflows.featured'))
  assert.deepEqual(order, ['workflows.featured.add', 'workflows.featured.remove'])
  assert.deepEqual(f.calls('workflows.featured.remove')[0]?.params, { channel_id: CHANNEL, trigger_ids: LEGACY_ID })
  const [deleted] = f.cliCalls('trigger delete')
  assert.ok(deleted?.argv.join(' ').includes(`--trigger-id ${LEGACY_ID} --app deployed --team ${TEAM_ID}`))
  assert.equal(f.meta(FORM_META_TRIGGER_ID), null)
  assert.equal(f.meta(FORM_META_URL), null)
  assert.equal(f.meta(FORM_META_FEATURED), JOINED)
})
test('FO9 古いボタンを一時的な失敗で消せなくても止めずに終わり、印を残して次の実行でやり直す', async (t) => {
  const f = await fixture(t, { cliEnv: { FAKE_SLACK_CLI_DELETE_FAIL: 'internal_error' } })
  f.seedMeta(FORM_META_TRIGGER_ID, LEGACY_ID)
  f.seedMeta(FORM_META_URL, shortcut(LEGACY_ID))
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /internal_error/)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), LEGACY_ID)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.cliCalls('trigger delete').length, 2)
})
test('FO10 新しいボタンをボットでおすすめにできないうちは、古いボタンを消さずに案内する', async (t) => {
  const f = await fixture(t, {
    handler: (r) =>
      r.method === 'workflows.featured.add' ? { json: { ok: false, error: 'restricted_action' } } : null,
  })
  f.seedMeta(FORM_META_TRIGGER_ID, LEGACY_ID)
  f.seedMeta(FORM_META_URL, shortcut(LEGACY_ID))
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.calls('workflows.featured.remove').length, 0)
  assert.equal(f.cliCalls('trigger delete').length, 0)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), LEGACY_ID)
  assert.match(r.stderr, /make slack-form/)
})
test('FO11 古いボタンがもう無ければ（not found）、消えたものとして印を消す', async (t) => {
  const f = await fixture(t, { cliEnv: { FAKE_SLACK_CLI_DELETE_FAIL: 'Error: trigger_not_found' } })
  f.seedMeta(FORM_META_TRIGGER_ID, LEGACY_ID)
  f.seedMeta(FORM_META_URL, shortcut(LEGACY_ID))
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), null)
  assert.equal(f.meta(FORM_META_URL), null)
  assert.ok(!/消せませんでした/.test(r.stderr))
})
test('FO12 deploy 済みのマニフェストが今のものと違えば、ボタンを作らず make setup を案内する', async (t) => {
  const f = await fixture(t)
  const { saveDeployedHash, slackProject } = await import('../lib/slack-cli.ts')
  saveDeployedHash(slackProject(f.home), 'old-manifest-hash')
  const r = await f.form()
  assert.equal(r.code, 2)
  assert.match(r.stderr, /make setup/)
  assert.equal(f.cliCalls('trigger create').length, 0)
})
