import { BASE_LABEL_PREFIX } from './auto-base.ts'
import { autoDir, autoNow } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, type Json, type JsonObject } from './json.ts'
import { MANAGED_LABELS, STATUS_LABELS } from './status.ts'

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { IssueState } from './auto-state.ts'

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
export const ROUTES = ['auto', 'eng'] as const
const OUTCOMES = ['merged-ai', 'merged-human', 'failed', 'failed-env', 'stopped', 'eng-kept', 'eng-returned'] as const
const RULE_STATUSES = ['active', 'withdrawn'] as const
const NOTICE_KINDS = ['new', 'support', 'withdrawn', 'graduated', 'global-issue', 'global-pr', 'global-hint'] as const
// 規則の文に入れてはいけない文字列（小文字で比べる）
const TOPIC_URL_PREFIXES = ['http://', 'https://']
const TOPIC_BACKTICK = '`'
const TOPIC_NEWLINE = /[\r\n]/
// 制御文字（Unicode の Cc）と行・段落の区切り文字。規則の文は後の判定の材料に入るので通さない
const TOPIC_CONTROL = /[\p{Cc}\u2028\u2029]/u
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

// 中身を表さないラベル（ステータス・管理の印・向き先）。似た事例がこれで一致しないよう、行に入れない
const contentLabels = (labels: string[]): string[] =>
  labels.filter(
    (label) =>
      !STATUS_LABELS.some((status) => status.name === label) &&
      !MANAGED_LABELS.some((managed) => managed === label) &&
      !label.toLowerCase().startsWith(BASE_LABEL_PREFIX),
  )

// 判定のある世代の結果を履歴に 1 行足し、記録済みにする。判定が無い・記録済みなら何もしない。
// 履歴を読めない・書けないときは 1 行出して false（tick を止めない）。状態の保存は呼び出し側の仕事
export const recordOutcome = (
  name: string,
  issue: IssueState,
  labels: string[],
  result: Outcome,
  at: string,
): boolean => {
  const learn = issue.learn
  if (learn === null || learn.recorded) return false
  const row: HistoryRow = {
    key: issue.key,
    repo: issue.repo,
    generation: issue.generation,
    title: issue.title,
    labels: contentLabels(labels),
    aiRoute: learn.aiRoute,
    route: issue.phase === 'eng' || result.startsWith('eng-') ? 'eng' : 'auto',
    forced: learn.forced,
    reason: issue.reason,
    autoReady: issue.autoReady,
    started: issue.startedAt !== null,
    ruleIds: learn.ruleIds,
    outcome: result,
    at,
    reflected: false,
  }
  try {
    writeHistory(name, [...readHistory(name), row])
  } catch (error) {
    console.log(`判定の履歴を書けません: ${issue.key}（${error instanceof Error ? error.message : String(error)}）`)
    return false
  }
  learn.recorded = true
  return true
}

// 世代が終わった箇所から呼ぶ口。auto-queue / auto-transition は name を持たないので、これを引数で受ける
export type EndRecorder = (issue: IssueState, outcome: Outcome, labels: string[]) => void
export const endRecorder =
  (name: string): EndRecorder =>
  (issue, result, labels) => {
    recordOutcome(name, issue, labels, result, autoNow())
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
  if (TOPIC_CONTROL.test(topic)) return '対象の文に制御文字や区切り文字は使えません'
  if (topic.includes(TOPIC_BACKTICK)) return '対象の文にバッククォートは使えません'
  const lower = topic.toLowerCase()
  if (TOPIC_URL_PREFIXES.some((prefix) => lower.includes(prefix))) return '対象の文に URL は使えません'
  return ''
}

// 振り返りが要るリポジトリ（まだ振り返っていない食い違いが LEARN_REFLECT_MIN 件以上）。
// tick が AI を起こすかと、judge-list の reflect は、必ずこれを同じ引数で呼ぶ（食い違うと AI を起こしても何も無い）
export const reflectDue = (rows: HistoryRow[], repos: string[]): string[] =>
  [...new Set(repos)].filter((repo) => mismatchesOf(rows, repo).length >= LEARN_REFLECT_MIN)

export type LearnedRule = { id: string; direction: Route; topic: string; probation: boolean }
export type Learned = { rules: LearnedRule[]; cases: Array<{ title: string; route: Route; outcome: Outcome }> }
export type Reflection = {
  repo: string
  mismatches: Mismatch[]
  rules: Array<{ id: string; direction: Route; topic: string; evidence: string[] }>
}

// judge-list が Issue ごとに添える材料。様子見は auto 向きで残りがある規則だけ
export const learnedFor = (
  store: LearnStore,
  rows: HistoryRow[],
  repo: string,
  title: string,
  labels: string[],
): Learned => ({
  rules: activeRules(store, repo).map((rule) => ({
    id: rule.id,
    direction: rule.direction,
    topic: rule.topic,
    probation: rule.direction === 'auto' && rule.probationLeft > 0,
  })),
  cases: similarCases(rows, repo, title, labels),
})

export const reflectionsOf = (store: LearnStore, rows: HistoryRow[], repos: string[]): Reflection[] =>
  reflectDue(rows, repos).map((repo) => ({
    repo,
    mismatches: mismatchesOf(rows, repo),
    rules: activeRules(store, repo).map((rule) => ({
      id: rule.id,
      direction: rule.direction,
      topic: rule.topic,
      evidence: rule.evidence,
    })),
  }))

// judge-list が残した judge/pending.json から、judge-apply が「見せたもの」を読む。
// 無い・読めない部分は「何も見せていない」とみなす（judge-list を経ずに渡された判定結果も同じ）
export type Shown = {
  reflect: Array<{ repo: string; mismatches: Mismatch[] }>
  rules: (key: string, generation: number) => LearnedRule[]
}
const MISMATCH_KINDS = ['cautious', 'aggressive'] as const
const parseMismatch = (value: Json): Mismatch | null => {
  const item = asObject(value)
  if (item === null) return null
  const id = asString(item.id)
  const kind = MISMATCH_KINDS.find((entry) => entry === item.kind) ?? null
  const key = asString(item.key)
  const title = asString(item.title)
  const labels = strings(item.labels)
  const reason = asString(item.reason)
  const result = outcome(item.outcome)
  if (
    id === null ||
    kind === null ||
    key === null ||
    title === null ||
    labels === null ||
    reason === null ||
    result === null
  )
    return null
  return { id, kind, key, title, labels, reason, outcome: result }
}
const parseLearnedRule = (value: Json): LearnedRule | null => {
  const item = asObject(value)
  const id = asString(item?.id)
  const direction = route(item?.direction)
  const topic = asString(item?.topic)
  if (item === null || id === null || direction === null || topic === null || typeof item.probation !== 'boolean')
    return null
  return { id, direction, topic, probation: item.probation }
}
const parseList = <T>(value: Json | undefined, parse: (item: Json) => T | null): T[] =>
  (asArray(value) ?? []).flatMap((item) => {
    const parsed = parse(item)
    return parsed === null ? [] : [parsed]
  })
export const shownOf = (pending: Json | null): Shown => {
  const root = asObject(pending ?? undefined)
  const reflect = parseList(root?.reflect, (value) => {
    const entry = asObject(value)
    const repo = asString(entry?.repo)
    return repo === null ? null : { repo, mismatches: parseList(entry?.mismatches, parseMismatch) }
  })
  const rules = new Map<string, LearnedRule[]>()
  for (const value of asArray(root?.issues) ?? []) {
    const issue = asObject(value)
    const key = asString(issue?.key)
    const generation = count(issue?.generation)
    if (key !== null && generation !== null)
      rules.set(`${key}@${generation}`, parseList(asObject(issue?.learned)?.rules, parseLearnedRule))
  }
  return { reflect, rules: (key, generation) => rules.get(`${key}@${generation}`) ?? [] }
}

// 判定の行の rules（auto にした理由で頼った auto 向きの規則の id）。受け付けられなければ理由の 1 行を返す。
// 様子見の規則を見せたのに rules が無い行は断る（書き忘れで様子見を素通りさせないため）
export const decisionRuleIds = (value: Json | undefined, shown: LearnedRule[]): string[] | string => {
  if (value === undefined)
    return shown.some((rule) => rule.probation) ? '様子見の規則を見せた Issue には rules が要ります' : []
  const ids = strings(value)
  if (ids === null) return 'rules は文字列の配列にしてください'
  const unknown = ids.filter((id) => !shown.some((rule) => rule.id === id && rule.direction === 'auto'))
  if (unknown.length > 0) return `rules にこの Issue に見せた auto 向きの規則でない id があります: ${unknown.join(' ')}`
  return [...new Set(ids)]
}

// 振り返りの案。kind ごとに検査と保存をする。知らない kind は捨てる（kind は今後増える）
type LearnContext = { store: LearnStore; material: Map<string, Set<string>>; at: string }
type Accepted = { repo: string; item: Omit<NoticeItem, 'n'> }
const WITHDRAWN_BY_REFLECTION = '振り返りで取り下げ'
const ADD_EVIDENCE_MIN = 2
const SUPPORT_EVIDENCE_MIN = 1

// repo が振り返りの材料に出たリポジトリか。出ていればその食い違いの id を返す
const materialOf = (proposal: JsonObject, context: LearnContext): { repo: string; ids: Set<string> } | string => {
  const repo = asString(proposal.repo)
  if (repo === null) return 'repo がありません'
  const ids = context.material.get(repo)
  return ids === undefined ? `${repo} は振り返りの材料にありません` : { repo, ids }
}
const evidenceOf = (value: Json | undefined, ids: Set<string>, min: number): string[] | string => {
  const list = strings(value)
  if (list === null) return 'evidence は文字列の配列にしてください'
  const unique = [...new Set(list)]
  if (unique.length < min) return `evidence は異なる食い違いを ${min} 件以上にしてください`
  const unknown = unique.filter((id) => !ids.has(id))
  return unknown.length > 0 ? `evidence に材料に無い食い違いがあります: ${unknown.join(' ')}` : unique
}
const ruleOf = (proposal: JsonObject, repo: string, context: LearnContext): Rule | string => {
  const id = asString(proposal.ruleId)
  const found = id === null ? undefined : activeRules(context.store, repo).find((rule) => rule.id === id)
  return found ?? `ruleId が ${repo} の有効な規則ではありません`
}

const proposeAdd = (proposal: JsonObject, context: LearnContext): Accepted | string => {
  const material = materialOf(proposal, context)
  if (typeof material === 'string') return material
  const direction = route(proposal.direction)
  if (direction === null) return 'direction は auto か eng にしてください'
  const topic = asString(proposal.topic)
  if (topic === null) return 'topic がありません'
  const problem = topicProblem(topic)
  if (problem !== '') return problem
  const evidence = evidenceOf(proposal.evidence, material.ids, ADD_EVIDENCE_MIN)
  if (typeof evidence === 'string') return evidence
  if (activeRules(context.store, material.repo).length >= LEARN_RULES_MAX)
    return `${material.repo} の有効な規則が上限の ${LEARN_RULES_MAX} 件に達しています`
  const rule: Rule = {
    id: `r${context.store.nextRule}`,
    repo: material.repo,
    direction,
    topic,
    evidence,
    createdAt: context.at,
    probationLeft: direction === 'auto' ? LEARN_PROBATION : 0,
    status: 'active',
    withdrawnWhy: '',
    global: null,
  }
  context.store.nextRule += 1
  context.store.rules.push(rule)
  return { repo: rule.repo, item: { kind: 'new', ruleId: rule.id, direction, text: topic, evidence, url: '' } }
}

const proposeSupport = (proposal: JsonObject, context: LearnContext): Accepted | string => {
  const material = materialOf(proposal, context)
  if (typeof material === 'string') return material
  const rule = ruleOf(proposal, material.repo, context)
  if (typeof rule === 'string') return rule
  const evidence = evidenceOf(proposal.evidence, material.ids, SUPPORT_EVIDENCE_MIN)
  if (typeof evidence === 'string') return evidence
  rule.evidence = [...new Set([...rule.evidence, ...evidence])]
  return {
    repo: rule.repo,
    item: {
      kind: 'support',
      ruleId: rule.id,
      direction: rule.direction,
      text: rule.topic,
      evidence: rule.evidence,
      url: '',
    },
  }
}

const proposeWithdraw = (proposal: JsonObject, context: LearnContext): Accepted | string => {
  const material = materialOf(proposal, context)
  if (typeof material === 'string') return material
  const rule = ruleOf(proposal, material.repo, context)
  if (typeof rule === 'string') return rule
  rule.status = 'withdrawn'
  rule.withdrawnWhy = WITHDRAWN_BY_REFLECTION
  return {
    repo: rule.repo,
    item: { kind: 'withdrawn', ruleId: rule.id, direction: rule.direction, text: rule.topic, evidence: [], url: '' },
  }
}

const PROPOSAL_KINDS = new Map<string, (proposal: JsonObject, context: LearnContext) => Accepted | string>([
  ['add', proposeAdd],
  ['support', proposeSupport],
  ['withdraw', proposeWithdraw],
])

// 振り返りの案を 1 件ずつ検査して保存し、リポジトリごとに知らせを 1 つ足す。落ちた案は log に 1 行出して捨てる。
// 最後に、見せた食い違いの行をすべて振り返り済みにする（案が無くても。同じ材料で毎回 AI を起こさないため）。
// 材料にできるのは、見せた食い違いのうちまだ振り返り済みでないものだけ（やり直しの judge-apply で同じ案を二度入れない）
export const applyLearn = (
  name: string,
  proposals: Json[],
  shown: Array<{ repo: string; mismatches: Mismatch[] }>,
  at: string,
  log: (line: string) => void,
): void => {
  if (proposals.length === 0 && shown.length === 0) return
  const rows = readHistory(name)
  const store = readStore(name)
  const open = new Set(rows.filter((row) => !row.reflected).map((row) => `${row.key}@${row.generation}`))
  const material = new Map<string, Set<string>>()
  for (const entry of shown) {
    const ids = entry.mismatches.map((mismatch) => mismatch.id).filter((id) => open.has(id))
    if (ids.length > 0) material.set(entry.repo, new Set([...(material.get(entry.repo) ?? []), ...ids]))
  }
  const context: LearnContext = { store, material, at }
  const accepted = new Map<string, Omit<NoticeItem, 'n'>[]>()
  for (const value of proposals) {
    const proposal = asObject(value)
    const kind = asString(proposal?.kind) ?? ''
    const propose = PROPOSAL_KINDS.get(kind)
    const result =
      proposal === null
        ? '案はオブジェクトにしてください'
        : propose === undefined
          ? `kind が add・support・withdraw のどれでもありません: ${kind}`
          : propose(proposal, context)
    if (typeof result === 'string') {
      log(`学びの案を捨てました: ${kind || '-'} ${asString(proposal?.repo) ?? '-'}（${result}）`)
      continue
    }
    accepted.set(result.repo, [...(accepted.get(result.repo) ?? []), result.item])
  }
  for (const [repo, items] of accepted) appendNotice(name, store, repo, items, at)
  if (accepted.size > 0) writeStore(name, store)
  const reflected = new Set(
    shown.flatMap((entry) => entry.mismatches.map((mismatch) => `${entry.repo}\n${mismatch.id}`)),
  )
  let changed = false
  for (const row of rows)
    if (!row.reflected && reflected.has(`${row.repo}\n${row.key}@${row.generation}`)) {
      row.reflected = true
      changed = true
    }
  if (changed) writeHistory(name, rows)
}
