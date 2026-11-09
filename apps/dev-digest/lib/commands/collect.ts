import { die, parseFlags, parseNow } from '../cli.ts'
import { buildSources, loadConfig, loadRepos } from '../config.ts'
import { lastXIngest, openDb, recordFailure, startRun } from '../db.ts'
import { FEED_BASE_ENV, FETCH_TIMEOUT_MS, MAX_FEED_BYTES, USER_AGENT } from '../defaults.ts'
import { parseFeed } from '../feed.ts'
import { ingestFeed } from '../ingest.ts'
import { digestHome, homePaths } from '../paths.ts'

const NAME = 'dev-digest collect'

type Fetched = { ok: true; xml: string } | { ok: false; reason: string }

// テスト専用: 設定されていれば url の origin だけを差し替える（path と query は残す）
const withFeedBase = (url: string): string => {
  const base = process.env[FEED_BASE_ENV]
  if (!base) return url
  const parsed = new URL(url)
  return `${base.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`
}

// 失敗の理由は固定の短い語にする（応答本文は出さない）
const fetchFeed = async (url: string): Promise<Fetched> => {
  try {
    const response = await fetch(withFeedBase(url), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, reason: `http ${response.status}` }
    const xml = await response.text()
    if (xml.length > MAX_FEED_BYTES) return { ok: false, reason: 'too large' }
    return { ok: true, xml }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error' }
  }
}

export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags(NAME, { args: argv, options: { now: { type: 'string' } } })
  const now = parseNow(NAME, values.now)
  const home = digestHome()
  const config = loadConfig(home)
  if (config === null) return die(NAME, '設定がありません。init を先に実行してください')
  const sources = buildSources(config, loadRepos(home))
  const db = openDb(homePaths(home).db)
  try {
    const { runId, previousIncomplete } = startRun(db, now)
    const xSince = lastXIngest(db)
    const fetched = await Promise.all(sources.map(async (source) => ({ source, result: await fetchFeed(source.url) })))
    let added = 0
    let updated = 0
    const failed: string[] = []
    for (const { source, result } of fetched) {
      if (!result.ok) {
        recordFailure(db, runId, source.id, result.reason)
        failed.push(source.id)
        continue
      }
      const counts = ingestFeed(db, source, parseFeed(result.xml), now)
      added += counts.added
      updated += counts.updated
    }
    process.stdout.write(
      `${[
        `run_id=${runId}`,
        `previous_incomplete=${previousIncomplete?.startedAt ?? 'none'}`,
        `x_since=${xSince ?? 'none'}`,
        `new=${added}`,
        `updated=${updated}`,
        `failed=${failed.length > 0 ? failed.join(',') : 'none'}`,
      ].join('\n')}\n`,
    )
  } finally {
    db.close()
  }
}
