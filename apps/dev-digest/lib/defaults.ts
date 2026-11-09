import type { FeedSource } from './config.ts'

// 既定値はここに集める。他のファイルに数値や URL を直接書かない
export const PLUGIN_ID = 'dev-digest@yui-cc-plugins'
export const AUTOMATION_NAME = 'dev-digest'
export const DEFAULT_TIMEZONE = 'Asia/Tokyo'
// `~` は init が実パスに置き換える
export const AUTOMATION_PROMPT =
  'Run `~/.dev-digest/bin/dev-digest procedure` and follow the printed instructions exactly. Never read ~/.dev-digest/secrets.json.'

// jvn-new と jvn-updated は同じ脆弱性（同じ rdf:about）を載せるので storeAs を 'jvn' に揃えて 1 件にする。
// jvn-updated は後から深刻度が上がった項目を拾うために取る
export const BUILTIN_FEEDS: readonly FeedSource[] = [
  {
    id: 'aws-whats-new',
    storeAs: 'aws-whats-new',
    url: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/',
    section: 'aws',
    trackUpdates: false,
    scope: 'global',
  },
  {
    id: 'aws-news-blog',
    storeAs: 'aws-news-blog',
    url: 'https://aws.amazon.com/blogs/aws/feed/',
    section: 'aws',
    trackUpdates: false,
    scope: 'global',
  },
  {
    id: 'gcp-release-notes',
    storeAs: 'gcp-release-notes',
    url: 'https://cloud.google.com/feeds/gcp-release-notes.xml',
    section: 'gcp',
    trackUpdates: true,
    scope: 'global',
  },
  {
    id: 'gcp-blog',
    storeAs: 'gcp-blog',
    url: 'https://cloudblog.withgoogle.com/rss/',
    section: 'gcp',
    trackUpdates: false,
    scope: 'global',
  },
  {
    id: 'devto',
    storeAs: 'devto',
    url: 'https://dev.to/feed',
    section: 'devto',
    trackUpdates: false,
    scope: 'global',
  },
  {
    id: 'jvn-new',
    storeAs: 'jvn',
    url: 'https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf',
    section: 'jvn',
    trackUpdates: false,
    scope: 'global',
  },
  {
    id: 'jvn-updated',
    storeAs: 'jvn',
    url: 'https://jvndb.jvn.jp/ja/rss/jvndb.rdf',
    section: 'jvn',
    trackUpdates: false,
    scope: 'global',
  },
]

// X は collect が取得しない。セクション引きと pending のためだけに持つ（BUILTIN_FEEDS には入れない）
export const X_SOURCE: FeedSource = {
  id: 'x',
  storeAs: 'x',
  url: '',
  section: 'x',
  trackUpdates: false,
  scope: 'global',
}

export const DEFAULT_DEVTO_TAGS = ['aws', 'googlecloud', 'ai', 'security']
export const DEFAULT_X_HASHTAGS = ['#AI', '#LLM', '#生成AI']

export const BASELINE_HOURS = 24
export const MS_PER_HOUR = 3_600_000
export const USER_AGENT = 'dev-digest'
// テスト専用: 設定されていれば取得先の origin をこの値に置き換える
export const FEED_BASE_ENV = 'DEV_DIGEST_FEED_BASE'
// テスト専用: 設定されていれば Webhook URL の origin をこの値に置き換える（path は残す）
export const WEBHOOK_OVERRIDE_ENV = 'DEV_DIGEST_WEBHOOK_OVERRIDE'
// 上の差し替えを受け付ける host（URL.hostname の形）
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]', 'localhost']
export const SECRET_DIR_MODE = 0o700
export const SECRET_FILE_MODE = 0o600
export const X_TITLE_CHARS = 80
export const EXCERPT_CHARS = 500
// 1 回に読むフィードの上限（文字数）。JVN が約 1MB なので余裕を見る
export const MAX_FEED_BYTES = 5_000_000
export const MAX_MESSAGE_CHARS = 3500
export const FETCH_TIMEOUT_MS = 20000
export const X_MAX_POSTS_LIST = 50
export const X_MAX_POSTS_PER_HASHTAG = 20
export const LAUNCHER_VERSION = 1
// ランチャーが子に自分の版を渡す環境変数。bin/dev-digest.ts が LAUNCHER_VERSION と比べる
export const LAUNCHER_VERSION_ENV = 'DEV_DIGEST_LAUNCHER_VERSION'
// テスト専用: 設定されていれば ~/.claude の代わりに使う（user の settings.json と installed_plugins.json の場所）
export const CLAUDE_HOME_ENV = 'DEV_DIGEST_CLAUDE_HOME'
export const LAUNCHER_FILE_MODE = 0o755

// ORCA_BIN と ORCA_CLI_COMMAND が無いときに呼ぶ Orca CLI
export const ORCA_DEFAULT_BIN = 'orca'
export const AUTOMATION_PROVIDER = 'claude'
// 毎朝の Claude が X を読むのに使う Orca のブラウザ系サブコマンド（spec §13）。permission の allow に足す
export const ORCA_BROWSER_SUBCOMMANDS: readonly string[] = ['tab', 'snapshot', 'scroll', 'goto', 'wait', 'get']
// X のハッシュタグの最新順の検索。ハッシュタグを encodeURIComponent して後ろに付け、LIVE_SUFFIX で最新順にする
export const X_SEARCH_URL = 'https://x.com/search?q='
export const X_SEARCH_LIVE_SUFFIX = '&f=live'

export const devtoTagFeed = (tag: string): FeedSource => ({
  id: `devto-tag:${tag}`,
  storeAs: `devto-tag:${tag}`,
  url: `https://dev.to/feed/tag/${tag}`,
  section: 'devto',
  trackUpdates: false,
  scope: 'global',
})

export const releasesFeed = (github: string): FeedSource => ({
  id: `releases:${github}`,
  storeAs: `releases:${github}`,
  url: `https://github.com/${github}/releases.atom`,
  section: 'releases',
  trackUpdates: false,
  scope: 'repo',
})

// set-webhook のダイアログに出す文言。`{target}` を対象（global か owner/repo）に置き換える
export const WEBHOOK_PROMPT_TEMPLATE = '[{target}] の Slack Incoming Webhook URL を貼り付けてください'
export const WEBHOOK_DIALOG_TITLE = 'dev-digest'
export const GLOBAL_TARGET = 'global'
