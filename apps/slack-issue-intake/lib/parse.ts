import {
  CATEGORIES,
  FIELD_LABELS,
  FORM_KINDS,
  MAX_TITLE_CHARS,
  PRIORITIES,
  PROBLEM_INVALID,
  PROBLEM_MISSING,
  SUBMISSION_MARKER,
  TITLE_ELLIPSIS,
} from './defaults.ts'
import { firstUserMention } from './slack-text.ts'

import type { Category, FormKind, Priority, SubmissionFields } from './types.ts'

export type ParseResult =
  | { kind: 'not-submission' }
  | { kind: 'invalid'; problems: string[]; reporterId: string | null }
  | { kind: 'ok'; fields: SubmissionFields }

const FENCE = '```'
const HEADER_LABELS: readonly string[] = [
  FIELD_LABELS.title,
  FIELD_LABELS.category,
  FIELD_LABELS.priority,
  FIELD_LABELS.reporter,
]
const ITEM_LABELS = new Set(FORM_KINDS.flatMap((k) => k.items.map((i) => i.label)))

export const formKindByCategory = (category: string): FormKind | undefined => {
  const c = category.normalize('NFKC').trim()
  return FORM_KINDS.find((k) => k.category === c)
}

// 値が空でない項目だけを「項目名:\n値」にし、空行でつなぐ。Issue の元の投稿にも項目名が見出しとして残る
export const renderSections = (sections: readonly { label: string; value: string }[]): string =>
  sections
    .filter((s) => s.value.trim())
    .map((s) => `${s.label}:\n${s.value}`)
    .join('\n\n')

// 「ラベル: 値」の行を分ける。太字の * はラベルの前後と値の先頭から外す
const splitLabel = (line: string): { label: string; value: string } | null => {
  const rest = line.replace(/^\s*\*+/, '')
  const at = rest.search(/[:：]/)
  if (at < 0) return null
  return {
    label: rest.slice(0, at).replace(/\*/g, '').normalize('NFKC').trim(),
    value: rest
      .slice(at + 1)
      .replace(/^\**/, '')
      .trim(),
  }
}
const isBoldItemLine = (line: string): boolean => {
  const m = /^\s*\*([^*:：]+)[:：]\*/.exec(line)
  return Boolean(m?.[1] && ITEM_LABELS.has(m[1].normalize('NFKC').trim()))
}
const trimBlankLines = (lines: string[]): string =>
  lines
    .join('\n')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '')
    .trim()

type Scan = { header: Record<string, string>; legacyBody: string | null; items: Map<string, string[]> }
const scan = (lines: string[]): Scan => {
  const header: Record<string, string> = {}
  const items = new Map<string, string[]>()
  let current: string[] | null = null
  let inFence = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (inFence && isBoldItemLine(line)) inFence = false
    if (current && line.includes(FENCE)) {
      const content = line.split(FENCE).join('')
      if (content.trim()) current.push(content.trim())
      if ((line.split(FENCE).length - 1) % 2 === 1) inFence = !inFence
      continue
    }
    if (inFence) {
      current?.push(line)
      continue
    }
    const parts = splitLabel(line)
    if (parts?.label === FIELD_LABELS.body) {
      return { header, legacyBody: [parts.value, ...lines.slice(i + 1)].join('\n').trim(), items }
    }
    if (parts && items.size === 0 && HEADER_LABELS.includes(parts.label)) header[parts.label] = parts.value
    else if (parts && ITEM_LABELS.has(parts.label)) {
      current = parts.value ? [parts.value] : []
      items.set(parts.label, current)
    } else current?.push(line)
  }
  return { header, legacyBody: null, items }
}

export const parseSubmission = (text: string, fallbackUserId: string | null): ParseResult => {
  const lines = text.trim().split(/\r?\n/)
  if (lines[0]?.normalize('NFKC').trim() !== SUBMISSION_MARKER) return { kind: 'not-submission' }
  const { header, legacyBody, items } = scan(lines)
  const fullTitle = header[FIELD_LABELS.title] ?? ''
  const category = (header[FIELD_LABELS.category] ?? '').normalize('NFKC').trim()
  const priority = (header[FIELD_LABELS.priority] ?? '').normalize('NFKC').trim().toLowerCase()
  const reporterId = firstUserMention(header[FIELD_LABELS.reporter] ?? '') ?? fallbackUserId
  const formKind = legacyBody === null ? formKindByCategory(category) : undefined
  const sections = (formKind?.items ?? []).map((item) => ({
    item,
    value: trimBlankLines(items.get(item.label) ?? []),
  }))
  const problems: string[] = []
  for (const [label, value, options] of [
    [FIELD_LABELS.title, fullTitle, []],
    [FIELD_LABELS.category, category, CATEGORIES],
    [FIELD_LABELS.priority, priority, PRIORITIES],
  ] as const) {
    if (!value) problems.push(PROBLEM_MISSING.replace('{label}', label))
    else if (options.length && !(options as readonly string[]).includes(value))
      problems.push(PROBLEM_INVALID.replace('{label}', label).replace('{options}', options.join(' / ')))
  }
  if (legacyBody !== null) {
    if (!legacyBody) problems.push(PROBLEM_MISSING.replace('{label}', FIELD_LABELS.body))
  } else
    for (const s of sections)
      if (s.item.required && !s.value) problems.push(PROBLEM_MISSING.replace('{label}', s.item.label))
  if (problems.length) return { kind: 'invalid', problems, reporterId }
  const body = legacyBody ?? renderSections(sections.map((s) => ({ label: s.item.label, value: s.value })))
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
