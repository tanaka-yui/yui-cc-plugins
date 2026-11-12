export const PLUGIN_ID = 'slack-issue-intake@yui-cc-plugins'
export const AUTOMATION_NAME = 'slack-issue-intake'
export const AUTOMATION_PROVIDER = 'claude'
export const AUTOMATION_PROMPT =
  'Run `{{LAUNCHER}} procedure` and follow the printed instructions exactly. Never read {{HOME}}/secrets.json.'
export const DEFAULT_EVERY_MINUTES = 5
// */N が時間の境界でも N 分おきになる値（60 の約数）だけを受け付ける。60 は毎時 0 分
export const ALLOWED_EVERY_MINUTES: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]
export const PRECHECK_TIMEOUT_SECONDS = 60
export const POLL_DEADLINE_MS = 45_000
export const COMMAND_DEADLINE_MS = 600_000
export const FETCH_TIMEOUT_MS = 15_000
export const GH_TIMEOUT_MS = 30_000
// 作成要求を送りうるプロセスがすべて止まっていると初めて確かめてから、照合までに待つ時間（spec 6.10 の前提 2）
export const CREATE_SETTLE_MS = 90_000
// gh issue create のゲート。標準入力から GATE_TOKEN の 1 行を受け取るまで gh を exec しない
export const GATE_SHELL = '/bin/sh'
export const GATE_SCRIPT = 'IFS= read -r go || exit 97; [ "$go" = go ] || exit 97; exec "$0" "$@"'
export const GATE_TOKEN = 'go'
export const GATE_EXIT_CODE = 97
export const POLL_LEASE_MS = 90_000
export const RUN_LEASE_MS = 1_800_000
export const APPLY_LEASE_MS = 600_000
export const ADMIN_LEASE_MS = 300_000
export const SQLITE_BUSY_TIMEOUT_MS = 5_000
export const HISTORY_SLICE_SECONDS = 21_600
export const HISTORY_LAG_SECONDS = 60
export const HISTORY_PAGE_LIMIT = 200
export const ANSWER_TIMEOUT_HOURS = 72
export const MAX_QUESTION_ROUNDS = 2
export const MAX_QUESTIONS_PER_ROUND = 3
export const MAX_ACTION_ATTEMPTS = 10
export const MAX_ITEMS_PER_RUN = 10
export const CREATE_LOOKBACK_MINUTES = 60
export const ISSUE_SCAN_PER_PAGE = 100
export const MAX_FILES_PER_MESSAGE = 10
export const MAX_IMAGE_BYTES = 5_000_000
export const MAX_TEXT_BYTES = 1_000_000
export const IMAGE_MIMETYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const TEXT_MIMETYPE_PREFIX = 'text/'
export const EXTRA_TEXT_MIMETYPES: readonly string[] = ['application/json']
export const USER_NAME_TTL_HOURS = 168
export const SLACK_API_BASE = 'https://slack.com/api'
export const SLACK_FILES_ORIGIN = 'https://files.slack.com'
export const API_BASE_ENV = 'SLACK_ISSUE_INTAKE_API_BASE' // テスト専用。loopback だけ受け付ける
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]', 'localhost']
export const FATAL_SLACK_ERRORS: readonly string[] = [
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'not_in_channel',
  'channel_not_found',
  'missing_scope',
]
export const ERROR_DEADLINE = 'deadline'
export const ERROR_RATELIMITED = 'ratelimited'
export const ERROR_TIMEOUT = 'timeout'
export const ERROR_LEASE_LOST = 'lease lost'
export const ERROR_STATE_CHANGED = 'state changed'
export const ERROR_THREAD_NOT_FOUND = 'thread_not_found'
export const ERROR_CREATE_IN_FLIGHT = 'create in flight'
export const ERROR_CREATE_SETTLING = 'create settling'
export const ERROR_GH_ACCOUNT_CHANGED = 'gh account changed'
export const ERROR_GATE_REFUSED = 'gate refused'
export const SLACK_APP_NAME = 'Issue Intake'
export const SLACK_BOT_SCOPES: readonly string[] = [
  'channels:history',
  'groups:history',
  'chat:write',
  'files:read',
  'users:read',
]
export const SUBMISSION_MARKER = '[issue-intake]'
export const FIELD_LABELS = {
  title: 'タイトル',
  category: 'カテゴリ',
  priority: '優先度',
  reporter: '起票者',
  body: '本文',
} as const
export const TEMPLATE_REPORTER_HINT = 'フォームを送信した人'
// フォーム付きマニフェスト（form --manifest）と、チャンネルにボタンを置く form で使う値
export const FORM_WORKFLOW_ID = 'issue_intake_form'
export const FORM_TITLE = 'Issue を起票' // open_form の題は半角24字（日本語は1字を3と数えて8字）まで
export const FORM_TITLE_MAX_UNITS = 24
export const FORM_FIELD_TITLE_MAX_CHARS = 25
export const FORM_DESCRIPTION = 'GitHub Issue の起票依頼を送ります'
export const FORM_SUBMIT_LABEL = '送信'
export const FORM_ATTACHMENTS_TITLE = '添付ファイル（任意）'
// send_message は channels:read と chat:write.public（無いと Slack がマニフェストを invalid_manifest で拒む）、
// ボタンを使う人のチャンネル参加は channels:join、チャンネルのブックマークは bookmarks:write が要る
// （ボタンの作成は Slack CLI が受け持つので triggers:write は要らない）
export const FORM_EXTRA_SCOPES: readonly string[] = [
  'channels:read',
  'groups:read',
  'chat:write.public',
  'channels:join',
  'bookmarks:write',
]
// ボタンを使えるのは対象チャンネルのメンバーだけにする
export const FORM_META_TRIGGER_ID = 'form_trigger_id'
export const FORM_META_URL = 'form_url'
export const FORM_META_BOOKMARK_ID = 'form_bookmark_id'
export const MSG_FORM_REFUSED =
  'Slack CLI でフォームのボタンを作れませんでした（{error}）。フォームは README の「Workflow Builder で手で作る」の手順で作ってください'
export const MSG_FORM_NO_CLI =
  'Slack CLI が見つかりません。Slack CLI を入れて slack login してから make setup を実行するか、README の「Workflow Builder で手で作る」の手順で作ってください'
export const MSG_FORM_NO_APP =
  'make setup で作ったアプリが見つかりません。フォームは README の「Workflow Builder で手で作る」の手順で作ってください'
export const CATEGORIES = ['バグ', '新機能', '要望'] as const
export const PRIORITIES = ['critical', 'high', 'middle', 'low'] as const
export const CATEGORY_KEYS = { バグ: 'bug', 新機能: 'feature', 要望: 'request' } as const
export const PRIORITY_LABEL_PREFIX = 'priority: '
export const SOURCE_LABEL = 'from-slack'
export const LABEL_SPECS: ReadonlyArray<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: '不具合（Slack のフォームから）' },
  { name: 'feature', color: 'a2eeef', description: '新機能（Slack のフォームから）' },
  { name: 'request', color: 'c5def5', description: '要望（Slack のフォームから）' },
  { name: 'priority: critical', color: 'b60205', description: '優先度 critical' },
  { name: 'priority: high', color: 'd93f0b', description: '優先度 high' },
  { name: 'priority: middle', color: 'fbca04', description: '優先度 middle' },
  { name: 'priority: low', color: '0e8a16', description: '優先度 low' },
  { name: 'from-slack', color: '4a154b', description: 'slack-issue-intake が Slack の投稿から作った Issue' },
]
export const MAX_TITLE_CHARS = 256
export const TITLE_ELLIPSIS = '…'
export const ISSUE_MARKER_PREFIX = 'slack-issue-intake'
export const QUESTION_MAX_CHARS = 2000
export const SUMMARY_MAX_CHARS = 1000
export const DETAILS_MAX_CHARS = 15_000
export const UNRESOLVED_MAX_ITEMS = 10
export const UNRESOLVED_ITEM_MAX_CHARS = 500
export const TITLE_IN_BODY_MAX_CHARS = 1000
export const ORIGINAL_MAX_CHARS = 20_000
export const THREAD_MAX_CHARS = 20_000
export const MAX_LISTED_FILES = 50
export const ISSUE_BODY_MAX_CHARS = 60_000
export const TRUNCATED_NOTE = '…（省略）'
export const MORE_FILES_NOTE = 'ほか {n} 件'
export const ZERO_WIDTH_SPACE = '\u200b'
export const FENCE_SAFE_BACKTICK = '\u02cb' // ˋ。フェンスの中の ``` 以上の並びをこれに置き換える
export const RUNS_DIRNAME = 'runs'
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const WORK_FILE = 'work.json'
export const DECISIONS_FILE = 'decisions.json'
export const RUN_EXACT_SUBCOMMANDS: readonly string[] = ['procedure', 'collect']
export const APPLY_SUBCOMMAND = 'apply --run'
// 作業フォルダで拒む操作（deny はどのスコープの allow より先に評価される）
export const RUN_DENY_RULES: readonly string[] = [
  'WebFetch',
  'WebSearch',
  'Bash(gh *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(git *)',
  'Bash(orca *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(rsync *)',
  'Bash(nc *)',
]
export const PROJECT_PERMISSION_MODE = 'dontAsk'
export const BYPASS_DISABLE_VALUE = 'disable' // permissions.disableBypassPermissionsMode
export const CLAUDE_SETTINGS_FILE = 'settings.json'
export const CLAUDE_LOCAL_SETTINGS_FILE = 'settings.local.json'
export const MANAGED_SETTINGS_FILE = '/Library/Application Support/ClaudeCode/managed-settings.json'
export const MANAGED_SETTINGS_BASENAME = 'managed-settings.json'
export const SETTINGS_FILE_MODE = 0o644
export const SECRET_DIR_MODE = 0o700
export const SECRET_FILE_MODE = 0o600
export const LAUNCHER_VERSION = 1
export const LAUNCHER_VERSION_ENV = 'SLACK_ISSUE_INTAKE_LAUNCHER_VERSION'
export const CLAUDE_HOME_ENV = 'SLACK_ISSUE_INTAKE_CLAUDE_HOME'
export const LAUNCHER_FILE_MODE = 0o755
export const ORCA_DEFAULT_BIN = 'orca'
export const TOKEN_DIALOG_TITLE = 'slack-issue-intake'
export const TOKEN_PROMPT = 'Slack の Bot User OAuth Token（xoxb- で始まるもの）を貼り付けてください'
export const BOT_TOKEN_PATTERN = /^xoxb-[A-Za-z0-9-]+$/
export const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{8,}$/
export const CHANNEL_PAGE_SIZE = 200
export const ERROR_CHANNEL_NOT_FOUND = 'channel_not_found'
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
export const LABEL_WRITE_PERMISSIONS: readonly string[] = ['ADMIN', 'MAINTAIN', 'WRITE']
// Slack に出す固定文言（{url} {problems} {label} {options} を置き換える）
export const MSG_QUESTION_FOOTER = '（このスレッドに返信してください。返信をもとに Issue を作成します）'
export const MSG_CREATED = 'Issue を作成しました: {url}'
export const MSG_CREATED_TIMEOUT = '回答がなかったため、未確認事項を残したまま Issue を作成しました: {url}'
export const MSG_REJECTED =
  'フォームの内容を読み取れませんでした（{problems}）。ワークフローのメッセージのテンプレートを確認してください。'
export const MSG_FAILED = 'Issue の作成に失敗しました。管理者が確認します。'
export const PROBLEM_MISSING = '{label}がありません'
export const PROBLEM_INVALID = '{label}が「{options}」のどれでもありません'
export const PROBLEM_SEPARATOR = '、'
export const ISSUE_HEADINGS = {
  summary: '概要',
  details: '詳細',
  unresolved: '未確認事項',
  info: '起票情報',
  files: '添付ファイル（Slack）',
  original: '元の投稿とスレッド',
} as const
export const ISSUE_TABLE = {
  key: '項目',
  value: '内容',
  category: 'カテゴリ',
  priority: '優先度',
  reporter: '起票者',
  slack: 'Slack',
  source: '元の投稿',
} as const
export const BOT_TRANSCRIPT_NAME = '確認（bot）'
export const UNKNOWN_REPORTER_NAME = '不明'
export const SLACK_REPORTER_SUFFIX = '（Slack）'
export const PERMISSION_ASSUMPTIONS =
  'hook と mod によるツール承認は検査・指紋の対象外です。Orca の Claude 起動引数に --permission-mode や --allowedTools などの許可を広げる指定がないことが前提です。--dangerously-skip-permissions は disableBypassPermissionsMode で拒まれる前提ですが、最初の実行で bypass でないことを確認してください。bypass なら automation を無効にして既定引数から外してください。'

export const PS_PATH = '/bin/ps'
export const PROCESS_PROBE_TIMEOUT_MS = 1000
export const MSG_IDENTITY_UNAVAILABLE = '実行プロセスの身元を確認できません'
export const MSG_BODY_OVERSIZE = 'Issue 本文を上限内に収められません。添付リンクを確認してください'
export const MSG_PUSH_REQUIRED =
  'Issue に重複防止用のラベルを付けるため、リポジトリの push 権限（WRITE 以上）が必要です'
export const MSG_CONFIG_BROKEN = '既存の設定を読めません。config.json を復元してから再実行してください'
export const MSG_CONFIG_CHANGED = '待機中に設定が更新されました。init を再実行してください'
export const MSG_TEST_CLOCK_ONLY = '--now は loopback API を使うテストでのみ指定できます'

export const TRANSIENT_SLACK_ERRORS: readonly string[] = [
  ERROR_RATELIMITED,
  ERROR_DEADLINE,
  'internal_error',
  'fatal_error',
  'request_timeout',
  'service_unavailable',
]
export const TRANSIENT_SLACK_ERROR_PREFIXES: readonly string[] = ['network: ']
export const TRANSIENT_SLACK_HTTP_ERROR = /^http: 5\d\d(?:\b|$)/

export const PROCESS_TIMEZONE = 'UTC'
export const PROCESS_LOCALE = 'C'

// Slack CLI 用のプロジェクト（ホームの隣に置く）とフック
export const SLACK_APP_DIR_SUFFIX = '-slack-app'
export const TRIGGER_DEF_FILE = 'form-trigger.json'
export const MANIFEST_HASH_FILE = 'manifest.sha256'
export const SLACK_HOOK_TOKEN_ENV = 'SLACK_BOT_TOKEN'
export const SLACK_HOOK_COMMAND = 'slack-hook'
export const MSG_HOOK_NO_TOKEN = 'Slack CLI からボットのトークンを受け取れませんでした'

// Slack CLI の呼び出し
export const SLACK_CLI_ENV = 'SLACK_ISSUE_INTAKE_SLACK_CLI' // テスト専用の差し替え
export const SLACK_CLI_STANDARD_PATH: readonly string[] = ['.slack', 'bin', 'slack']
export const SLACK_CLI_FINGERPRINT = 'd41d8cd98f00b204e9800998ecf8427e'
export const SLACK_CLI_LOGGED_OUT_TEXT = 'You are not logged in'
export const SLACK_APP_ENVIRONMENT = 'deployed'
export const SLACK_TOKEN_ENV_NAMES: readonly string[] = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN']
export const SHORTCUT_URL_PATTERN = /https:\/\/[a-z0-9.-]*slack\.com\/shortcuts\/(Ft[0-9A-Z]+)\/[0-9A-Za-z]+/
export const SLACK_CLI_PROBE_TIMEOUT_MS = 10_000
export const SLACK_CLI_TRIGGER_TIMEOUT_MS = 60_000

// セットアップのウィザード（make setup）
export const SETUP_STEPS = 8
export const ERROR_MISSING_SCOPE = 'missing_scope'
export const NODE_MIN_VERSION: readonly number[] = [24, 15]
export const PROMPT_READ_CHUNK = 4096
export const PROMPT_RETRY_MS = 50
export const SETUP_TEXT = {
  stepPrecheck: '事前の確認',
  stepApp: 'Slack アプリを作ってトークンを登録する',
  stepChannel: 'チャンネルを決める',
  stepRepo: 'リポジトリと確認の間隔を決める',
  stepInit: '設定を保存して automation を登録する（init）',
  stepForm: 'フォームのボタンを置く（form）',
  stepPermissions: 'Claude に許す操作を承認する（permissions）',
  stepEnable: 'automation を有効にする（enable）',
  done: '済み',
  noInput: '入力がありません。ターミナルで make setup を実行してください',
  nodeTooOld: 'Node {min} 以上が必要です（今は {current}）。Node を更新してから再実行してください',
  noGh: 'gh が見つかりません。GitHub CLI（https://cli.github.com）を入れてから再実行してください',
  ghLoggedOut: 'gh にログインしていません。gh auth login を実行してから再実行してください',
  noOrca: 'Orca を呼べません（{error}）。Orca を起動して orca コマンドを使えるようにしてから再実行してください',
  noSlackCli:
    'Slack CLI が見つかりません。Slack CLI を入れて slack login してから再実行するか、README の「Slack CLI を使わないセットアップ」で進めてください',
  slackLoggedOut: 'Slack CLI にログインしていません。slack login を実行してから再実行してください',
  deploying: 'Slack CLI でアプリを作成・更新します。ワークスペースを聞かれたら、使うワークスペースを選んでください',
  deployFailed: 'slack deploy に失敗しました（終了コード {code}）。上の出力を確かめてから再実行してください',
  noToken:
    'トークンを受け取れませんでした。Slack のアプリの設定画面（OAuth & Permissions）で Bot User OAuth Token をコピーし、node bin/slack-issue-intake.ts set-token で登録してから、もう一度 make setup を実行してください',
  manualApp: 'トークンは登録済みです。make setup で作ったアプリが無いので、手作業で作ったアプリとして進めます',
  askChannel: 'チャンネル名（#issue-intake の形でも可）またはチャンネル ID',
  channelNotFound:
    'チャンネルが見つかりません。プライベートチャンネルなら、Slack でそのチャンネルに /invite @{app} を送ってから Enter を押してください',
  channelIdOnly:
    'このアプリにはチャンネル名で探す権限がありません。チャンネル ID（チャンネル名を右クリック →「チャンネル詳細を表示」の一番下）を入力してください',
  channelFailed: 'チャンネルを探せません（{error}）',
  joinFailed: 'チャンネルに参加できません（{error}）。Slack で /invite @{app} を送ってから再実行してください',
  channelChosen: 'チャンネル: #{name}（{id}）',
  askRepo: 'GitHub のリポジトリ（owner/name）',
  badRepo: 'owner/name の形で入力してください',
  repoFailed: 'リポジトリを確かめられません（{error}）',
  noIssues: 'リポジトリの Issues が無効です。GitHub の Settings で Issues を有効にしてから再実行してください',
  publicRepo:
    '公開リポジトリです。Slack に送られた内容（本文・添付のリンク）が Issue として誰でも見られる形で公開されます',
  confirmPublic: 'この公開リポジトリに起票しますか？',
  askEvery: '確認の間隔（分。60 の約数）',
  badEvery: '60 の約数（1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60）を入力してください',
  declined:
    '承認されなかったので、この段では何も変えずに止めました。もう一度 make setup を実行すると、ここから再開します',
  manualForm: 'フォームのボタンは作りません。README の「Workflow Builder で手で作る」の手順でフォームを作ってください',
  confirmPermissions: 'この内容で許可しますか？',
  inheritedHeader: '次の許可は、ユーザーや組織の設定から無人の Claude にも受け継がれます:',
  confirmInherited: 'これらの許可を受け継いだまま有効にしますか？',
  noInherited: '権限の設定を読めません。~/.claude/settings.json を確かめてから再実行してください',
  finished:
    'セットアップが終わりました。チャンネルのブックマーク「{title}」から1件送り、数分後に node bin/slack-issue-intake.ts inspect --raw で受け付けたことを確かめてください',
} as const
