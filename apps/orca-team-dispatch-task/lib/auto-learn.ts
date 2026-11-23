import { BASE_LABEL_PREFIX } from './auto-base.ts'
import { ensureLabels, github } from './auto-github.ts'
import { autoDir, autoNow } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, type Json, type JsonObject } from './json.ts'
import { MANAGED_LABELS, STATUS, STATUS_LABELS, THREAD_LABEL } from './status.ts'

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AutoConfig } from './auto-config.ts'
import type { AutoState, IssueState } from './auto-state.ts'

// 判定の学びのデータ（auto/<name>/learn/ の下）と、その上の純粋な計算。
// 履歴・規則・知らせの 3 ファイルを読み書きし、食い違いの抽出・似た事例の選択・規則の文の検査をする。
export const LEARN_DIR = 'learn'
export const LEARN_FILES = { history: 'history.json', rules: 'rules.json', notices: 'notices.json' } as const
// Slack での取り消しと公開の依頼。slack-issue-intake がホームに書き、orca は読むだけ（lib/defaults.ts の同名の定数と同じ値）
export const LEARN_CANCELS_FILE = 'learn-cancels.json'
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
// 全体に効く学びを改善の Issue として出す先（setup で「はい」と答えたときの値）
export const LEARN_PLUGIN_REPO = 'tanaka-yui/yui-cc-plugins'
// 判定の改善の Issue に付けるラベル。このラベルの Issue の PR は AI が merge しない
export const LEARN_LABEL = 'judge-learning'
const LEARN_LABEL_COLOR = '5319e7'
const LEARN_LABEL_DESCRIPTION = '判定の学びから作った、判定の基準を直す改善'
// slack-thread が無いときだけ作る（slack-issue-intake の lib/defaults.ts と同じ色と説明）
const THREAD_LABEL_COLOR = '6f42c1'
const THREAD_LABEL_DESCRIPTION = 'slack-issue-intake が Slack のスレッドで管理している Issue'
// eng 向きの規則（様子見が無い）を全体の改善に出すのに要る根拠の件数
export const LEARN_GLOBAL_ENG_EVIDENCE = 5
// 改善の Issue の本文と題の文字数の上限
export const LEARN_GLOBAL_BODY_MAX = 2000
export const LEARN_GLOBAL_TITLE_MAX = 80
// 公開リポジトリに出す文に入れてはいけない Issue の番号の並び
const ISSUE_REFERENCE = /#\d/
// 公開リポジトリに出す文に入れない、表示では見えない・別の形に見える文字（制御文字・書式文字（ゼロ幅・向きの制御・
// タグ文字）・私用・未割り当て）。Slack と status では空白になるか何も出ないので、人が読んで承認しても気づけない。
// 題は 1 行にし、本文の行の区切りは \n だけを許す（\r・U+0085 は制御文字、U+2028・U+2029 は行と段落の区切り）
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u
const BODY_LINE_BREAK = /\n/g
// 端末の learn-publish で公開したときの、承認した人の欄
export const LEARN_TERMINAL_APPROVER = '端末の learn-publish'
// 承認した人が記録されていない公開の依頼（手で書いた依頼など）
const APPROVER_UNKNOWN = '記録なし'
// 短い名前を語として見るときに、語の続きとみなす文字（これ以外の文字と文の端が境目。- と _ も境目）
const WORD_CHARACTER = /[A-Za-z0-9]/
// この文字数以下で - も _ も含まない名前（app・io など）だけを語として見る。それ以外は部分一致で断る（漏らさない向き）
const LEARN_GLOBAL_WORD_NAME_MAX = 4
const NAME_JOINERS = ['-', '_']
// 改善の Issue の本文に書かせるプラグインのパス。リポジトリ名の一致がまるごとこの中にあるときは数えない
const LEARN_GLOBAL_SAFE_PATHS = [
  'skills/orca-team-dispatch-task/references/auto-judge.md',
  'skills/orca-team-dispatch-task/references/auto-judge-ja.md',
]
// 全角の英数字や記号も同じ文字として比べる
const TEXT_NORMALIZATION = 'NFKC'
// gh issue create が出す Issue の URL の末尾の番号
const CREATED_ISSUE_NUMBER = /\/issues\/(\d+)$/

const FILE_VERSION = 1
export const ROUTES = ['auto', 'eng'] as const
const OUTCOMES = ['merged-ai', 'merged-human', 'failed', 'failed-env', 'stopped', 'eng-kept', 'eng-returned'] as const
const RULE_STATUSES = ['active', 'withdrawn'] as const
// 知らせの項目の種類（slack-issue-intake の lib/defaults.ts の LEARN_NOTICE_KINDS と同じ）
export const NOTICE_KINDS = [
  'new',
  'support',
  'withdrawn',
  'graduated',
  'global-issue',
  'global-pr',
  'global-hint',
  'global-draft',
] as const
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
  // 全体の改善の Issue。draft は人の承認を待っている題と本文（公開したら・捨てたら null）
  global: { issue: string; prNotified: boolean; draft: GlobalDraft | null } | null
}
export type GlobalDraft = { title: string; body: string }
export type NoticeKind = (typeof NOTICE_KINDS)[number]
export type NoticeItem = {
  n: number
  kind: NoticeKind
  ruleId: string
  direction: Route
  text: string
  evidence: string[]
  url: string
  // global-draft だけ下書きの本文を入れ、ほかは ''
  body: string
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
    // 前の版のファイルには draft が無い。あれば null か題と本文の文字列
    let draft: GlobalDraft | null = null
    if (entry.draft !== undefined && entry.draft !== null) {
      const value = asObject(entry.draft)
      const title = asString(value?.title)
      const body = asString(value?.body)
      if (title === null || body === null) return null
      draft = { title, body }
    }
    global = { issue, prNotified: entry.prNotified, draft }
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
  // 前の版のファイルには body が無い
  const body = item.body === undefined ? '' : asString(item.body)
  if (
    n === null ||
    kind === null ||
    ruleId === null ||
    direction === null ||
    text === null ||
    evidence === null ||
    url === null ||
    body === null
  )
    return null
  return { n, kind, ruleId, direction, text, evidence, url, body }
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
  // 行はもう書いたので、様子見の決着に失敗しても記録済みのままにする（行を二重に書かないため）
  try {
    settleRules(name, row, at)
  } catch (error) {
    console.log(
      `様子見の規則を更新できません: ${issue.key}（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
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

const probationRules = (store: LearnStore, ruleIds: string[]): Rule[] =>
  store.rules.filter((rule) => rule.status === 'active' && rule.probationLeft > 0 && ruleIds.includes(rule.id))

// 判定が頼った規則のどれかが、まだ確かめ終えていないか（そうなら AI は merge せず人の確認に回す）。
// 様子見の途中・取り下げ済み（動いている間に誤りと分かった）・もう無い規則はどれも様子見を終えていないとみなす
export const onProbation = (store: LearnStore, ruleIds: string[]): boolean =>
  ruleIds.some(
    (id) => !store.rules.some((rule) => rule.id === id && rule.status === 'active' && rule.probationLeft === 0),
  )

const WITHDRAWN_BY_PROBATION = '様子見の Issue が失敗または人が止めた'
const WITHDRAWN_BY_CANCEL = 'Slack で取り消し'

// 世代の結果で様子見の規則を決着させる。人が merge したら残りを 1 減らし、0 になったら様子見を終えたと知らせる。
// 失敗したか、auto-ready か始まったあとの Issue を人が止めたら取り下げて知らせる。環境が原因の失敗などでは何もしない。
// recordOutcome が 1 世代に 1 行しか書かないので、1 行につき 1 回だけ呼ばれる
export const settleRules = (name: string, row: HistoryRow, at: string): void => {
  if (row.ruleIds.length === 0) return
  const merged = row.outcome === 'merged-human'
  const failed = row.outcome === 'failed' || (row.outcome === 'stopped' && (row.autoReady || row.started))
  if (!merged && !failed) return
  const store = readStore(name)
  const settling = probationRules(store, row.ruleIds)
  if (settling.length === 0) return
  const items: Omit<NoticeItem, 'n'>[] = []
  for (const rule of settling) {
    if (merged) {
      rule.probationLeft -= 1
      if (rule.probationLeft > 0) continue
    } else {
      rule.status = 'withdrawn'
      rule.withdrawnWhy = WITHDRAWN_BY_PROBATION
    }
    items.push({
      kind: merged ? 'graduated' : 'withdrawn',
      ruleId: rule.id,
      direction: rule.direction,
      text: rule.topic,
      evidence: [],
      url: '',
      body: '',
    })
  }
  if (items.length > 0) appendNotice(name, store, row.repo, items, at)
  writeStore(name, store)
}

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

// 振り返りの案。kind ごとに検査と保存をする。知らない kind は捨てる（kind は今後増える）。
// global の案は形だけ確かめて返し、呼び出し側が applyLearn の保存のあとで proposeGlobal に渡す
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
  return {
    repo: rule.repo,
    item: { kind: 'new', ruleId: rule.id, direction, text: topic, evidence, url: '', body: '' },
  }
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
      body: '',
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
    item: {
      kind: 'withdrawn',
      ruleId: rule.id,
      direction: rule.direction,
      text: rule.topic,
      evidence: [],
      url: '',
      body: '',
    },
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
): GlobalProposal[] => {
  const globals: GlobalProposal[] = []
  if (proposals.length === 0 && shown.length === 0) return globals
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
    if (proposal !== null && kind === GLOBAL_KIND) {
      const parsed = globalProposalOf(proposal)
      if (typeof parsed === 'string')
        log(`学びの案を捨てました: ${kind} ${asString(proposal.ruleId) ?? '-'}（${parsed}）`)
      else globals.push(parsed)
      continue
    }
    const propose = PROPOSAL_KINDS.get(kind)
    const result =
      proposal === null
        ? '案はオブジェクトにしてください'
        : propose === undefined
          ? `kind が add・support・withdraw・global のどれでもありません: ${kind}`
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
  return globals
}

// 全体に効く学びの案（yui-cc-plugins の改善の Issue の題と本文）
export type GlobalProposal = { ruleId: string; title: string; body: string }
const GLOBAL_KIND = 'global'
const globalProposalOf = (proposal: JsonObject): GlobalProposal | string => {
  const ruleId = asString(proposal.ruleId)
  const title = asString(proposal.title)
  const body = asString(proposal.body)
  return ruleId === null || title === null || body === null
    ? 'ruleId・title・body を文字列にしてください'
    : { ruleId, title, body }
}

export type GlobalCandidate = { ruleId: string; repo: string; direction: Route; topic: string; evidenceCount: number }
// 全体の改善に出せる規則: 有効で、まだ出しておらず、auto 向きなら様子見を終え、eng 向きなら根拠が足りている
const isGlobalCandidate = (rule: Rule): boolean =>
  rule.status === 'active' &&
  rule.global === null &&
  (rule.direction === 'auto' ? rule.probationLeft === 0 : rule.evidence.length >= LEARN_GLOBAL_ENG_EVIDENCE)
export const globalCandidates = (store: LearnStore): GlobalCandidate[] =>
  store.rules.filter(isGlobalCandidate).map((rule) => ({
    ruleId: rule.id,
    repo: rule.repo,
    direction: rule.direction,
    topic: rule.topic,
    evidenceCount: rule.evidence.length,
  }))

type Span = { start: number; end: number }
// text の中の needle の出現（重なりも含めて）すべての範囲
const spansOf = (text: string, needle: string): Span[] => {
  const spans: Span[] = []
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1))
    spans.push({ start: at, end: at + needle.length })
  return spans
}
// 名前が、決まった文字列の範囲の外にも現れるか。短く - も _ も含まない名前は語として、それ以外は部分一致で見る。
// 語の境目は、隣の文字が WORD_CHARACTER でない所（文の端も）と、決まった文字列の範囲の端（決まった文字列にじかに
// くっつけた短い名前を隠さないため）。一致の範囲がまるごと 1 つの決まった文字列の範囲に入るときだけ数えない
const containsName = (text: string, name: string, safe: Span[]): boolean => {
  const short = name.length <= LEARN_GLOBAL_WORD_NAME_MAX && !NAME_JOINERS.some((joiner) => name.includes(joiner))
  const boundaryBefore = (at: number): boolean =>
    !WORD_CHARACTER.test(text[at - 1] ?? '') || safe.some((span) => span.end === at)
  const boundaryAfter = (at: number): boolean =>
    !WORD_CHARACTER.test(text[at] ?? '') || safe.some((span) => span.start === at)
  return spansOf(text, name).some(
    (match) =>
      (!short || (boundaryBefore(match.start) && boundaryAfter(match.end))) &&
      !safe.some((span) => span.start <= match.start && match.end <= span.end),
  )
}
const fold = (text: string): string => text.normalize(TEXT_NORMALIZATION).toLowerCase()
const namesOf = (repo: string): string[] => [repo, repo.slice(repo.indexOf('/') + 1)]

// 公開リポジトリに出す題と本文として使えない理由（日本語の 1 行ずつ）。問題が無ければ空。
// 文は NFKC で揃えてから見る（全角の綴りも捕まえる）。設定にあるリポジトリ名は owner/name の全体と / の後ろの名前を、
// 大文字小文字を無視して見る。長い名前と - か _ を含む名前は部分一致、短い名前（app など）は語として断る。
// 文は書き換えない。本文に書かせるプラグインのパスと Issue を出す先（issueRepo）の出現の範囲を先に求め、名前の一致が
// まるごとその 1 つに入るときだけ数えない（くっつけた名前は数える）。issueRepo は断る名前からも外す。
// 理由の行は掛かった名前を言う（手元の設定の名前で、ログに出すだけ）
export const globalProblems = (title: string, body: string, repos: string[], issueRepo: string | null): string[] => {
  const problems: string[] = []
  if (title.trim() === '') problems.push('題が空です')
  else if (Array.from(title).length > LEARN_GLOBAL_TITLE_MAX)
    problems.push(`題が ${LEARN_GLOBAL_TITLE_MAX} 文字を超えています`)
  if (body.trim() === '') problems.push('本文が空です')
  else if (Array.from(body).length > LEARN_GLOBAL_BODY_MAX)
    problems.push(`本文が ${LEARN_GLOBAL_BODY_MAX} 文字を超えています`)
  if (HIDDEN_CHARACTER.test(title) || HIDDEN_CHARACTER.test(body.replace(BODY_LINE_BREAK, '')))
    problems.push('題か本文に見えない文字か改行があります（制御文字・書式文字など。改行は本文の \\n だけ）')
  const text = fold(`${title}\n${body}`)
  const safe = [...LEARN_GLOBAL_SAFE_PATHS, ...(issueRepo === null ? [] : namesOf(issueRepo))]
    .map(fold)
    .filter((entry) => entry !== '')
  const safeSpans = safe.flatMap((entry) => spansOf(text, entry))
  const names = [...new Set(repos.flatMap(namesOf).map(fold))].filter((n) => n !== '' && !safe.includes(n))
  const found = names.filter((n) => containsName(text, n, safeSpans))
  if (found.length > 0) problems.push(`題か本文に設定にあるリポジトリの名前があります: ${found.join(' ')}`)
  if (ISSUE_REFERENCE.test(text)) problems.push('題か本文に # と数字の並びがあります')
  if (TOPIC_URL_PREFIXES.some((prefix) => text.includes(prefix))) problems.push('題か本文に URL があります')
  return problems
}

// 公開リポジトリに出す文として断るリポジトリ名。設定から外した・名前を変えたリポジトリの規則も候補に残るので、
// 規則のファイルにある規則の repo も入れる
const blockedRepos = (config: AutoConfig, store: LearnStore): string[] => [
  ...Object.keys(config.repos),
  ...config.sources.flatMap((source) => [source.repo, ...source.related]),
  ...store.rules.map((entry) => entry.repo),
]
const ruleItem = (rule: Rule, kind: NoticeKind, text: string, url: string, body: string): Omit<NoticeItem, 'n'> => ({
  kind,
  ruleId: rule.id,
  direction: rule.direction,
  text,
  evidence: [],
  url,
  body,
})
// 下書きを捨てる。規則は変えず、同じ規則を二度出さない
const dropDraft = (rule: Rule): void => {
  rule.global = { issue: '', prNotified: true, draft: null }
}

// 全体に効く学びの案を 1 件受ける。候補でない規則と、公開リポジトリに出せない題・本文は作らずに 1 行出す。
// issueRepo が無ければ「全体に効きそうな学び」として知らせるだけ。あれば Issue は作らずに下書きとして規則に残し、
// 題と本文を知らせ（global-draft）に入れる。人が Slack か端末で全文を読んで承認してから publishGlobal が Issue にする
// （AI の書いた文を、言葉の検査だけで公開リポジトリに出さないため）。ここでは gh を呼ばない。
// 断ったときは規則を変えない（次の振り返りでまた出せる）
export const proposeGlobal = (
  name: string,
  config: AutoConfig,
  proposal: GlobalProposal,
  at: string,
  log: (line: string) => void,
): void => {
  const store = readStore(name)
  const rule = store.rules.find((entry) => entry.id === proposal.ruleId)
  if (rule === undefined || !isGlobalCandidate(rule)) {
    log(`全体の学びの案を捨てました: ${proposal.ruleId}（全体の改善に出せる規則ではありません）`)
    return
  }
  const problems = globalProblems(proposal.title, proposal.body, blockedRepos(config, store), config.learn.issueRepo)
  if (problems.length > 0) {
    log(`全体の学びの案を捨てました: ${rule.id}（${problems.join('。')}）`)
    return
  }
  const hint = config.learn.issueRepo === null
  rule.global = hint
    ? { issue: '', prNotified: true, draft: null }
    : { issue: '', prNotified: false, draft: { title: proposal.title, body: proposal.body } }
  const item = hint
    ? ruleItem(rule, 'global-hint', proposal.title, '', '')
    : ruleItem(rule, 'global-draft', proposal.title, '', proposal.body)
  try {
    appendNotice(name, store, rule.repo, [item], at)
  } finally {
    writeStore(name, store)
  }
}

// 人が承認した下書きを issueRepo に Issue として作る。下書きがあり、まだ Issue が無い規則だけ。
// issueRepo が無い端末では作らずに下書きを残す。取り下げた規則の下書きは捨てる。設定が下書きのあとで変わっているかも
// しれないので検査をもう一度掛け、落ちたら下書きを捨てて 1 行出す。作れなければ下書きを残して false
// （次の依頼・次の tick でやり直せる）。tick からは tick の呼び出し予算の中で、learn-publish からは tick の外で gh を呼ぶ。
// approver は承認した人（Slack の user id か LEARN_TERMINAL_APPROVER）。公開した行に出すだけで、GitHub には送らない
export const publishGlobal = (
  name: string,
  config: AutoConfig,
  ruleId: string,
  at: string,
  log: (line: string) => void,
  approver: string = LEARN_TERMINAL_APPROVER,
): boolean => {
  const store = readStore(name)
  const rule = store.rules.find((entry) => entry.id === ruleId)
  const draft = rule?.global?.draft ?? null
  if (rule === undefined || draft === null || rule.global?.issue !== '') {
    log(`全体の学びの下書きがありません: ${ruleId}`)
    return false
  }
  const issueRepo = config.learn.issueRepo
  if (issueRepo === null) {
    log(
      `全体の学びの Issue を作れません: ${rule.id}（改善の Issue を出す設定がありません。make auto-setup で有効にできます）`,
    )
    return false
  }
  if (rule.status !== 'active') {
    dropDraft(rule)
    writeStore(name, store)
    log(`全体の学びの下書きを捨てました: ${rule.id}（規則が取り下げられています）`)
    return false
  }
  const problems = globalProblems(draft.title, draft.body, blockedRepos(config, store), issueRepo)
  if (problems.length > 0) {
    dropDraft(rule)
    writeStore(name, store)
    log(`全体の学びの下書きを捨てました: ${rule.id}（${problems.join('。')}）`)
    return false
  }
  const labels = [
    ...STATUS_LABELS,
    { name: THREAD_LABEL, color: THREAD_LABEL_COLOR, description: THREAD_LABEL_DESCRIPTION },
    { name: LEARN_LABEL, color: LEARN_LABEL_COLOR, description: LEARN_LABEL_DESCRIPTION },
  ]
  if (!ensureLabels(issueRepo, labels)) {
    log(`全体の学びの Issue を作れません: ${rule.id}（${issueRepo} のラベルを揃えられません）`)
    return false
  }
  const created = github([
    'issue',
    'create',
    '--repo',
    issueRepo,
    '--title',
    draft.title,
    '--body',
    draft.body,
    '--label',
    STATUS.ready,
    '--label',
    THREAD_LABEL,
    '--label',
    LEARN_LABEL,
  ])
  const url = created.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  const number = CREATED_ISSUE_NUMBER.exec(url)?.[1]
  if (created.rc !== 0) {
    log(`全体の学びの Issue を作れません: ${rule.id}（${issueRepo} への gh issue create が失敗しました）`)
    return false
  }
  // 作れたのに番号を読めないときは、Issue はもうあるので下書きを捨ててやり直さない（公開の依頼は残り続けるので、
  // 下書きを残すと tick のたびに同じ Issue を作る）
  if (number === undefined) {
    dropDraft(rule)
    writeStore(name, store)
    log(`全体の学びの Issue を作りましたが番号を読めません: ${rule.id}（${issueRepo} を確かめてください）`)
    return false
  }
  // Issue はもう作ったので、知らせを書けなくても規則には残す（同じ Issue を二度作らないため）
  rule.global = { issue: `${issueRepo}#${number}`, prNotified: false, draft: null }
  try {
    appendNotice(name, store, rule.repo, [ruleItem(rule, 'global-issue', draft.title, url, '')], at)
  } finally {
    writeStore(name, store)
  }
  log(`全体の学びの Issue を作りました: ${rule.id} ${rule.global.issue}（承認: ${approver || APPROVER_UNKNOWN}）`)
  return true
}

// 自分が作った改善の Issue の PR ができた（人の確認に回った）ら、規則ごとに 1 回だけ知らせる。
// intake のステータスの知らせはホームのリポジトリしか見ないので頼らない。tick の終わりに呼ぶ
export const notifyGlobalPrs = (name: string, state: AutoState, at: string): void => {
  const store = readStore(name)
  const issues = Object.values(state.issues)
  let changed = false
  for (const rule of store.rules) {
    const global = rule.global
    if (global === null || global.prNotified) continue
    const issue = issues.find((entry) => entry.key.toLowerCase() === global.issue.toLowerCase())
    const pr = issue?.phase === 'review' ? issue.prs[0] : undefined
    if (issue === undefined || pr === undefined) continue
    global.prNotified = true
    appendNotice(
      name,
      store,
      rule.repo,
      [
        {
          kind: 'global-pr',
          ruleId: rule.id,
          direction: rule.direction,
          text: issue.title,
          evidence: [],
          url: pr.url,
          body: '',
        },
      ],
      at,
    )
    changed = true
  }
  if (changed) writeStore(name, store)
}

// 依頼が指す項目の中身のハッシュ（人が Slack で見た項目と、この名前の知らせの項目を突き合わせる）。
// 決まった形は JSON.stringify([kind, ruleId, direction, text, body]) の sha256（16 進）。slack-issue-intake の
// lib/learn-hash.ts の learnItemHash と同じ値になる（scripts/check-shared-contracts.mjs が fixture で確かめる）
export const learnItemHash = (item: Pick<NoticeItem, 'kind' | 'ruleId' | 'direction' | 'text' | 'body'>): string =>
  createHash('sha256')
    .update(JSON.stringify([item.kind, item.ruleId, item.direction, item.text, item.body]))
    .digest('hex')
// learn-cancels.json の依頼の種類（slack-issue-intake の lib/defaults.ts の LEARN_REQUEST_ACTIONS と同じ）
export const REQUEST_ACTIONS = ['cancel', 'publish'] as const
// user は公開を承認した人の Slack の id（intake が公開の依頼だけに書く。無ければ ''）。
// hash は人が見た項目の learnItemHash（無ければ ''。前の版の依頼で、どの項目にも合わない）
type Cancel = {
  noticeId: number
  n: number
  ruleId: string
  at: string
  action: (typeof REQUEST_ACTIONS)[number]
  user: string
  hash: string
}

const parseCancel = (value: Json): Cancel | null => {
  const entry = asObject(value)
  const noticeId = count(entry?.noticeId)
  const n = count(entry?.n)
  const ruleId = asString(entry?.ruleId)
  const at = asString(entry?.at)
  // 前の版の依頼には action が無い（取り消し）。あるのに知らない値なら読めない
  const action =
    entry?.action === undefined ? 'cancel' : (REQUEST_ACTIONS.find((item) => item === entry.action) ?? null)
  const user = entry?.user === undefined ? '' : asString(entry.user)
  const hash = entry?.hash === undefined ? '' : asString(entry.hash)
  return noticeId === null ||
    n === null ||
    ruleId === null ||
    at === null ||
    action === null ||
    user === null ||
    hash === null
    ? null
    : { noticeId, n, ruleId, at, action, user, hash }
}

// ホームの learn-cancels.json の依頼。無ければ空。読めない・形が違うときは null
const readCancels = (home: string): Cancel[] | null => {
  const path = join(home, LEARN_CANCELS_FILE)
  if (!existsSync(path)) return []
  const value = asObject(readJson(path))
  const list = value?.version === FILE_VERSION ? asArray(value.cancels) : null
  if (list === null) return null
  const cancels = list.map(parseCancel)
  return cancels.every((cancel) => cancel !== null) ? cancels : null
}

// 各ホームの依頼（取り消しと公開）を読んで反映する。依頼は残り続けるので、何度読んでも同じ結果にする。
// 依頼が指す知らせの項目（noticeId・n・ruleId）を自分の notices.json で引き、見つからない依頼は何もしない
// （古くて消えた知らせ・別の名前の知らせ。下書きへの取り消しを、下書きを捨てたあとに規則の取り消しと読み違えないため）。
// - 下書き（global-draft）への取り消し: 規則は取り下げず、下書きだけを捨てる（知らせは足さない）。下書きが無ければ何もしない
// - それ以外の項目への取り消し: 有効な規則を取り下げて、知らせ（withdrawn）を規則ごとに 1 つ足す
// - どの依頼も、項目の中身のハッシュ（learnItemHash）が依頼の hash と同じときだけ効く
// - 公開: 項目が global-draft で、今の下書きの題と本文も依頼の hash と合うときだけ publishGlobal を呼ぶ。同じ規則の下書きへの
//   取り消しもあれば公開しない。下書きが無い・Issue が既にある依頼は黙って飛ばす
// 取り下げと下書きの破棄を保存してから公開する（publishGlobal は規則を読み直して保存するので、先に読んだ規則で上書きしない）。
// 読めないファイルは log に 1 行出して飛ばす。取り下げた規則の数を返す
export const applyCancels = (
  name: string,
  config: AutoConfig,
  homes: string[],
  at: string,
  log: (line: string) => void,
): number => {
  const requests: Cancel[] = []
  for (const home of homes) {
    const cancels = readCancels(home)
    if (cancels === null) log(`学びの取り消しの依頼を読めません: ${join(home, LEARN_CANCELS_FILE)}`)
    else requests.push(...cancels)
  }
  if (requests.length === 0) return 0
  const items = new Map<string, NoticeItem>()
  for (const notice of readNotices(name)) for (const item of notice.items) items.set(`${notice.id}:${item.n}`, item)
  const store = readStore(name)
  const ruleById = (id: string): Rule | undefined => store.rules.find((rule) => rule.id === id)
  const withdraw = new Set<string>()
  const discard = new Set<string>()
  // 公開する規則と、承認した人（最初の依頼のもの）
  const publish = new Map<string, string>()
  for (const request of requests) {
    // 人が見た項目（依頼の hash）と、この名前の知らせの項目が同じ中身のときだけ効く。番号と規則の id は名前ごと・
    // learn/ を作り直すたびに繰り返すので、それだけでは別の名前の下書きや、人が見ていない項目を指しうる
    const item = items.get(`${request.noticeId}:${request.n}`)
    if (item === undefined || item.ruleId !== request.ruleId || request.hash !== learnItemHash(item)) continue
    const toDraft = item.kind === 'global-draft'
    if (request.action === 'cancel') (toDraft ? discard : withdraw).add(request.ruleId)
    else if (toDraft) {
      // 公開するのは、今の下書きが人の見た題と本文のままのときだけ
      const draft = ruleById(request.ruleId)?.global?.draft
      const shown = draft && learnItemHash({ ...item, text: draft.title, body: draft.body }) === request.hash
      if (shown && !publish.has(request.ruleId)) publish.set(request.ruleId, request.user)
    }
  }
  let changed = false
  for (const id of discard) {
    const rule = ruleById(id)
    if (rule?.global?.draft) {
      dropDraft(rule)
      changed = true
    }
  }
  const targets = store.rules.filter((rule) => rule.status === 'active' && withdraw.has(rule.id))
  for (const rule of targets) {
    rule.status = 'withdrawn'
    rule.withdrawnWhy = WITHDRAWN_BY_CANCEL
    appendNotice(name, store, rule.repo, [ruleItem(rule, 'withdrawn', rule.topic, '', '')], at)
  }
  if (changed || targets.length > 0) writeStore(name, store)
  for (const [id, user] of publish) if (!discard.has(id)) publishGlobal(name, config, id, at, log, user)
  return targets.length
}
