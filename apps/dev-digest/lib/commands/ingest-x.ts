import { die, log, parseFlags, parseNow } from '../cli.ts'
import { hasSource, latestRun, markBaseline, openDb, recordFailure, upsertItem } from '../db.ts'
import { BASELINE_HOURS, X_SOURCE } from '../defaults.ts'
import { asArray, asObject, asString, parseJson } from '../json.ts'
import { digestHome, homePaths } from '../paths.ts'

import { mkdirSync, readFileSync } from 'node:fs'

import type { Db } from '../db.ts'
import type { FeedItem } from '../feed.ts'
import type { Json } from '../json.ts'

const NAME = 'dev-digest ingest-x'
const TITLE_CHARS = 80
const DIR_MODE = 0o700
const MS_PER_HOUR = 3_600_000

// 投稿 1 件を FeedItem にする。id / url が無い、日付が読めないものは null（取り込まない）
const toItem = (value: Json): FeedItem | null => {
  const post = asObject(value)
  if (post === null) return null
  const id = asString(post.id)
  const url = asString(post.url)
  const postedAt = asString(post.postedAt)
  if (!id || !url || postedAt === null) return null
  const date = new Date(postedAt)
  if (Number.isNaN(date.getTime())) return null
  const text = asString(post.text) ?? ''
  return {
    guid: id,
    url,
    title: [...text].slice(0, TITLE_CHARS).join(''),
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
  // 初めての x かどうかは、この回の投稿を入れる前に決める
  const first = !hasSource(db, X_SOURCE.storeAs)
  let added = 0
  for (const post of posts) {
    const item = toItem(post)
    if (item === null) {
      log(NAME, '取り込めない投稿を飛ばしました（id / url / postedAt が不正）')
      continue
    }
    if (upsertItem(db, X_SOURCE.storeAs, item, X_SOURCE.trackUpdates, now) === 'new') added++
  }
  if (first) {
    const cutoff = new Date(new Date(now).getTime() - BASELINE_HOURS * MS_PER_HOUR).toISOString()
    markBaseline(db, X_SOURCE.storeAs, cutoff)
  }
  return added
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
