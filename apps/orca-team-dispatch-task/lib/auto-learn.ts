import { autoDir } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, type Json, type JsonObject } from './json.ts'

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 判定の学びのデータ（auto/<name>/learn/ の下）と、その上の純粋な計算。
// 履歴・規則・知らせの 3 ファイルを読み書きし、食い違いの抽出・似た事例の選択・規則の文の検査をする。
export const LEARN_DIR = 'learn'
export const LEARN_FILES = { history: 'history.json', rules: 'rules.json', notices: 'notices.json' } as const
// 振り返りを始めるのに要る、まだ振り返っていない食い違いの件数
export const LEARN_REFLECT_MIN = 3
// auto 向きの規則が持つ様子見の件数
export const LEARN_PROBATION = 3
// 1 リポジトリが持てる有効な規則の上限
export const LEARN_RULES_MAX = 20
// 判定に添える似た事例の件数
export const LEARN_CASES_MAX = 5
// リポジトリごとに持つ履歴の件数
export const LEARN_HISTORY_MAX = 500
// 規則の対象を表す文の文字数の上限
export const LEARN_TOPIC_MAX = 80
// 端末に残す知らせの件数
export const LEARN_NOTICES_MAX = 50

const FILE_VERSION = 1
const ROUTES = ['auto', 'eng'] as const
const OUTCOMES = ['merged-ai', 'merged-human', 'failed', 'failed-env', 'stopped', 'eng-kept', 'eng-returned'] as const
const RULE_STATUSES = ['active', 'withdrawn'] as const
const NOTICE_KINDS = ['new', 'support', 'withdrawn', 'graduated', 'global-issue', 'global-pr', 'global-hint'] as const
// 規則の文に入れてはいけない文字列（小文字で比べる）
const TOPIC_URL_PREFIXES = ['http://', 'https://']
const TOPIC_BACKTICK = '`'
const TOPIC_NEWLINE = /[\r\n]/
// 題名の語に分けるときの、英数字の並びと、それ以外の文字（日本語など）の並び
const ASCII_WORD = /[A-Za-z0-9]+/g
const OTHER_WORD = /[\p{L}\p{N}]+/gu
const BIGRAM_SIZE = 2
// 題名の語とラベルの語が互いに一致しないようにする前置き
const TITLE_WORD_PREFIX = 'title:'
const LABEL_WORD_PREFIX = 'label:'

export type Route = (typeof ROUTES)[number]
export type Outcome = (typeof OUTCOMES)[number]
export type HistoryRow = {
  key: string
  repo: string
  generation: number
  title: string
  labels: string[]
  aiRoute: Route
  route: Route
  forced: string
  reason: string
  autoReady: boolean
  started: boolean
  ruleIds: string[]
  outcome: Outcome
  at: string
  reflected: boolean
}
export type Rule = {
  id: string
  repo: string
  direction: Route
  topic: string
  evidence: string[]
  createdAt: string
  probationLeft: number
  status: (typeof RULE_STATUSES)[number]
  withdrawnWhy: string
  global: { issue: string; prNotified: boolean } | null
}
export type NoticeKind = (typeof NOTICE_KINDS)[number]
export type NoticeItem = {
  n: number
  kind: NoticeKind
  ruleId: string
  direction: Route
  text: string
  evidence: string[]
  url: string
}
export type Notice = { id: number; repo: string; at: string; items: NoticeItem[] }
export type Mismatch = {
  id: string
  kind: 'cautious' | 'aggressive'
  key: string
  title: string
  labels: string[]
  reason: string
  outcome: Outcome
}
export type LearnStore = { rules: Rule[]; nextRule: number; nextNotice: number }

export const learnDir = (name: string): string => join(autoDir(name), LEARN_DIR)

const broken = (file: string): Error => new Error(`状態ファイルが壊れています: ${LEARN_DIR}/${file}`)
const unwritable = (file: string): Error => new Error(`状態ファイルを書けません: ${LEARN_DIR}/${file}`)

const strings = (value: Json | undefined): string[] | null => {
  const array = asArray(value)
  if (array === null) return null
  const result: string[] = []
  for (const item of array) {
    const text = asString(item)
    if (text === null) return null
    result.push(text)
  }
  return result
}
const route = (value: Json | undefined): Route | null => ROUTES.find((item) => item === value) ?? null
const outcome = (value: Json | undefined): Outcome | null => OUTCOMES.find((item) => item === value) ?? null
const count = (value: Json | undefined): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

const parseHistoryRow = (value: Json): HistoryRow | null => {
  const row = asObject(value)
  if (row === null) return null
  const key = asString(row.key)
  const repo = asString(row.repo)
  const generation = count(row.generation)
  const title = asString(row.title)
  const labels = strings(row.labels)
  const aiRoute = route(row.aiRoute)
  const effective = route(row.route)
  const forced = asString(row.forced)
  const reason = asString(row.reason)
  const ruleIds = strings(row.ruleIds)
  const result = outcome(row.outcome)
  const at = asString(row.at)
  if (
    key === null ||
    repo === null ||
    generation === null ||
    title === null ||
    labels === null ||
    aiRoute === null ||
    effective === null ||
    forced === null ||
    reason === null ||
    typeof row.autoReady !== 'boolean' ||
    typeof row.started !== 'boolean' ||
    ruleIds === null ||
    result === null ||
    at === null ||
    typeof row.reflected !== 'boolean'
  )
    return null
  return {
    key,
    repo,
    generation,
    title,
    labels,
    aiRoute,
    route: effective,
    forced,
    reason,
    autoReady: row.autoReady,
    started: row.started,
    ruleIds,
    outcome: result,
    at,
    reflected: row.reflected,
  }
}

const parseRule = (value: Json): Rule | null => {
  const rule = asObject(value)
  if (rule === null) return null
  const id = asString(rule.id)
  const repo = asString(rule.repo)
  const direction = route(rule.direction)
  const topic = asString(rule.topic)
  const evidence = strings(rule.evidence)
  const createdAt = asString(rule.createdAt)
  const probationLeft = count(rule.probationLeft)
  const status = RULE_STATUSES.find((item) => item === rule.status) ?? null
  const withdrawnWhy = asString(rule.withdrawnWhy)
  if (
    id === null ||
    repo === null ||
    direction === null ||
    topic === null ||
    evidence === null ||
    createdAt === null ||
    probationLeft === null ||
    status === null ||
    withdrawnWhy === null
  )
    return null
  let global: Rule['global'] = null
  if (rule.global !== null) {
    const entry = asObject(rule.global)
    const issue = asString(entry?.issue)
    if (entry === null || issue === null || typeof entry.prNotified !== 'boolean') return null
    global = { issue, prNotified: entry.prNotified }
  }
  return { id, repo, direction, topic, evidence, createdAt, probationLeft, status, withdrawnWhy, global }
}

const parseNoticeItem = (value: Json): NoticeItem | null => {
  const item = asObject(value)
  if (item === null) return null
  const n = count(item.n)
  const kind = NOTICE_KINDS.find((entry) => entry === item.kind) ?? null
  const ruleId = asString(item.ruleId)
  const direction = route(item.direction)
  const text = asString(item.text)
  const evidence = strings(item.evidence)
  const url = asString(item.url)
  if (
    n === null ||
    kind === null ||
    ruleId === null ||
    direction === null ||
    text === null ||
    evidence === null ||
    url === null
  )
    return null
  return { n, kind, ruleId, direction, text, evidence, url }
}

const parseNotice = (value: Json): Notice | null => {
  const notice = asObject(value)
  if (notice === null) return null
  const id = count(notice.id)
  const repo = asString(notice.repo)
  const at = asString(notice.at)
  const list = asArray(notice.items)
  if (id === null || repo === null || at === null || list === null) return null
  const items: NoticeItem[] = []
  for (const entry of list) {
    const item = parseNoticeItem(entry)
    if (item === null) return null
    items.push(item)
  }
  return { id, repo, at, items }
}

// 無ければ undefined。あるのに読めない・版が違うなら壊れているとして投げる
const readLearnFile = (name: string, file: string): JsonObject | undefined => {
  const path = join(learnDir(name), file)
  if (!existsSync(path)) return undefined
  const value = asObject(readJson(path))
  if (value === null || value.version !== FILE_VERSION) throw broken(file)
  return value
}

const parseAll = <T>(value: Json | undefined, parse: (item: Json) => T | null, file: string): T[] => {
  const list = asArray(value)
  if (list === null) throw broken(file)
  return list.map((item) => {
    const parsed = parse(item)
    if (parsed === null) throw broken(file)
    return parsed
  })
}

const writeLearnFile = (name: string, file: string, body: JsonObject): void => {
  mkdirSync(learnDir(name), { recursive: true })
  if (!writeAtomic(join(learnDir(name), file), JSON.stringify({ version: FILE_VERSION, ...body })))
    throw unwritable(file)
}

export const readHistory = (name: string): HistoryRow[] => {
  const value = readLearnFile(name, LEARN_FILES.history)
  return value === undefined ? [] : parseAll(value.rows, parseHistoryRow, LEARN_FILES.history)
}

// リポジトリごとに、並びの後ろ（新しい方）から LEARN_HISTORY_MAX 件だけ残す。リポジトリの間の並びは保つ
export const writeHistory = (name: string, rows: HistoryRow[]): void => {
  const seen = new Map<string, number>()
  const kept: HistoryRow[] = []
  for (const row of rows.toReversed()) {
    const used = seen.get(row.repo) ?? 0
    seen.set(row.repo, used + 1)
    if (used < LEARN_HISTORY_MAX) kept.push(row)
  }
  writeLearnFile(name, LEARN_FILES.history, { rows: kept.reverse() })
}

export const readStore = (name: string): LearnStore => {
  const value = readLearnFile(name, LEARN_FILES.rules)
  if (value === undefined) return { rules: [], nextRule: 1, nextNotice: 1 }
  const nextRule = count(value.nextRule)
  const nextNotice = count(value.nextNotice)
  if (nextRule === null || nextNotice === null) throw broken(LEARN_FILES.rules)
  return { rules: parseAll(value.rules, parseRule, LEARN_FILES.rules), nextRule, nextNotice }
}

export const writeStore = (name: string, store: LearnStore): void =>
  writeLearnFile(name, LEARN_FILES.rules, {
    nextRule: store.nextRule,
    nextNotice: store.nextNotice,
    rules: store.rules,
  })

export const readNotices = (name: string): Notice[] => {
  const value = readLearnFile(name, LEARN_FILES.notices)
  return value === undefined ? [] : parseAll(value.notices, parseNotice, LEARN_FILES.notices)
}

// store.nextNotice を id にして進める。store の保存は呼び出し側（writeStore）の仕事
export const appendNotice = (
  name: string,
  store: LearnStore,
  repo: string,
  items: Omit<NoticeItem, 'n'>[],
  at: string,
): Notice => {
  const notice: Notice = {
    id: store.nextNotice,
    repo,
    at,
    items: items.map((item, index) => ({ ...item, n: index + 1 })),
  }
  const notices = [...readNotices(name), notice].slice(-LEARN_NOTICES_MAX)
  writeLearnFile(name, LEARN_FILES.notices, { notices })
  store.nextNotice += 1
  for (const item of notice.items) console.log(`学び: ${repo} [${item.kind}] ${item.text}`)
  return notice
}

const isMerged = (row: HistoryRow): boolean => row.outcome === 'merged-ai' || row.outcome === 'merged-human'

// 判定が食い違った行。慎重すぎた（エンジニア行きを人が自動に戻し、そのあと merge された）と
// 攻めすぎた（自動の判定が失敗、または動き出したあとに止められた）。CLI が向きを変えた行・環境の失敗・振り返り済みの行は返さない
export const mismatchesOf = (rows: HistoryRow[], repo: string): Mismatch[] => {
  const own = rows.filter((row) => row.repo === repo)
  const found: Mismatch[] = []
  for (const row of own) {
    if (row.reflected) continue
    if (row.aiRoute === 'eng' && row.forced === '' && row.outcome === 'eng-returned') {
      const next = own.find((item) => item.key === row.key && item.generation === row.generation + 1)
      if (next !== undefined && isMerged(next))
        found.push({
          id: `${row.key}@${row.generation}`,
          kind: 'cautious',
          key: row.key,
          title: row.title,
          labels: row.labels,
          reason: row.reason,
          outcome: next.outcome,
        })
    } else if (
      row.aiRoute === 'auto' &&
      row.forced === '' &&
      (row.outcome === 'failed' || (row.outcome === 'stopped' && (row.autoReady || row.started)))
    )
      found.push({
        id: `${row.key}@${row.generation}`,
        kind: 'aggressive',
        key: row.key,
        title: row.title,
        labels: row.labels,
        reason: row.reason,
        outcome: row.outcome,
      })
  }
  return found
}

export const activeRules = (store: LearnStore, repo: string): Rule[] =>
  store.rules.filter((rule) => rule.repo === repo && rule.status === 'active')

// 題名は英数字の並びと、それ以外の文字の 2 文字ずつ。ラベルは名前そのまま 1 語
const wordsOf = (title: string, labels: string[]): Set<string> => {
  const words = new Set<string>()
  for (const word of title.match(ASCII_WORD) ?? []) words.add(TITLE_WORD_PREFIX + word)
  for (const run of title.replace(ASCII_WORD, ' ').match(OTHER_WORD) ?? []) {
    const characters = Array.from(run)
    for (let index = 0; index + BIGRAM_SIZE <= characters.length; index++)
      words.add(TITLE_WORD_PREFIX + characters.slice(index, index + BIGRAM_SIZE).join(''))
  }
  for (const label of labels) words.add(LABEL_WORD_PREFIX + label)
  return words
}

// 似た事例の選び方はこの関数だけに閉じる（あとで別の方法に差し替えるため）
export const similarCases = (
  rows: HistoryRow[],
  repo: string,
  title: string,
  labels: string[],
  limit = LEARN_CASES_MAX,
): Array<{ title: string; route: Route; outcome: Outcome }> => {
  const target = wordsOf(title, labels)
  return rows
    .filter((row) => row.repo === repo)
    .map((row) => ({ row, overlap: [...wordsOf(row.title, row.labels)].filter((word) => target.has(word)).length }))
    .filter((entry) => entry.overlap >= 1)
    .sort((a, b) => b.overlap - a.overlap || (a.row.at < b.row.at ? 1 : a.row.at > b.row.at ? -1 : 0))
    .slice(0, limit)
    .map(({ row }) => ({ title: row.title, route: row.route, outcome: row.outcome }))
}

// 規則の対象を表す文として使えないときの理由（日本語の 1 行）。問題が無ければ ''
export const topicProblem = (topic: string): string => {
  if (topic.trim() === '') return '対象の文が空です'
  if (Array.from(topic).length > LEARN_TOPIC_MAX) return `対象の文が ${LEARN_TOPIC_MAX} 文字を超えています`
  if (TOPIC_NEWLINE.test(topic)) return '対象の文に改行は使えません'
  if (topic.includes(TOPIC_BACKTICK)) return '対象の文にバッククォートは使えません'
  const lower = topic.toLowerCase()
  if (TOPIC_URL_PREFIXES.some((prefix) => lower.includes(prefix))) return '対象の文に URL は使えません'
  return ''
}
