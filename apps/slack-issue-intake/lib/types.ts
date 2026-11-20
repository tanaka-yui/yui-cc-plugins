import type { CATEGORIES, CATEGORY_KEYS, PRIORITIES, QUESTION_KIND_KEYS, QUESTION_KINDS } from './defaults.ts'

export type Category = (typeof CATEGORIES)[number]
export type CategoryKey = (typeof CATEGORY_KEYS)[Category]
export type Priority = (typeof PRIORITIES)[number]
export type QuestionKind = (typeof QUESTION_KINDS)[number]
export type QuestionKindKey = (typeof QUESTION_KIND_KEYS)[QuestionKind]
export type State =
  | 'new'
  | 'asking'
  | 'waiting'
  | 'answered'
  | 'timed_out'
  | 'creating'
  | 'notifying'
  | 'created'
  | 'rejecting'
  | 'rejected'
  | 'closing'
  | 'closed'
  | 'failed'
export type SubmissionFields = {
  title: string
  fullTitle: string
  category: Category
  priority: Priority
  body: string
  reporterId: string | null
  // 質問のときだけ持つ（それ以外の投稿と、この項目より前に保存した行には無い）
  questionKind?: QuestionKind
  // 向き先（作業を始めるブランチ）。選んだリポジトリの候補にあるときだけ持つ。質問には無い
  base?: string
}
export type FileRef = {
  id: string
  name: string
  mimetype: string
  size: number
  permalink: string
  downloadUrl: string | null
}
export type TranscriptEntry = {
  ts: string
  from: 'bot' | 'human'
  userId: string | null
  name: string | null
  text: string
  files: FileRef[]
}
// title は質問から起票するときだけ持つ（ほかの投稿はフォームの題を使う）
export type CreateContent = {
  action: 'create'
  summary: string
  details: string
  unresolved: string[]
  title?: string
}
// 質問への回答。sources は根拠にしたドキュメントのリポジトリ内のパス、links は apply が作った permalink
export type AnswerContent = {
  action: 'answer'
  message: string
  sources: string[]
  links: string[]
  proposeIssue: boolean
}
export type StoredDecision =
  | { action: 'ask'; message: string }
  | CreateContent
  | AnswerContent
  | { action: 'close'; message: string }
export type ProcessIdentity = { pid: number; start: string }
export type InflightRecord = {
  owner: ProcessIdentity
  child: ProcessIdentity | null
  at: string
  deadConfirmedAt: string | null
}
export type HistoryScan = { sliceOldest: string; sliceLatest: string; resumeLatest: string | null }
export type FormItem = {
  readonly name: string
  readonly label: string
  readonly long: boolean
  readonly required: boolean
  // あれば選択式の項目（値はこのどれか）
  readonly options?: readonly string[]
}
// カテゴリごとのフォーム。ボタン 1 つ、ワークフロー 1 つに対応する
export type FormKind = {
  readonly key: CategoryKey
  readonly category: Category
  readonly workflowId: string
  readonly title: string
  readonly description: string
  // 題と優先度の欄があるか（質問には無い）
  readonly titled: boolean
  readonly items: readonly FormItem[]
}
