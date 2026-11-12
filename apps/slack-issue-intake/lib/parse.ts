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
// 項目名 → 複数行か。同じ項目名（画面のURL など）はどの種類でも同じ形
const ITEM_LONG = new Map(FORM_KINDS.flatMap((k) => k.items.map((i) => [i.label, i.long] as const)))

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
  return Boolean(m?.[1] && ITEM_LONG.has(m[1].normalize('NFKC').trim()))
}
// * の無い形（rich_text を平らにしたもの）での項目の始まり。まだ出ていない項目名で、
// 複数行の項目なら同じ行に値が無いもの、1 行の項目なら値があってもよい。
// 値の中の「理想: …」のような行（同じ行に値がある複数行の項目名）は、項目の始まりとみなさない
const isPlainItemStart = (parts: { label: string; value: string } | null, seen: Map<string, string[]>): boolean =>
  Boolean(
    parts && ITEM_LONG.has(parts.label) && !seen.has(parts.label) && (!parts.value || !ITEM_LONG.get(parts.label)),
  )
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
  let currentLong = false
  let inFence = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const parts = splitLabel(line)
    const itemStart = isBoldItemLine(line) || isPlainItemStart(parts, items)
    // 項目の始まりの行が来たら、値の ``` で枠が崩れていても枠を閉じる
    if (inFence && itemStart) inFence = false
    if (current && currentLong && !itemStart && line.includes(FENCE)) {
      const content = line.split(FENCE).join('')
      if (content.trim()) current.push(content.trim())
      if ((line.split(FENCE).length - 1) % 2 === 1) inFence = !inFence
      continue
    }
    if (inFence) {
      current?.push(line)
      continue
    }
    if (items.size === 0 && parts?.label === FIELD_LABELS.body) {
      return { header, legacyBody: [parts.value, ...lines.slice(i + 1)].join('\n').trim(), items }
    }
    if (parts && items.size === 0 && HEADER_LABELS.includes(parts.label)) header[parts.label] = parts.value
    else if (parts && itemStart) {
      current = parts.value ? [parts.value] : []
      currentLong = ITEM_LONG.get(parts.label) ?? false
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
