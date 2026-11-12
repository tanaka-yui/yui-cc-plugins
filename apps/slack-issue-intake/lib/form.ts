import {
  FIELD_LABELS,
  FORM_ATTACHMENTS_TITLE,
  FORM_DESCRIPTION,
  FORM_EXTRA_SCOPES,
  FORM_FEATURE_STEPS,
  FORM_KINDS,
  FORM_SUBMIT_LABEL,
  FORM_TITLE_SEPARATOR,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  SLACK_APP_NAME,
  SLACK_BOT_SCOPES,
} from './defaults.ts'
import { REPORTER_SLOT, renderKindMessage } from './form-message.ts'
import { manifestObject } from './guide.ts'
import { asObject } from './json.ts'

import type { JsonObject } from './json.ts'
import type { FormKind } from './types.ts'

// 共通の項目の内部名とワークフローの入力名。表示名は FIELD_LABELS を使う
const FIELD = { title: 'title', priority: 'priority', attachments: 'attachments' }
const INPUT = { interactivity: 'interactivity', channel: 'channel_id', user: 'user_id' }
const FORM_STEP = '0'
const fieldRef = (name: string): string => `{{steps.${FORM_STEP}.fields.${name}}}`
export const renderWorkflowMessage = (kind: FormKind): string =>
  renderKindMessage(kind, (name) => (name === REPORTER_SLOT ? `<@{{inputs.${INPUT.user}}}>` : fieldRef(name)))

// open_form で集め、send_message で添付ごと対象チャンネルへ投稿する。どちらも Slack 組み込みの関数
export const formWorkflow = (kind: FormKind): JsonObject => ({
  title: kind.title,
  description: FORM_DESCRIPTION,
  input_parameters: {
    properties: {
      [INPUT.interactivity]: { type: 'slack#/types/interactivity' },
      [INPUT.channel]: { type: 'slack#/types/channel_id' },
      [INPUT.user]: { type: 'slack#/types/user_id' },
    },
    required: [INPUT.interactivity, INPUT.channel, INPUT.user],
  },
  steps: [
    {
      id: FORM_STEP,
      function_id: 'slack#/functions/open_form',
      inputs: {
        title: kind.title,
        submit_label: FORM_SUBMIT_LABEL,
        interactivity: `{{inputs.${INPUT.interactivity}}}`,
        fields: {
          elements: [
            { name: FIELD.title, title: FIELD_LABELS.title, type: 'string' },
            { name: FIELD.priority, title: FIELD_LABELS.priority, type: 'string', enum: [...PRIORITIES] },
            ...kind.items.map((item) => ({
              name: item.name,
              title: item.label,
              type: 'string',
              ...(item.long ? { long: true } : {}),
            })),
            {
              name: FIELD.attachments,
              title: FORM_ATTACHMENTS_TITLE,
              type: 'array',
              items: { type: 'slack#/types/file_id' },
              maxItems: MAX_FILES_PER_MESSAGE,
            },
          ],
          required: [FIELD.title, FIELD.priority, ...kind.items.filter((i) => i.required).map((i) => i.name)],
        },
      },
    },
    {
      id: '1',
      function_id: 'slack#/functions/send_message',
      inputs: {
        channel_id: `{{inputs.${INPUT.channel}}}`,
        message: renderWorkflowMessage(kind),
        files: fieldRef(FIELD.attachments),
      },
    },
  ],
})

// guide のマニフェストに、フォームのワークフローとボタン用の権限を足す。workflows を持つアプリは org_deploy_enabled が必須
export const formManifestObject = (): JsonObject => {
  const base = manifestObject()
  return {
    _metadata: { major_version: 2 },
    ...base,
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES, ...FORM_EXTRA_SCOPES] } },
    settings: { ...(asObject(base.settings) ?? {}), org_deploy_enabled: true },
    workflows: Object.fromEntries(FORM_KINDS.map((kind) => [kind.workflowId, formWorkflow(kind)])),
  }
}
export const renderFormManifest = (): string => JSON.stringify(formManifestObject(), null, 2)

// Slack CLI の trigger create --trigger-def に渡す定義。投稿先は押した場所によらず設定のチャンネルに固定する
export const triggerDefinition = (channel: string, kind: FormKind): JsonObject => ({
  type: 'shortcut',
  name: kind.title,
  description: FORM_DESCRIPTION,
  workflow: `#/workflows/${kind.workflowId}`,
  inputs: {
    [INPUT.interactivity]: { value: '{{data.interactivity}}' },
    [INPUT.channel]: { value: channel },
    [INPUT.user]: { value: '{{data.user_id}}' },
  },
})

// 3 つのボタンの題を「、」でつないだもの。画面での手順や完了の案内に使う
export const formTitles = (): string => FORM_KINDS.map((k) => k.title).join(FORM_TITLE_SEPARATOR)
export const featureSteps = (): string =>
  FORM_FEATURE_STEPS.replaceAll('{title}', formTitles()).replaceAll('{app}', SLACK_APP_NAME)

// workflows.featured.add の引数。おすすめにしたワークフローは、チャンネルの入力欄の代わりにボタンとして出る
// （リンクを関連ページに API で足すと、Slack は外部リンクとして扱いブラウザを開いてしまう）
export const featuredParams = (channel: string, triggerIds: readonly string[]): Record<string, string> => ({
  channel_id: channel,
  trigger_ids: triggerIds.join(','),
})
