import {
  CATEGORIES,
  FIELD_LABELS,
  PRIORITIES,
  SLACK_APP_NAME,
  SLACK_BOT_SCOPES,
  SUBMISSION_MARKER,
  TEMPLATE_REPORTER_HINT,
} from './defaults.ts'
export const renderManifest = (): string =>
  JSON.stringify(
    {
      display_information: { name: SLACK_APP_NAME },
      features: { bot_user: { display_name: SLACK_APP_NAME, always_online: false } },
      oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    },
    null,
    2,
  )
export const renderTemplate = (): string =>
  [
    SUBMISSION_MARKER,
    `${FIELD_LABELS.title}: {${FIELD_LABELS.title}}`,
    `${FIELD_LABELS.category}: {${FIELD_LABELS.category}}`,
    `${FIELD_LABELS.priority}: {${FIELD_LABELS.priority}}`,
    `${FIELD_LABELS.reporter}: {${TEMPLATE_REPORTER_HINT}}`,
    `${FIELD_LABELS.body}:`,
    `{${FIELD_LABELS.body}}`,
  ].join('\n')
export const renderGuide =
  (): string => `1. https://api.slack.com/apps の Create New App → From a manifest で社内向けカスタムアプリを作り、ワークスペースにインストールします。配布しません。有料プランが必要です。
\nマニフェスト:\n\`\`\`json\n${renderManifest()}\n\`\`\`
2. Bot User OAuth Token は会話へ貼らず set-token の隠し入力で登録します。
3. 対象チャンネルで /invite @${SLACK_APP_NAME} を実行します。
4. Workflow Builder でチャンネルのボタンから開始するワークフローを作り、「フォームで情報を収集」を追加します。
- ${FIELD_LABELS.title}: 短い回答、必須
- ${FIELD_LABELS.category}: リスト選択、必須（${CATEGORIES.join(' / ')}）
- ${FIELD_LABELS.priority}: リスト選択、必須（${PRIORITIES.join(' / ')}）
- ${FIELD_LABELS.body}: 長い回答、必須
- 添付ファイル: アップロード、任意、複数可。1ファイルだけなら任意のアップロードの質問を3つ並べます。
次に「チャンネルへメッセージを送信」を追加し、以下のテンプレートの {…} にフォームの変数を差し込みます。添付ファイルの変数も付けます。
\n\`\`\`text\n${renderTemplate()}\n\`\`\`
5. チャンネル名 → 詳細の最下部からチャンネルIDを控えます。
6. init --channel <ID> --repo <owner/name> --every 5 を実行します。automation は無効で登録されます。
7. permissions --show で内容を確認し、承認してから permissions --apply を実行します。
8. enable を実行します。受け継ぐ許可があれば内容を確認し、承認したときだけ --accept-inherited を付けます。
Orca の Claude 起動引数へ --permission-mode や --allowedTools など許可を広げるものを入れないでください。
最初の実行で bypass モードになっていないことを確認してください。bypass なら automation を無効にし、既定引数の --dangerously-skip-permissions を外してください。`
