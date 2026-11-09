import { die, log, parseFlags, parseNow } from '../cli.ts'
import { latestRun, openDb, recordFailure } from '../db.ts'
import { SNOWFLAKE_EPOCH_MS, SNOWFLAKE_SHIFT, X_SOURCE, X_TITLE_CHARS } from '../defaults.ts'
import { ingestFeed } from '../ingest.ts'
import { asArray, asObject, asString, parseJson } from '../json.ts'
import { digestHome, homePaths } from '../paths.ts'

import { mkdirSync, readFileSync } from 'node:fs'

import type { Db } from '../db.ts'
import type { FeedItem } from '../feed.ts'
import type { Json } from '../json.ts'

const NAME = 'dev-digest ingest-x'
const DIR_MODE = 0o700

const DIGITS = /^\d+$/

// X の id は Snowflake で、上位ビットに投稿時刻を持つ（spec §13）。毎朝の Claude は計算の道具を持たないのでここで求める
const snowflakeDate = (id: string): Date | null =>
  DIGITS.test(id) ? new Date(Number((BigInt(id) >> SNOWFLAKE_SHIFT) + SNOWFLAKE_EPOCH_MS)) : null

// 投稿 1 件を FeedItem にする。id / url が無いもの、日付が読めず id からも求められないものは null（取り込まない）
const toItem = (value: Json): FeedItem | null => {
  const post = asObject(value)
  if (post === null) return null
  const id = asString(post.id)
  const url = asString(post.url)
  if (!id || !url) return null
  const postedAt = asString(post.postedAt)
  const given = postedAt === null ? null : new Date(postedAt)
  const date = given !== null && !Number.isNaN(given.getTime()) ? given : snowflakeDate(id)
  if (date === null || Number.isNaN(date.getTime())) return null
  const text = asString(post.text) ?? ''
  return {
    guid: id,
    url,
    title: [...text].slice(0, X_TITLE_CHARS).join(''),
    summary: text,
    author: asString(post.author),
    publishedAt: date.toISOString(),
    updatedAt: null,
    severity: null,
    products: [],
  }
}

const readPosts = (file: string): Json[] => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return die(NAME, `ファイルを読めません: ${file}`)
  }
  const posts = asArray(asObject(parseJson(text) ?? undefined)?.posts)
  return posts ?? die(NAME, '{ "posts": [...] } の形にしてください')
}

const ingest = (db: Db, posts: Json[], now: string): number => {
  const items: FeedItem[] = []
  for (const post of posts) {
    const item = toItem(post)
    if (item === null) log(NAME, '取り込めない投稿を飛ばしました（id・url が無いか、postedAt も id も時刻にならない）')
    else items.push(item)
  }
  return ingestFeed(db, X_SOURCE, items, now).added
}

export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: { now: { type: 'string' }, file: { type: 'string' }, failed: { type: 'string' } },
  })
  const now = parseNow(NAME, values.now)
  if ((values.file === undefined) === (values.failed === undefined)) {
    die(NAME, '--file <path> か --failed <reason> のどちらか一方を指定してください')
  }
  const home = digestHome()
  mkdirSync(home, { recursive: true, mode: DIR_MODE })
  const db = openDb(homePaths(home).db)
  try {
    if (values.failed !== undefined) {
      const latest = latestRun(db) ?? die(NAME, '実行記録がありません。collect を先に実行してください')
      recordFailure(db, latest.runId, X_SOURCE.id, values.failed)
      process.stdout.write('new=0\n')
      return
    }
    process.stdout.write(`new=${ingest(db, readPosts(values.file ?? ''), now)}\n`)
  } finally {
    db.close()
  }
}
