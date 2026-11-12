import {
  CATEGORIES,
  FIELD_LABELS,
  FORM_EXTRA_SCOPES,
  FORM_FIELD_TITLE_MAX_CHARS,
  FORM_TITLE,
  FORM_TITLE_MAX_UNITS,
  FORM_WORKFLOW_ID,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  SLACK_BOT_SCOPES,
} from '../../lib/defaults.ts'
import { formManifestObject, renderWorkflowMessage, triggerParams } from '../../lib/form.ts'
import { manifestObject, renderManifest } from '../../lib/guide.ts'
import { asArray, asObject, asString, get, parseJson } from '../../lib/json.ts'
import { parseSubmission } from '../../lib/parse.ts'
import { CHANNEL, REPORTER } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'

const workflow = get(formManifestObject(), 'workflows', FORM_WORKFLOW_ID)
const step = (index: number): Json | undefined => asArray(get(workflow, 'steps'))?.[index]
const elements = (): Json[] => asArray(get(step(0), 'inputs', 'fields', 'elements')) ?? []
// open_form の題は半角24字まで。日本語は1字を3と数える（日本語だけなら8字）
const titleUnits = (s: string): number => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) < 128 ? 1 : 3), 0)

test('FM1 通常のマニフェストは変えず、フォーム付きはワークフローと権限を足す', () => {
  assert.equal(get(manifestObject(), 'settings', 'org_deploy_enabled'), false)
  assert.equal(get(manifestObject(), 'workflows'), undefined)
  assert.ok(!renderManifest().includes('triggers:write'))
  const form = formManifestObject()
  assert.equal(get(form, 'settings', 'org_deploy_enabled'), true)
  assert.equal(get(form, 'settings', 'token_rotation_enabled'), false)
  assert.deepEqual(get(form, 'oauth_config', 'scopes', 'bot'), [...SLACK_BOT_SCOPES, ...FORM_EXTRA_SCOPES])
  assert.deepEqual(get(form, 'display_information'), get(manifestObject(), 'display_information'))
  assert.deepEqual(
    asArray(get(workflow, 'steps'))?.map((s) => get(s, 'function_id')),
    ['slack#/functions/open_form', 'slack#/functions/send_message'],
  )
})
test('FM2 フォームの項目は定数どおりで、Slack の文字数の上限に収まる', () => {
  assert.ok(titleUnits(FORM_TITLE) <= FORM_TITLE_MAX_UNITS)
  assert.equal(get(step(0), 'inputs', 'title'), FORM_TITLE)
  for (const e of elements()) assert.ok([...(asString(get(e, 'title')) ?? '')].length <= FORM_FIELD_TITLE_MAX_CHARS)
  const byName = (name: string): Json | undefined => elements().find((e) => get(e, 'name') === name)
  assert.equal(get(byName('title'), 'title'), FIELD_LABELS.title)
  assert.deepEqual(get(byName('category'), 'enum'), [...CATEGORIES])
  assert.deepEqual(get(byName('priority'), 'enum'), [...PRIORITIES])
  assert.equal(get(byName('body'), 'long'), true)
  assert.equal(get(byName('attachments'), 'items', 'type'), 'slack#/types/file_id')
  assert.equal(get(byName('attachments'), 'maxItems'), MAX_FILES_PER_MESSAGE)
  assert.deepEqual(get(step(0), 'inputs', 'fields', 'required'), ['title', 'category', 'priority', 'body'])
  assert.equal(get(step(1), 'inputs', 'files'), '{{steps.0.fields.attachments}}')
  assert.equal(get(step(1), 'inputs', 'channel_id'), '{{inputs.channel_id}}')
})
test('FM3 ワークフローの投稿は変数を埋めると解析器がそのまま読める', () => {
  const message = asString(get(step(1), 'inputs', 'message')) ?? ''
  assert.equal(message, renderWorkflowMessage())
  const filled = message
    .replace('{{steps.0.fields.title}}', 'ログインできない')
    .replace('{{steps.0.fields.category}}', '要望')
    .replace('{{steps.0.fields.priority}}', 'low')
    .replace('{{inputs.user_id}}', REPORTER)
    .replace('{{steps.0.fields.body}}', '1行目\n2行目')
  assert.deepEqual(parseSubmission(filled, null), {
    kind: 'ok',
    fields: {
      title: 'ログインできない',
      fullTitle: 'ログインできない',
      category: '要望',
      priority: 'low',
      body: '1行目\n2行目',
      reporterId: REPORTER,
    },
  })
})
test('FM4 ボタンは設定のチャンネルへ固定し、押した人と操作の文脈を渡す', () => {
  const p = triggerParams(CHANNEL)
  assert.equal(p.type, 'shortcut')
  assert.equal(p.workflow, `#/workflows/${FORM_WORKFLOW_ID}`)
  assert.deepEqual(asObject(parseJson(p.inputs ?? '')), {
    interactivity: { value: '{{data.interactivity}}' },
    channel_id: { value: CHANNEL },
    user_id: { value: '{{data.user_id}}' },
  })
  const required = asArray(get(workflow, 'input_parameters', 'required')) ?? []
  assert.deepEqual([...required].sort(), Object.keys(asObject(parseJson(p.inputs ?? '')) ?? {}).sort())
})
