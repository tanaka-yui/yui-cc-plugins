import {
  EMPTY_LONG_VALUE,
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
  channelAppLink,
  channelLink,
  featuredParams,
  featureSteps,
  formManifestObject,
  formTitles,
  renderFormManifest,
  renderWorkflowMessage,
  triggerDefinition,
} from '../../lib/form.ts'
import { manifestObject, renderManifest } from '../../lib/guide.ts'
import { asArray, asObject, asString, get } from '../../lib/json.ts'
import { parseSubmission } from '../../lib/parse.ts'
import { manifestHash } from '../../lib/slack-cli.ts'
import { CHANNEL, kindText, REPORTER } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'
import type { FormKind } from '../../lib/types.ts'

const WORKFLOW_IDS = ['issue_intake_bug', 'issue_intake_request', 'issue_intake_feature', 'issue_intake_question']
const workflowOf = (kind: FormKind): Json | undefined => get(formManifestObject([]), 'workflows', kind.workflowId)
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
  const form = formManifestObject([])
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
  assert.ok(!renderFormManifest([]).includes('triggers:write'))
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
    if (kind.titled) {
      assert.equal(get(byName(kind, 'title'), 'title'), FIELD_LABELS.title)
      assert.deepEqual(get(byName(kind, 'priority'), 'enum'), [...PRIORITIES])
    }
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
  assert.deepEqual(required('question'), ['question_kind', 'question_body'])
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
    assert.equal(message, renderWorkflowMessage(kind, false))
    let filled = message
      .replace('{{steps.0.fields.title}}', 'ログインできない')
      .replace('{{steps.0.fields.priority}}', 'high')
      .replace('{{inputs.user_id}}', REPORTER)
    const values: Record<string, string> = {}
    for (const item of kind.items) {
      values[item.label] = item.options?.[0] ?? `${item.label}の値`
      filled = filled.replace(`{{steps.0.fields.${item.name}}}`, values[item.label] ?? '')
    }
    assert.equal(filled, kindText(kind.category, values))
    const r = parseSubmission(filled, null, [])
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

test('FM6/FM7 複数リポジトリだけ任意の選択欄を作り、指紋へ反映する', () => {
  const repos = ['acme/app', 'acme/web']
  const manifest = formManifestObject(repos)
  for (const kind of FORM_KINDS) {
    const workflow = get(manifest, 'workflows', kind.workflowId)
    const steps = asArray(get(workflow, 'steps')) ?? []
    const fields = get(steps[0], 'inputs', 'fields')
    const elements = asArray(get(fields, 'elements')) ?? []
    assert.deepEqual(elements[kind.titled ? 2 : 0], { name: 'repo', title: 'リポジトリ', type: 'string', enum: repos })
    assert.ok(!asArray(get(fields, 'required'))?.includes('repo'))
    assert.match(String(get(steps[1], 'inputs', 'message')), /\*リポジトリ:\* {{steps.0.fields.repo}}/)
    assert.equal(get(workflow, 'input_parameters', 'channel_id', 'is_required'), true)
  }
  assert.ok(!renderFormManifest([]).includes('"name": "repo"'))
  assert.ok(!renderFormManifest(['acme/app']).includes('"name": "repo"'))
  assert.equal(manifestHash([]), manifestHash(['acme/app']))
  assert.notEqual(manifestHash([]), manifestHash(repos))
})

test('LK1 リンクはチーム ID の有無を扱い、チャンネルの側の手順を先にする', () => {
  assert.equal(
    channelLink('C0123456789', 'T0ACME001'),
    'https://slack.com/app_redirect?channel=C0123456789&team=T0ACME001',
  )
  assert.equal(channelLink('C0123456789', null), 'https://slack.com/app_redirect?channel=C0123456789')
  assert.equal(channelAppLink('C0123456789', 'T0ACME001'), 'slack://channel?team=T0ACME001&id=C0123456789')
  assert.equal(channelLink('C&1', 'T 1'), 'https://slack.com/app_redirect?channel=C%261&team=T%201')
  const steps = featureSteps('C0123456789', 'T0ACME001')
  assert.ok(
    steps.startsWith(
      '\n  1. 起票のチャンネルを開きます: https://slack.com/app_redirect?channel=C0123456789&team=T0ACME001\n     Slack のアプリで開くなら: slack://channel?team=T0ACME001&id=C0123456789\n  2. ',
    ),
  )
  assert.ok(steps.indexOf('ワークフローを目立たせる') < steps.indexOf('管理画面'))
  for (const text of [
    'おすすめアプリに追加',
    formTitles(),
    'アプリ Issue Intake',
    'Admin →「Apps and workflows」→「Workflows」',
  ])
    assert.ok(steps.includes(text), text)
  assert.ok(!steps.slice(steps.indexOf('管理画面')).includes('://'))
  const noTeam = featureSteps('C0123456789', null)
  assert.ok(!noTeam.includes('team=') && !noTeam.includes('slack://'))
})

test('FM8 「質問する」は題と優先度の欄を持たず、質問の種類を選ばせ、投稿にも題と優先度の行を置かない', () => {
  const kind = kindOf('question')
  assert.equal(kind.title, '質問する')
  assert.equal(kind.category, '質問')
  assert.deepEqual(
    elements(kind).map((e) => get(e, 'name')),
    ['question_kind', 'question_body', 'attachments'],
  )
  assert.deepEqual(get(byName(kind, 'question_kind'), 'enum'), ['仕様について', 'バグか仕様なのかわからない', 'その他'])
  assert.equal(get(byName(kind, 'question_body'), 'long'), true)
  assert.notEqual(get(workflowOf(kind), 'description'), get(workflowOf(kindOf('bug')), 'description'))
  const message = renderWorkflowMessage(kind, true)
  assert.ok(!message.includes('タイトル') && !message.includes('優先度'))
  assert.match(message, /^\*カテゴリ:\* 質問\n\*リポジトリ:\* {{steps.0.fields.repo}}$/m)
  assert.ok(featureSteps(CHANNEL, null).includes(`の ${FORM_KINDS.length} つを選び`))
})

test('FM9 向き先の候補があれば「質問する」以外に任意の向き先の選択を出し、指紋へ反映する', () => {
  const branches = ['develop', 'main']
  const manifest = formManifestObject(['acme/app'], branches)
  for (const kind of FORM_KINDS) {
    const workflow = get(manifest, 'workflows', kind.workflowId)
    const steps = asArray(get(workflow, 'steps')) ?? []
    const fields = get(steps[0], 'inputs', 'fields')
    const items = asArray(get(fields, 'elements')) ?? []
    const base = items.find((e) => get(e, 'name') === 'base')
    const message = String(get(steps[1], 'inputs', 'message'))
    if (!kind.titled) {
      assert.equal(base, undefined)
      assert.ok(!message.includes(FIELD_LABELS.base))
      continue
    }
    assert.deepEqual(base, { name: 'base', title: '向き先', type: 'string', enum: ['おまかせ', 'develop', 'main'] })
    assert.equal(items.indexOf(base ?? null), 2)
    assert.ok(!asArray(get(fields, 'required'))?.includes('base'))
    assert.match(message, /\*優先度:\* {{steps.0.fields.priority}}\n\*向き先:\* {{steps.0.fields.base}}\n/)
    // 埋めた投稿を解析器が読み、選んだ向き先を残す
    const filled = message
      .replace('{{steps.0.fields.title}}', 'ログインできない')
      .replace('{{steps.0.fields.priority}}', 'high')
      .replace('{{steps.0.fields.base}}', 'main')
      .replace('{{inputs.user_id}}', REPORTER)
      .replace(/{{steps\.0\.fields\.[a-z_]+}}/g, 'x')
    const r = parseSubmission(filled, null, [], () => branches)
    assert.ok(r.kind === 'ok' && r.fields.base === 'main', kind.key)
  }
  // 複数リポジトリなら、リポジトリの欄の次に置く
  const both = formManifestObject(['acme/app', 'acme/web'], branches)
  const bug = asArray(
    get(asArray(get(both, 'workflows', 'issue_intake_bug', 'steps'))?.[0], 'inputs', 'fields', 'elements'),
  )
  assert.deepEqual(
    bug?.slice(0, 4).map((e) => get(e, 'name')),
    ['title', 'priority', 'repo', 'base'],
  )
  assert.equal(renderFormManifest([]), renderFormManifest([], []))
  assert.equal(manifestHash(['acme/app']), manifestHash(['acme/app'], []))
  assert.notEqual(manifestHash(['acme/app']), manifestHash(['acme/app'], branches))
  assert.notEqual(manifestHash(['acme/app'], branches), manifestHash(['acme/app'], ['develop', 'main', 'release']))
})
test('FM10 任意の複数行の項目だけ、未入力のときに出す「記載なし」を既定値にする', () => {
  for (const kind of FORM_KINDS)
    for (const item of kind.items)
      assert.equal(
        get(byName(kind, item.name), 'default'),
        item.long && !item.required ? EMPTY_LONG_VALUE : undefined,
        `${kind.key} ${item.name}`,
      )
  assert.equal(get(byName(kindOf('bug'), 'error_log'), 'default'), '記載なし')
  assert.equal(get(byName(kindOf('bug'), 'symptom'), 'default'), undefined)
})
