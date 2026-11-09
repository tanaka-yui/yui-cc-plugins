import { isFirstFetch, markBaselineGuids, markFeedFetched, upsertItem } from './db.ts'
import { BASELINE_HOURS, MS_PER_HOUR } from './defaults.ts'

import type { Db } from './db.ts'
import type { FeedItem } from './feed.ts'

// 1 回のフィード取得の結果を DB に入れる。collect と ingest-x が共有する。
// そのフィードの初回の取得なら、この回に新規に入った項目のうち cutoff（now - BASELINE_HOURS）より古いものを
// baseline にして送らない。storeAs を共有する別フィードの項目には触れない
export const ingestFeed = (
  db: Db,
  feed: { id: string; storeAs: string; trackUpdates: boolean },
  items: FeedItem[],
  now: string,
): { added: number; updated: number } => {
  const first = isFirstFetch(db, feed.id)
  const added: string[] = []
  let updated = 0
  for (const item of items) {
    const outcome = upsertItem(db, feed.storeAs, item, feed.trackUpdates, now)
    if (outcome === 'new') added.push(item.guid)
    else if (outcome === 'updated') updated++
  }
  if (first) {
    const cutoff = new Date(new Date(now).getTime() - BASELINE_HOURS * MS_PER_HOUR).toISOString()
    markBaselineGuids(db, feed.storeAs, added, cutoff)
    markFeedFetched(db, feed.id, now)
  }
  return { added: added.length, updated }
}
