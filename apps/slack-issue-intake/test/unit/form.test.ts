import {
  FIELD_LABELS,
  FORM_EXTRA_SCOPES,
  FORM_FIELD_TITLE_MAX_CHARS,
  FORM_KINDS,
  FORM_TITLE_MAX_UNITS,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  SLACK_BOT_SCOPES,
} from '../../lib/defaults.ts'
import {
  featuredParams,
  formManifestObject,
  renderFormManifest,
  renderWorkflowMessage,
  triggerDefinition,
} from '../../lib/form.ts'
import { manifestObject, renderManifest } from '../../lib/guide.ts'
import { asArray, asObject, asString, get } from '../../lib/json.ts'
import { parseSubmission } from '../../lib/parse.ts'
import { CHANNEL, kindText, REPORTER } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'
import type { FormKind } from '../../lib/types.ts'

const WORKFLOW_IDS = ['issue_intake_bug', 'issue_intake_request', 'issue_intake_feature']
const workflowOf = (kind: FormKind): Json | undefined => get(formManifestObject(), 'workflows', kind.workflowId)
const step = (kind: FormKind, index: number): Json | undefined => asArray(get(workflowOf(kind), 'steps'))?.[index]
const elements = (kind: FormKind): Json[] => asArray(get(step(kind, 0), 'inputs', 'fields', 'elements')) ?? []
const byName = (kind: FormKind, name: string): Json | undefined => elements(kind).find((e) => get(e, 'name') === name)
const kindOf = (key: string): FormKind => {
  const k = FORM_KINDS.find((f) => f.key === key)
  if (!k) throw new Error(key)
  return k
}
// open_form の題は半角24字まで。日本語は1字を3と数える（日本語だけなら8字）
const asObjectOrEmpty = (v: Json | undefined): Record<string, Json> => asObject(v) ?? {}
const titleUnits = (s: string): number => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) < 128 ? 1 : 3), 0)

test('FM1 通常のマニフェストは変えず、フォーム付きは 3 つのワークフローと権限を足す', () => {
  assert.equal(get(manifestObject(), 'settings', 'org_deploy_enabled'), false)
  assert.equal(get(manifestObject(), 'workflows'), undefined)
  assert.ok(!renderManifest().includes('triggers:write'))
  const form = formManifestObject()
  assert.equal(get(form, 'settings', 'org_deploy_enabled'), true)
  assert.equal(get(form, 'settings', 'token_rotation_enabled'), false)
  assert.deepEqual(get(form, 'oauth_config', 'scopes', 'bot'), [
    ...SLACK_BOT_SCOPES,
    'channels:read',
    'groups:read',
    'chat:write.public',
    'channels:join',
    'bookmarks:write',
  ])
  assert.deepEqual(
    [...FORM_EXTRA_SCOPES],
    ['channels:read', 'groups:read', 'chat:write.public', 'channels:join', 'bookmarks:write'],
  )
  assert.ok(!renderFormManifest().includes('triggers:write'))
  assert.deepEqual(get(form, 'display_information'), get(manifestObject(), 'display_information'))
  assert.deepEqual(Object.keys(asObjectOrEmpty(get(form, 'workflows'))), WORKFLOW_IDS)
  for (const kind of FORM_KINDS)
    assert.deepEqual(
      asArray(get(workflowOf(kind), 'steps'))?.map((s) => get(s, 'function_id')),
      ['slack#/functions/open_form', 'slack#/functions/send_message'],
    )
})
test('FM2 3 つのフォームの項目と必須はカテゴリどおりで、Slack の文字数の上限に収まる', () => {
  for (const kind of FORM_KINDS) {
    assert.ok(titleUnits(kind.title) <= FORM_TITLE_MAX_UNITS, kind.title)
    assert.equal(get(step(kind, 0), 'inputs', 'title'), kind.title)
    for (const e of elements(kind))
      assert.ok([...(asString(get(e, 'title')) ?? '')].length <= FORM_FIELD_TITLE_MAX_CHARS)
    assert.equal(get(byName(kind, 'title'), 'title'), FIELD_LABELS.title)
    assert.deepEqual(get(byName(kind, 'priority'), 'enum'), [...PRIORITIES])
    assert.equal(byName(kind, 'category'), undefined)
    assert.equal(get(byName(kind, 'attachments'), 'items', 'type'), 'slack#/types/file_id')
    assert.equal(get(byName(kind, 'attachments'), 'maxItems'), MAX_FILES_PER_MESSAGE)
    assert.equal(get(step(kind, 1), 'inputs', 'files'), '{{steps.0.fields.attachments}}')
    assert.equal(get(step(kind, 1), 'inputs', 'channel_id'), '{{inputs.channel_id}}')
  }
  const required = (key: string): Json | undefined => get(step(kindOf(key), 0), 'inputs', 'fields', 'required')
  assert.deepEqual(required('bug'), ['title', 'priority', 'symptom'])
  assert.deepEqual(required('request'), ['title', 'priority', 'current', 'ideal'])
  assert.deepEqual(required('feature'), ['title', 'priority', 'spec'])
  assert.equal(get(byName(kindOf('bug'), 'error_log'), 'long'), true)
  assert.equal(get(byName(kindOf('bug'), 'screen_url'), 'long'), undefined)
  assert.deepEqual(
    elements(kindOf('bug')).map((e) => get(e, 'name')),
    ['title', 'priority', 'symptom', 'error_log', 'workaround', 'screen_url', 'source_path', 'attachments'],
  )
})
test('FM3 ワークフローの投稿は変数を埋めると解析器がそのまま読める', () => {
  for (const kind of FORM_KINDS) {
    const message = asString(get(step(kind, 1), 'inputs', 'message')) ?? ''
    assert.equal(message, renderWorkflowMessage(kind))
    let filled = message
      .replace('{{steps.0.fields.title}}', 'ログインできない')
      .replace('{{steps.0.fields.priority}}', 'high')
      .replace('{{inputs.user_id}}', REPORTER)
    const values: Record<string, string> = {}
    for (const item of kind.items) {
      values[item.label] = `${item.label}の値`
      filled = filled.replace(`{{steps.0.fields.${item.name}}}`, values[item.label] ?? '')
    }
    assert.equal(filled, kindText(kind.category, values))
    const r = parseSubmission(filled, null)
    assert.ok(r.kind === 'ok' && r.fields.category === kind.category && r.fields.reporterId === REPORTER, kind.key)
  }
})
test('FM4 ボタンは設定のチャンネルへ固定し、押した人と操作の文脈を渡す', () => {
  const inputs = {
    interactivity: { value: '{{data.interactivity}}' },
    channel_id: { value: CHANNEL },
    user_id: { value: '{{data.user_id}}' },
  }
  for (const kind of FORM_KINDS) {
    const d = triggerDefinition(CHANNEL, kind)
    assert.equal(d.type, 'shortcut')
    assert.equal(d.name, kind.title)
    assert.equal(d.workflow, `#/workflows/${kind.workflowId}`)
    assert.deepEqual(d.inputs, inputs)
    const params = asObjectOrEmpty(get(workflowOf(kind), 'input_parameters'))
    assert.deepEqual(Object.keys(params).sort(), Object.keys(inputs).sort())
    for (const [name, p] of Object.entries(params)) {
      assert.equal(get(p, 'name'), name)
      assert.equal(get(p, 'is_required'), true)
      assert.ok(asString(get(p, 'type'))?.startsWith('slack#/types/'), name)
    }
  }
})
test('FM5 おすすめにする ID は , でつないで 1 回で渡す', () => {
  assert.deepEqual(featuredParams(CHANNEL, ['Ft0A', 'Ft0B']), { channel_id: CHANNEL, trigger_ids: 'Ft0A,Ft0B' })
})
