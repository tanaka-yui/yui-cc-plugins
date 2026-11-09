import { X_SOURCE } from './defaults.ts'
import { contentHash } from './feed.ts'
import { asArray, asString, parseJson } from './json.ts'
import { atLeast, parseSeverity } from './severity.ts'

import { DatabaseSync } from 'node:sqlite'

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { Section } from './config.ts'
import type { FeedItem } from './feed.ts'
import type { Severity } from './severity.ts'

export type Db = DatabaseSync
export type UpsertResult = 'new' | 'updated' | 'unchanged'
export type Destination = 'global' | `repo:${string}`

export type StoredItem = {
  id: number
  revision: number
  sourceId: string
  guid: string
  url: string
  title: string
  summary: string
  author: string | null
  publishedAt: string | null
  severity: Severity | null
  products: string[]
  firstSeenAt: string
  // revision > 1
  updated: boolean
}

export type SearchQuery = {
  text: string | null
  since: string | null
  until: string | null
  sections: Section[]
  repo: string | null
  minSeverity: Severity | null
  limit: number
}

export type SearchHit = StoredItem & { summaryJa: string | null; tags: string[]; deliveredTo: Destination[] }

type Row = Record<string, SQLOutputValue>

// FTS5 の trigram は 3 文字未満の検索語を扱えない
const MIN_MATCH_CHARS = 3

const SCHEMA_V1 = `
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  updated_at TEXT,
  severity TEXT,
  products TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  UNIQUE(source_id, guid)
);
CREATE TABLE notes (
  item_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  summary_ja TEXT NOT NULL,
  tags TEXT NOT NULL,
  group_key TEXT,
  PRIMARY KEY(item_id, revision)
);
CREATE TABLE deliveries (
  item_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(item_id, revision, destination)
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE run_failures (
  run_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE VIRTUAL TABLE items_fts USING fts5(title, summary, summary_ja, tags, products, tokenize='trigram');
`

// フィードごとの「初めて取得できた時刻」。storeAs を共有するフィードも別々に初回を判定するため
const SCHEMA_V2 = `
CREATE TABLE feeds (
  feed_id TEXT PRIMARY KEY,
  first_ok_at TEXT NOT NULL
);
`

const str = (row: Row, key: string): string => {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}
const strOrNull = (row: Row, key: string): string | null => {
  const value = row[key]
  return typeof value === 'string' ? value : null
}
const num = (row: Row, key: string): number => {
  const value = row[key]
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0
}

const stringList = (text: string | null): string[] => {
  const parsed = text === null ? null : parseJson(text)
  return (asArray(parsed ?? undefined) ?? []).map(asString).filter((entry): entry is string => entry !== null)
}

const all = (db: Db, sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params)
const one = (db: Db, sql: string, ...params: SQLInputValue[]): Row | null => db.prepare(sql).get(...params) ?? null

const inTransaction = <T>(db: Db, body: () => T): T => {
  db.exec('BEGIN')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const openDb = (file: string): Db => {
  const db = new DatabaseSync(file)
  const version = num(one(db, 'PRAGMA user_version') ?? {}, 'user_version')
  if (version < 1) {
    inTransaction(db, () => {
      db.exec(SCHEMA_V1)
      db.exec('PRAGMA user_version = 1')
    })
  }
  if (version < 2) {
    inTransaction(db, () => {
      db.exec(SCHEMA_V2)
      db.exec('PRAGMA user_version = 2')
    })
  }
  return db
}

const toStored = (row: Row): StoredItem => ({
  id: num(row, 'id'),
  revision: num(row, 'revision'),
  sourceId: str(row, 'source_id'),
  guid: str(row, 'guid'),
  url: str(row, 'url'),
  title: str(row, 'title'),
  summary: str(row, 'summary'),
  author: strOrNull(row, 'author'),
  publishedAt: strOrNull(row, 'published_at'),
  severity: parseSeverity(str(row, 'severity')),
  products: stringList(strOrNull(row, 'products')),
  firstSeenAt: str(row, 'first_seen_at'),
  updated: num(row, 'revision') > 1,
})

// 検索表は items と現行 revision の notes から作り直す
const refreshFts = (db: Db, itemId: number): void => {
  db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(itemId)
  db.prepare(
    `INSERT INTO items_fts(rowid, title, summary, summary_ja, tags, products)
     SELECT i.id, i.title, i.summary, COALESCE(n.summary_ja, ''), COALESCE(n.tags, ''), i.products
     FROM items i LEFT JOIN notes n ON n.item_id = i.id AND n.revision = i.revision
     WHERE i.id = ?`,
  ).run(itemId)
}

export const upsertItem = (
  db: Db,
  sourceId: string,
  item: FeedItem,
  trackUpdates: boolean,
  now: string,
): UpsertResult => {
  const hash = contentHash(item)
  const products = JSON.stringify(item.products)
  return inTransaction(db, () => {
    const existing = one(
      db,
      'SELECT id, content_hash, severity FROM items WHERE source_id = ? AND guid = ?',
      sourceId,
      item.guid,
    )
    if (existing === null) {
      const result = db
        .prepare(
          `INSERT INTO items(source_id, guid, url, title, summary, author, published_at, updated_at, severity, products,
             content_hash, revision, first_seen_at, last_changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          sourceId,
          item.guid,
          item.url,
          item.title,
          item.summary,
          item.author,
          item.publishedAt,
          item.updatedAt,
          item.severity,
          products,
          hash,
          now,
          now,
        )
      refreshFts(db, Number(result.lastInsertRowid))
      return 'new'
    }
    const id = num(existing, 'id')
    // 深刻度は追跡の有無に関係なく最新の観測値で上書きする。revision は上げない
    if (strOrNull(existing, 'severity') !== item.severity) {
      db.prepare('UPDATE items SET severity = ? WHERE id = ?').run(item.severity, id)
    }
    if (!trackUpdates || str(existing, 'content_hash') === hash) return 'unchanged'
    db.prepare(
      `UPDATE items SET url = ?, title = ?, summary = ?, author = ?, published_at = ?, updated_at = ?, products = ?,
         content_hash = ?, revision = revision + 1, last_changed_at = ? WHERE id = ?`,
    ).run(item.url, item.title, item.summary, item.author, item.publishedAt, item.updatedAt, products, hash, now, id)
    refreshFts(db, id)
    return 'updated'
  })
}

export const hasSource = (db: Db, sourceId: string): boolean =>
  one(db, 'SELECT 1 AS found FROM items WHERE source_id = ? LIMIT 1', sourceId) !== null

export const markBaseline = (db: Db, sourceId: string, cutoff: string): number =>
  Number(
    db
      .prepare('UPDATE items SET baseline = 1 WHERE source_id = ? AND (published_at IS NULL OR published_at < ?)')
      .run(sourceId, cutoff).changes,
  )

export const isFirstFetch = (db: Db, feedId: string): boolean =>
  one(db, 'SELECT 1 AS found FROM feeds WHERE feed_id = ?', feedId) === null

export const markFeedFetched = (db: Db, feedId: string, now: string): void => {
  db.prepare('INSERT OR IGNORE INTO feeds(feed_id, first_ok_at) VALUES (?, ?)').run(feedId, now)
}

// 指定した guid の項目のうち、cutoff より古いもの（日付無しを含む）だけを baseline にする
export const markBaselineGuids = (db: Db, sourceId: string, guids: string[], cutoff: string): void => {
  const statement = db.prepare(
    'UPDATE items SET baseline = 1 WHERE source_id = ? AND guid = ? AND (published_at IS NULL OR published_at < ?)',
  )
  for (const guid of guids) statement.run(sourceId, guid, cutoff)
}

export const startRun = (
  db: Db,
  now: string,
): { runId: number; previousIncomplete: { runId: number; startedAt: string } | null } => {
  const previous = one(db, 'SELECT id, started_at FROM runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1')
  const result = db.prepare('INSERT INTO runs(started_at) VALUES (?)').run(now)
  return {
    runId: Number(result.lastInsertRowid),
    previousIncomplete:
      previous === null ? null : { runId: num(previous, 'id'), startedAt: str(previous, 'started_at') },
  }
}

export const recordFailure = (db: Db, runId: number, sourceId: string, reason: string): void => {
  db.prepare('INSERT INTO run_failures(run_id, source_id, reason) VALUES (?, ?, ?)').run(runId, sourceId, reason)
}

export const runFailures = (db: Db, runId: number): Array<{ sourceId: string; reason: string }> =>
  all(db, 'SELECT source_id, reason FROM run_failures WHERE run_id = ? ORDER BY rowid', runId).map((row) => ({
    sourceId: str(row, 'source_id'),
    reason: str(row, 'reason'),
  }))

export const finishRun = (db: Db, runId: number, now: string): void => {
  db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(now, runId)
}

export const latestRun = (db: Db): { runId: number; startedAt: string; finishedAt: string | null } | null => {
  const row = one(db, 'SELECT id, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 1')
  return row === null
    ? null
    : { runId: num(row, 'id'), startedAt: str(row, 'started_at'), finishedAt: strOrNull(row, 'finished_at') }
}

// X の投稿が最後に取り込まれた時刻
export const lastXIngest = (db: Db): string | null =>
  strOrNull(one(db, 'SELECT MAX(first_seen_at) AS at FROM items WHERE source_id = ?', X_SOURCE.storeAs) ?? {}, 'at')

export const undelivered = (
  db: Db,
  destination: Destination,
  sourceIds: string[],
  since: string | null,
): StoredItem[] => {
  if (sourceIds.length === 0) return []
  const placeholders = sourceIds.map(() => '?').join(', ')
  return all(
    db,
    `SELECT i.* FROM items i
     WHERE i.baseline = 0 AND i.source_id IN (${placeholders})
       AND (? IS NULL OR i.first_seen_at >= ?)
       AND NOT EXISTS (
         SELECT 1 FROM deliveries d WHERE d.item_id = i.id AND d.revision = i.revision AND d.destination = ?)
     ORDER BY i.id`,
    ...sourceIds,
    since,
    since,
    destination,
  ).map(toStored)
}

export const recordDelivery = (
  db: Db,
  rows: Array<{
    itemId: number
    revision: number
    destination: Destination
    status: 'sent' | 'irrelevant'
    runId: number
  }>,
  now: string,
): void => {
  inTransaction(db, () => {
    const statement = db.prepare(
      'INSERT OR REPLACE INTO deliveries(item_id, revision, destination, status, run_id, at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const row of rows) statement.run(row.itemId, row.revision, row.destination, row.status, row.runId, now)
  })
}

export const saveNote = (
  db: Db,
  itemId: number,
  revision: number,
  note: { summaryJa: string; tags: string[]; groupKey: string | null },
): void => {
  inTransaction(db, () => {
    db.prepare(
      'INSERT OR REPLACE INTO notes(item_id, revision, summary_ja, tags, group_key) VALUES (?, ?, ?, ?, ?)',
    ).run(itemId, revision, note.summaryJa, JSON.stringify(note.tags), note.groupKey)
    refreshFts(db, itemId)
  })
}

// 利用者の文字列を FTS5 の文字列リテラルとして安全に渡す
const ftsLiteral = (text: string): string => `"${text.replaceAll('"', '""')}"`

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`)

const isDestination = (value: string): value is Destination => value === 'global' || value.startsWith('repo:')

export const search = (db: Db, query: SearchQuery, sectionOf: (sourceId: string) => Section): SearchHit[] => {
  const where: string[] = []
  const params: SQLInputValue[] = []
  const text = query.text?.trim() ?? ''
  if (text.length >= MIN_MATCH_CHARS) {
    where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)')
    params.push(ftsLiteral(text))
  } else if (text.length > 0) {
    const pattern = `%${escapeLike(text)}%`
    where.push(
      "(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR COALESCE(n.summary_ja, '') LIKE ? ESCAPE '\\')",
    )
    params.push(pattern, pattern, pattern)
  }
  // 日付が無い項目は初めて見た時刻で代用する
  if (query.since !== null) {
    where.push('COALESCE(i.published_at, i.first_seen_at) >= ?')
    params.push(query.since)
  }
  if (query.until !== null) {
    where.push('COALESCE(i.published_at, i.first_seen_at) <= ?')
    params.push(query.until)
  }
  const rows = all(
    db,
    `SELECT i.*, n.summary_ja AS note_summary_ja, n.tags AS note_tags FROM items i
     LEFT JOIN notes n ON n.item_id = i.id AND n.revision = i.revision
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(i.published_at, i.first_seen_at) DESC, i.id DESC`,
    ...params,
  )
  const hits: SearchHit[] = []
  for (const row of rows) {
    const item = toStored(row)
    if (query.sections.length > 0 && !query.sections.includes(sectionOf(item.sourceId))) continue
    if (query.minSeverity !== null && !atLeast(item.severity, query.minSeverity)) continue
    const deliveredTo = all(
      db,
      "SELECT destination FROM deliveries WHERE item_id = ? AND status = 'sent' ORDER BY at, destination",
      item.id,
    )
      .map((delivery) => str(delivery, 'destination'))
      .filter(isDestination)
    if (query.repo !== null && !deliveredTo.includes(`repo:${query.repo}`)) continue
    hits.push({
      ...item,
      summaryJa: strOrNull(row, 'note_summary_ja'),
      tags: stringList(strOrNull(row, 'note_tags')),
      deliveredTo,
    })
    if (hits.length >= query.limit) break
  }
  return hits
}
