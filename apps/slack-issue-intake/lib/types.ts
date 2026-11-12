import type { CATEGORIES, CATEGORY_KEYS, PRIORITIES } from './defaults.ts'

export type Category = (typeof CATEGORIES)[number]
export type CategoryKey = (typeof CATEGORY_KEYS)[Category]
export type Priority = (typeof PRIORITIES)[number]
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
  | 'failed'
export type SubmissionFields = {
  title: string
  fullTitle: string
  category: Category
  priority: Priority
  body: string
  reporterId: string | null
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
export type CreateContent = { action: 'create'; summary: string; details: string; unresolved: string[] }
export type StoredDecision = { action: 'ask'; message: string } | CreateContent
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
}
// カテゴリごとのフォーム。ボタン 1 つ、ワークフロー 1 つに対応する
export type FormKind = {
  readonly key: CategoryKey
  readonly category: Category
  readonly workflowId: string
  readonly title: string
  readonly items: readonly FormItem[]
}
