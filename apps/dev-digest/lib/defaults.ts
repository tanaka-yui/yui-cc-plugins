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
export const EXCERPT_CHARS = 500
export const MAX_MESSAGE_CHARS = 3500
export const FETCH_TIMEOUT_MS = 20000
export const X_MAX_POSTS_LIST = 50
export const X_MAX_POSTS_PER_HASHTAG = 20
export const LAUNCHER_VERSION = 1

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
