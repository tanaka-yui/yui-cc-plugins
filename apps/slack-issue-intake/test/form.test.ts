import { getMeta, openDb } from '../lib/db.ts'
import {
  FORM_META_BOOKMARK_ID,
  FORM_META_TRIGGER_ID,
  FORM_META_URL,
  FORM_TITLE,
  FORM_WORKFLOW_ID,
} from '../lib/defaults.ts'
import { renderFormManifest } from '../lib/form.ts'
import { asObject, parseJson } from '../lib/json.ts'
import { homePaths } from '../lib/paths.ts'
import { BOT_ID, BOT_USER, CHANNEL, TEAM_ID, TEAM_URL } from './fixtures/slack-messages.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const TRIGGER_ID = 'Ft0FORM001'
const SHORTCUT = `https://slack.com/shortcuts/${TRIGGER_ID}/abc123`
const auth = (teamId = TEAM_ID): SlackReply => ({
  json: { ok: true, user_id: BOT_USER, bot_id: BOT_ID, team_id: teamId, url: TEAM_URL, team: 'acme' },
})
const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  handler: (r: SlackRequest) => SlackReply | null = () => null,
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const server = await startSlack(
    (r): SlackReply =>
      handler(r) ??
      (r.method === 'auth.test'
        ? auth()
        : r.method === 'workflows.triggers.create'
          ? { json: { ok: true, trigger: { id: TRIGGER_ID, shortcut_url: SHORTCUT } } }
          : r.method === 'bookmarks.add'
            ? { json: { ok: true, bookmark: { id: 'Bk0FORM001' } } }
            : { json: { ok: true } }),
  )
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const meta = (key: string): string | null => {
    const db = openDb(homePaths(home).db)
    const value = getMeta(db, key)
    db.close()
    return value
  }
  const calls = (method: string): SlackRequest[] => server.requests.filter((r) => r.method === method)
  return { server, meta, calls, form: (args: string[] = []) => runCliAsync(['form', ...args], env) }
}

test('FO1 ボタンを作り、チャンネルのメンバーに限って使えるようにし、ブックマークを置く。再実行で重ねない', async (t) => {
  const f = await fixture(t)
  const r = await f.form()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`url=${SHORTCUT}`))
  const [created] = f.calls('workflows.triggers.create')
  assert.equal(created?.auth, 'Bearer xoxb-test-token')
  assert.equal(created?.params.type, 'shortcut')
  assert.equal(created?.params.workflow, `#/workflows/${FORM_WORKFLOW_ID}`)
  assert.deepEqual(asObject(parseJson(created?.params.inputs ?? ''))?.channel_id, { value: CHANNEL })
  assert.deepEqual(f.calls('workflows.triggers.permissions.set')[0]?.params, {
    trigger_id: TRIGGER_ID,
    permission_type: 'named_entities',
    channel_ids: CHANNEL,
  })
  assert.deepEqual(f.calls('bookmarks.add')[0]?.params, {
    channel_id: CHANNEL,
    title: FORM_TITLE,
    type: 'link',
    link: SHORTCUT,
  })
  assert.equal(f.meta(FORM_META_TRIGGER_ID), TRIGGER_ID)
  assert.equal(f.meta(FORM_META_URL), SHORTCUT)
  assert.equal(f.meta(FORM_META_BOOKMARK_ID), 'Bk0FORM001')
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.calls('workflows.triggers.create').length, 1)
  assert.equal(f.calls('bookmarks.add').length, 1)
  assert.equal(f.calls('workflows.triggers.permissions.set').length, 2)
})
test('FO2 Slack がボタンの作成を断ったら、手作業の手順へ案内して何も残さない', async (t) => {
  const f = await fixture(t, (r) =>
    r.method === 'workflows.triggers.create'
      ? {
          json: {
            ok: false,
            error: 'invalid_arguments',
            errors: [{ code: 'missing_parameter', missing_parameter_name: 'workflow_app_id' }],
          },
        }
      : null,
  )
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.match(r.stderr, /invalid_arguments/)
  assert.match(r.stderr, /missing_parameter_name.+workflow_app_id/)
  assert.match(r.stderr, /guide/)
  assert.equal(f.calls('workflows.triggers.permissions.set').length, 0)
  assert.equal(f.calls('bookmarks.add').length, 0)
  assert.equal(f.meta(FORM_META_TRIGGER_ID), null)
})
test('FO3 ブックマークだけ失敗したら URL を示し、再実行ではボタンを作り直さずにブックマークだけ足す', async (t) => {
  let refuse = true
  const f = await fixture(t, (r) => {
    if (r.method !== 'bookmarks.add' || !refuse) return null
    refuse = false
    return { json: { ok: false, error: 'not_in_channel' } }
  })
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes(SHORTCUT))
  assert.equal(f.meta(FORM_META_TRIGGER_ID), TRIGGER_ID)
  assert.equal(f.meta(FORM_META_BOOKMARK_ID), null)
  const again = await f.form()
  assert.equal(again.code, 0, again.stderr)
  assert.equal(f.calls('workflows.triggers.create').length, 1)
  assert.equal(f.meta(FORM_META_BOOKMARK_ID), 'Bk0FORM001')
})
test('FO4 トークンのワークスペースが設定と違えば何も作らない', async (t) => {
  const f = await fixture(t, (r) => (r.method === 'auth.test' ? auth('T0OTHER01') : null))
  const r = await f.form()
  assert.equal(r.code, 1)
  assert.equal(f.calls('workflows.triggers.create').length, 0)
})
test('FO5 --manifest は設定なしでフォーム付きのマニフェストを出し、ボタンは init の後でだけ作る', async () => {
  const env = { SLACK_ISSUE_INTAKE_HOME: tempHome(), SLACK_ISSUE_INTAKE_API_BASE: 'http://127.0.0.1:9/api' }
  const printed = await runCliAsync(['form', '--manifest'], env)
  assert.equal(printed.code, 0, printed.stderr)
  assert.equal(printed.stdout, `${renderFormManifest()}\n`)
  const missing = await runCliAsync(['form'], env)
  assert.equal(missing.code, 2)
})
