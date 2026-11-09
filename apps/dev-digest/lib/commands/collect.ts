import { die, parseFlags, parseNow } from '../cli.ts'
import { buildSources, loadConfig, loadRepos } from '../config.ts'
import { hasSource, lastXIngest, markBaseline, openDb, recordFailure, startRun, upsertItem } from '../db.ts'
import { BASELINE_HOURS, FETCH_TIMEOUT_MS, MAX_FEED_BYTES } from '../defaults.ts'
import { parseFeed } from '../feed.ts'
import { digestHome, homePaths } from '../paths.ts'

const NAME = 'dev-digest collect'
const USER_AGENT = 'dev-digest'
const FEED_BASE_ENV = 'DEV_DIGEST_FEED_BASE'
const MS_PER_HOUR = 3_600_000

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
    // 初めて見る source は、この回の項目を入れる前に決める（JVN の 2 フィードは 'jvn' を共有する）
    const firstSeen = new Set(sources.map((source) => source.storeAs).filter((storeAs) => !hasSource(db, storeAs)))
    const fetched = await Promise.all(sources.map((source) => fetchFeed(source.url)))
    let added = 0
    let updated = 0
    const failed: string[] = []
    sources.forEach((source, index) => {
      const result = fetched[index]
      if (result === undefined || !result.ok) {
        recordFailure(db, runId, source.id, result === undefined ? 'network error' : result.reason)
        failed.push(source.id)
        return
      }
      for (const item of parseFeed(result.xml)) {
        const outcome = upsertItem(db, source.storeAs, item, source.trackUpdates, now)
        if (outcome === 'new') added++
        else if (outcome === 'updated') updated++
      }
    })
    const cutoff = new Date(new Date(now).getTime() - BASELINE_HOURS * MS_PER_HOUR).toISOString()
    for (const storeAs of firstSeen) markBaseline(db, storeAs, cutoff)
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
