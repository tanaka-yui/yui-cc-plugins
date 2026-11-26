import {
  BASE_ANY,
  EMPTY_LONG_VALUE,
  FIELD_LABELS,
  FORM_ATTACHMENTS_TITLE,
  FORM_EXTRA_SCOPES,
  FORM_FEATURE_STEPS,
  FORM_KINDS,
  FORM_REPO_FIELD_MIN_REPOS,
  FORM_SUBMIT_LABEL,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  SLACK_APP_NAME,
  SLACK_APP_REDIRECT_URL,
  SLACK_BOT_SCOPES,
  SLACK_CHANNEL_DEEP_LINK,
} from './defaults.ts'
import { BASE_SLOT, REPO_SLOT, REPORTER_SLOT, renderKindMessage } from './form-message.ts'
import { manifestObject } from './guide.ts'
import { asObject } from './json.ts'

import type { JsonObject } from './json.ts'
import type { FormKind } from './types.ts'

// 共通の項目の内部名とワークフローの入力名。表示名は FIELD_LABELS を使う
const FIELD = { title: 'title', priority: 'priority', attachments: 'attachments' }
const INPUT = { interactivity: 'interactivity', channel: 'channel_id', user: 'user_id' }
const FORM_STEP = '0'
const fieldRef = (name: string): string => `{{steps.${FORM_STEP}.fields.${name}}}`
export const renderWorkflowMessage = (kind: FormKind, withRepo: boolean, withBase = false): string =>
  renderKindMessage(
    kind,
    (name) => (name === REPORTER_SLOT ? `<@{{inputs.${INPUT.user}}}>` : fieldRef(name)),
    withRepo,
    withBase,
  )

// 入力は app settings が書き出す形（v1: 名前ごとに type と is_required）で書く。既存のアプリへの deploy では
// Slack CLI がリモートのマニフェストを土台にマージし、_metadata を落として v1 として検証するため、
// v2 の properties / required の形は通らない。題と説明も書き出しと揃え、次の deploy で差分を出さない
const inputParam = (name: string, type: string, title: string): JsonObject => ({
  type,
  name,
  description: '',
  title,
  is_required: true,
})

// open_form で集め、send_message で添付ごと対象チャンネルへ投稿する。どちらも Slack 組み込みの関数。
// branches は向き先の欄の選択肢（formBranches）。空なら欄を出さず、「質問する」には出さない
export const formWorkflow = (
  kind: FormKind,
  repos: readonly string[],
  branches: readonly string[] = [],
): JsonObject => ({
  title: kind.title,
  description: kind.description,
  input_parameters: {
    [INPUT.interactivity]: inputParam(INPUT.interactivity, 'slack#/types/interactivity', 'Interactivity'),
    [INPUT.channel]: inputParam(INPUT.channel, 'slack#/types/channel_id', 'Channel Id'),
    [INPUT.user]: inputParam(INPUT.user, 'slack#/types/user_id', 'User Id'),
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
            ...(kind.titled
              ? [
                  { name: FIELD.title, title: FIELD_LABELS.title, type: 'string' },
                  { name: FIELD.priority, title: FIELD_LABELS.priority, type: 'string', enum: [...PRIORITIES] },
                ]
              : []),
            ...(repos.length >= FORM_REPO_FIELD_MIN_REPOS
              ? [{ name: REPO_SLOT, title: FIELD_LABELS.repo, type: 'string', enum: [...repos] }]
              : []),
            ...(kind.titled && branches.length
              ? [{ name: BASE_SLOT, title: FIELD_LABELS.base, type: 'string', enum: [BASE_ANY, ...branches] }]
              : []),
            ...kind.items.map((item) => ({
              name: item.name,
              title: item.label,
              type: 'string',
              ...(item.options ? { enum: [...item.options] } : {}),
              ...(item.long ? { long: true } : {}),
              ...(item.long && !item.required ? { default: EMPTY_LONG_VALUE } : {}),
            })),
            {
              name: FIELD.attachments,
              title: FORM_ATTACHMENTS_TITLE,
              type: 'array',
              items: { type: 'slack#/types/file_id' },
              maxItems: MAX_FILES_PER_MESSAGE,
            },
          ],
          required: [
            ...(kind.titled ? [FIELD.title, FIELD.priority] : []),
            ...kind.items.filter((i) => i.required).map((i) => i.name),
          ],
        },
      },
    },
    {
      id: '1',
      function_id: 'slack#/functions/send_message',
      inputs: {
        channel_id: `{{inputs.${INPUT.channel}}}`,
        message: renderWorkflowMessage(kind, repos.length >= FORM_REPO_FIELD_MIN_REPOS, branches.length > 0),
        files: fieldRef(FIELD.attachments),
      },
    },
  ],
})

// guide のマニフェストに、フォームのワークフローとボタン用の権限を足す。新規の作成も既存への deploy と同じ v1 で検証させるため _metadata は書かない。workflows を持つアプリは org_deploy_enabled が必須
export const formManifestObject = (repos: readonly string[], branches: readonly string[] = []): JsonObject => {
  const base = manifestObject()
  return {
    ...base,
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES, ...FORM_EXTRA_SCOPES] } },
    settings: { ...(asObject(base.settings) ?? {}), org_deploy_enabled: true },
    workflows: Object.fromEntries(FORM_KINDS.map((kind) => [kind.workflowId, formWorkflow(kind, repos, branches)])),
  }
}
export const renderFormManifest = (repos: readonly string[], branches: readonly string[] = []): string =>
  JSON.stringify(formManifestObject(repos, branches), null, 2)

// Slack CLI の trigger create --trigger-def に渡す定義。投稿先は押した場所によらず設定のチャンネルに固定する
export const triggerDefinition = (channel: string, kind: FormKind): JsonObject => ({
  type: 'shortcut',
  name: kind.title,
  description: kind.description,
  workflow: `#/workflows/${kind.workflowId}`,
  inputs: {
    [INPUT.interactivity]: { value: '{{data.interactivity}}' },
    [INPUT.channel]: { value: channel },
    [INPUT.user]: { value: '{{data.user_id}}' },
  },
})

// ボタンの題を「」で囲んで並べたもの（「バグを報告」「要望を送る」…）。画面での手順や完了の案内に使う
export const formTitles = (): string => FORM_KINDS.map((k) => `「${k.title}」`).join('')
export const channelLink = (channel: string, teamId: string | null): string =>
  `${SLACK_APP_REDIRECT_URL}?channel=${encodeURIComponent(channel)}${teamId ? `&team=${encodeURIComponent(teamId)}` : ''}`
export const channelAppLink = (channel: string, teamId: string): string =>
  `${SLACK_CHANNEL_DEEP_LINK}?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channel)}`
export const featureSteps = (channel: string, teamId: string | null): string =>
  FORM_FEATURE_STEPS.replaceAll('{title}', formTitles())
    .replaceAll('{count}', String(FORM_KINDS.length))
    .replaceAll('{app}', SLACK_APP_NAME)
    .replace('{link}', channelLink(channel, teamId))
    .replace('{appLink}', teamId ? `\n     Slack のアプリで開くなら: ${channelAppLink(channel, teamId)}` : '')

// workflows.featured.add の引数。おすすめにしたワークフローは、チャンネルの入力欄の代わりにボタンとして出る
// （リンクを関連ページに API で足すと、Slack は外部リンクとして扱いブラウザを開いてしまう）
export const featuredParams = (channel: string, triggerIds: readonly string[]): Record<string, string> => ({
  channel_id: channel,
  trigger_ids: triggerIds.join(','),
})
