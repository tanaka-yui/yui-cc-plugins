import {
  CATEGORIES,
  FIELD_LABELS,
  MAX_TITLE_CHARS,
  PRIORITIES,
  PROBLEM_INVALID,
  PROBLEM_MISSING,
  SUBMISSION_MARKER,
  TITLE_ELLIPSIS,
} from './defaults.ts'
import { firstUserMention } from './slack-text.ts'

import type { Category, Priority, SubmissionFields } from './types.ts'

export type ParseResult =
  | { kind: 'not-submission' }
  | { kind: 'invalid'; problems: string[]; reporterId: string | null }
  | { kind: 'ok'; fields: SubmissionFields }
export const parseSubmission = (text: string, fallbackUserId: string | null): ParseResult => {
  const lines = text.trim().split(/\r?\n/)
  if (lines[0]?.normalize('NFKC').trim() !== SUBMISSION_MARKER) return { kind: 'not-submission' }
  const values: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const at = line.search(/[:：]/)
    if (at < 0) continue
    const label = line.slice(0, at).normalize('NFKC').trim()
    const value = line.slice(at + 1).trim()
    if (label === FIELD_LABELS.body) {
      values[label] = [value, ...lines.slice(i + 1)].join('\n').trim()
      break
    }
    if (Object.values(FIELD_LABELS).includes(label as (typeof FIELD_LABELS)[keyof typeof FIELD_LABELS]))
      values[label] = value
  }
  const fullTitle = values[FIELD_LABELS.title] ?? ''
  const category = (values[FIELD_LABELS.category] ?? '').normalize('NFKC').trim()
  const priority = (values[FIELD_LABELS.priority] ?? '').normalize('NFKC').trim().toLowerCase()
  const body = values[FIELD_LABELS.body] ?? ''
  const reporterId = firstUserMention(values[FIELD_LABELS.reporter] ?? '') ?? fallbackUserId
  const problems: string[] = []
  for (const [label, value, options] of [
    [FIELD_LABELS.title, fullTitle, []],
    [FIELD_LABELS.category, category, CATEGORIES],
    [FIELD_LABELS.priority, priority, PRIORITIES],
    [FIELD_LABELS.body, body, []],
  ] as const) {
    if (!value) problems.push(PROBLEM_MISSING.replace('{label}', label))
    else if (options.length && !(options as readonly string[]).includes(value))
      problems.push(PROBLEM_INVALID.replace('{label}', label).replace('{options}', options.join(' / ')))
  }
  if (problems.length) return { kind: 'invalid', problems, reporterId }
  const chars = [...fullTitle]
  return {
    kind: 'ok',
    fields: {
      title: chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS - 1).join('') + TITLE_ELLIPSIS : fullTitle,
      fullTitle,
      category: category as Category,
      priority: priority as Priority,
      body,
      reporterId,
    },
  }
}
