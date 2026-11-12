import {
  FIELD_LABELS,
  FORM_KINDS,
  PRIORITIES,
  SLACK_APP_NAME,
  SLACK_BOT_SCOPES,
  TEMPLATE_REPORTER_HINT,
  TOKEN_DIALOG_TITLE,
} from './defaults.ts'
import { REPORTER_SLOT, renderKindMessage } from './form-message.ts'

import type { JsonObject } from './json.ts'
import type { FormKind } from './types.ts'
export const manifestObject = (): JsonObject => ({
  display_information: { name: SLACK_APP_NAME },
  features: { bot_user: { display_name: SLACK_APP_NAME, always_online: false } },
  oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
})
export const renderManifest = (): string => JSON.stringify(manifestObject(), null, 2)
// 手で作るワークフローの「チャンネルへメッセージを送信」に入れるテンプレート。{…} にフォームの変数を差し込む
export const renderTemplate = (kind: FormKind): string =>
  renderKindMessage(kind, (name) => {
    if (name === REPORTER_SLOT) return `{${TEMPLATE_REPORTER_HINT}}`
    if (name === 'title') return `{${FIELD_LABELS.title}}`
    if (name === 'priority') return `{${FIELD_LABELS.priority}}`
    return `{${kind.items.find((i) => i.name === name)?.label ?? name}}`
  })
const formSteps = (kind: FormKind): string =>
  [
    `「${kind.title}」`,
    `- ${FIELD_LABELS.title}: 短い回答、必須`,
    `- ${FIELD_LABELS.priority}: リスト選択、必須（${PRIORITIES.join(' / ')}）`,
    ...kind.items.map((i) => `- ${i.label}: ${i.long ? '長い回答' : '短い回答'}、${i.required ? '必須' : '任意'}`),
    `- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。`,
    `「チャンネルへメッセージを送信」のテンプレート:`,
    `\n~~~text\n${renderTemplate(kind)}\n~~~`,
  ].join('\n')
const CLI = 'node bin/slack-issue-intake.ts'
export const renderGuide =
  (): string => `Slack CLI にログインしているなら、この手順の代わりに \`make setup\` を使えます。
1. https://api.slack.com/apps の Create New App → From a manifest で社内向けカスタムアプリを作り、ワークスペースにインストールします。配布しません。有料プランが必要です。
\nマニフェスト:\n\`\`\`json\n${renderManifest()}\n\`\`\`
2. アプリの設定の OAuth & Permissions を開き、Bot User OAuth Token（xoxb- で始まる文字列）をコピーします。続けて \`${CLI} set-token\` を実行します（skill で進めているときは Claude が実行します）。
「${TOKEN_DIALOG_TITLE}」という題の入力ウィンドウが開くので、⌘V で貼り付けて OK を押します。入力欄はパスワード用と同じで、貼った文字は見えません。「saved token=」で始まる行が出れば登録できています。
トークンは Claude との会話やコマンドの引数に書かないでください。会話に貼るとモデルに送られて記録にも残り、引数に書くとシェルの履歴に残ります。ウィンドウが開かず fallback=clipboard と出たときは、トークンをコピーした状態で \`${CLI} set-token --from-clipboard\` を実行します。
3. 対象チャンネルで /invite @${SLACK_APP_NAME} を実行します。
4. Workflow Builder で、チャンネルのボタンから開始するワークフローを、次の${FORM_KINDS.length}つ作ります。それぞれ「フォームで情報を収集」と「チャンネルへメッセージを送信」を追加し、テンプレートの {…} にフォームの変数を差し込みます。添付ファイルの変数も付けます。カテゴリはワークフローごとに決まっているので、フォームでは聞きません。
\n${FORM_KINDS.map(formSteps).join('\n\n')}
\n公開したら、チャンネルの「ワークフロー」タブ →「ワークフローを目立たせる」で${FORM_KINDS.length}つすべてを選び、「注目」を押します。メンバーには入力欄の所にボタンが出ます。
5. チャンネル名 → 詳細の最下部からチャンネルIDを控えます。
6. \`${CLI} init --channel <ID> --repo <owner/name> --every 5\` を実行します。automation は無効で登録されます。
7. \`${CLI} permissions --show\` で内容を確認し、承認してから \`${CLI} permissions --apply\` を実行します。
8. \`${CLI} enable\` を実行します。受け継ぐ許可があれば内容を確認し、承認したときだけ \`--accept-inherited\` を付けます。
Orca の Claude 起動引数へ --permission-mode や --allowedTools など許可を広げるものを入れないでください。
最初の実行で bypass モードになっていないことを確認してください。bypass なら automation を無効にし、既定引数の --dangerously-skip-permissions を外してください。`
