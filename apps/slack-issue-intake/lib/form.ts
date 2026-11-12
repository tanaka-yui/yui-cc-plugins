import {
  CATEGORIES,
  FIELD_LABELS,
  FORM_ATTACHMENTS_TITLE,
  FORM_DESCRIPTION,
  FORM_EXTRA_SCOPES,
  FORM_SUBMIT_LABEL,
  FORM_TITLE,
  FORM_WORKFLOW_ID,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  SLACK_BOT_SCOPES,
  SUBMISSION_MARKER,
} from './defaults.ts'
import { manifestObject } from './guide.ts'
import { asObject } from './json.ts'

import type { JsonObject } from './json.ts'

// フォームの項目の内部名とワークフローの入力名。表示名は FIELD_LABELS を使う
const FIELD = { title: 'title', category: 'category', priority: 'priority', body: 'body', attachments: 'attachments' }
const INPUT = { interactivity: 'interactivity', channel: 'channel_id', user: 'user_id' }
const FORM_STEP = '0'
const fieldRef = (name: string): string => `{{steps.${FORM_STEP}.fields.${name}}}`

// ワークフローが投稿するメッセージ。renderTemplate と同じ行の並びで、{…} の所にワークフローの変数を差し込む
export const renderWorkflowMessage = (): string =>
  [
    SUBMISSION_MARKER,
    `${FIELD_LABELS.title}: ${fieldRef(FIELD.title)}`,
    `${FIELD_LABELS.category}: ${fieldRef(FIELD.category)}`,
    `${FIELD_LABELS.priority}: ${fieldRef(FIELD.priority)}`,
    `${FIELD_LABELS.reporter}: <@{{inputs.${INPUT.user}}}>`,
    `${FIELD_LABELS.body}:`,
    fieldRef(FIELD.body),
  ].join('\n')

// open_form で集め、send_message で添付ごと対象チャンネルへ投稿する。どちらも Slack 組み込みの関数
export const formWorkflow = (): JsonObject => ({
  title: FORM_TITLE,
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
        title: FORM_TITLE,
        submit_label: FORM_SUBMIT_LABEL,
        interactivity: `{{inputs.${INPUT.interactivity}}}`,
        fields: {
          elements: [
            { name: FIELD.title, title: FIELD_LABELS.title, type: 'string' },
            { name: FIELD.category, title: FIELD_LABELS.category, type: 'string', enum: [...CATEGORIES] },
            { name: FIELD.priority, title: FIELD_LABELS.priority, type: 'string', enum: [...PRIORITIES] },
            { name: FIELD.body, title: FIELD_LABELS.body, type: 'string', long: true },
            {
              name: FIELD.attachments,
              title: FORM_ATTACHMENTS_TITLE,
              type: 'array',
              items: { type: 'slack#/types/file_id' },
              maxItems: MAX_FILES_PER_MESSAGE,
            },
          ],
          required: [FIELD.title, FIELD.category, FIELD.priority, FIELD.body],
        },
      },
    },
    {
      id: '1',
      function_id: 'slack#/functions/send_message',
      inputs: {
        channel_id: `{{inputs.${INPUT.channel}}}`,
        message: renderWorkflowMessage(),
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
    workflows: { [FORM_WORKFLOW_ID]: formWorkflow() },
  }
}
export const renderFormManifest = (): string => JSON.stringify(formManifestObject(), null, 2)

// Slack CLI の trigger create --trigger-def に渡す定義。投稿先は押した場所によらず設定のチャンネルに固定する
export const triggerDefinition = (channel: string): JsonObject => ({
  type: 'shortcut',
  name: FORM_TITLE,
  description: FORM_DESCRIPTION,
  workflow: `#/workflows/${FORM_WORKFLOW_ID}`,
  inputs: {
    [INPUT.interactivity]: { value: '{{data.interactivity}}' },
    [INPUT.channel]: { value: channel },
    [INPUT.user]: { value: '{{data.user_id}}' },
  },
})

export const bookmarkParams = (channel: string, url: string): Record<string, string> => ({
  channel_id: channel,
  title: FORM_TITLE,
  type: 'link',
  link: url,
})
