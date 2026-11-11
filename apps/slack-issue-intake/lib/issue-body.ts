import {
  BOT_TRANSCRIPT_NAME,
  CATEGORY_KEYS,
  DETAILS_MAX_CHARS,
  FENCE_SAFE_BACKTICK,
  ISSUE_BODY_MAX_CHARS,
  ISSUE_HEADINGS,
  ISSUE_MARKER_PREFIX,
  ISSUE_TABLE,
  MAX_LISTED_FILES,
  MORE_FILES_NOTE,
  ORIGINAL_MAX_CHARS,
  PRIORITY_LABEL_PREFIX,
  SLACK_REPORTER_SUFFIX,
  SOURCE_LABEL,
  SUMMARY_MAX_CHARS,
  THREAD_MAX_CHARS,
  TITLE_IN_BODY_MAX_CHARS,
  TRUNCATED_NOTE,
  UNKNOWN_REPORTER_NAME,
  UNRESOLVED_ITEM_MAX_CHARS,
  UNRESOLVED_MAX_ITEMS,
  ZERO_WIDTH_SPACE,
} from './defaults.ts'
import { maskSecrets } from './secrets.ts'

import type { Submission } from './db.ts'
import type { CreateContent, SubmissionFields } from './types.ts'
export const issueMarker = (channel: string, ts: string): string => `<!-- ${ISSUE_MARKER_PREFIX}:${channel}:${ts} -->`
export const neutralizeMentions = (text: string): string =>
  text.replace(/(^|[^A-Za-z0-9_`])@(?=[A-Za-z0-9])/g, `$1@${ZERO_WIDTH_SPACE}`)
export const fenceSafe = (text: string): string => text.replace(/`{3,}/g, (s) => FENCE_SAFE_BACKTICK.repeat(s.length))
export const fenced = (text: string): string => `\`\`\`text\n${fenceSafe(text)}\n\`\`\``
export const truncate = (text: string, max: number): string =>
  text.length <= max
    ? text
    : max < TRUNCATED_NOTE.length
      ? text.slice(0, Math.max(0, max))
      : text.slice(0, max - TRUNCATED_NOTE.length) + TRUNCATED_NOTE
export const issueLabels = (fields: SubmissionFields): string[] => [
  CATEGORY_KEYS[fields.category],
  PRIORITY_LABEL_PREFIX + fields.priority,
  SOURCE_LABEL,
]
export const lastLineIsMarker = (body: string, marker: string): boolean =>
  body
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .at(-1) === marker
const clean = (text: string, max: number): string => truncate(neutralizeMentions(maskSecrets(text)), max)
const tableSafe = (text: string): string => text.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
const linkName = (text: string): string => text.replace(/[[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ')
export const buildIssueBody = (s: Submission, d: CreateContent): string => {
  const h = ISSUE_HEADINGS
  const t = ISSUE_TABLE
  const fields = s.fields
  const summary = clean(d.summary, SUMMARY_MAX_CHARS)
  let details = clean(d.details, DETAILS_MAX_CHARS)
  const title = clean(fields?.fullTitle ?? '', TITLE_IN_BODY_MAX_CHARS)
  let original = clean(fields?.body ?? '', ORIGINAL_MAX_CHARS)
  let thread = clean(
    s.transcript
      .map((e) => `[${e.from === 'bot' ? BOT_TRANSCRIPT_NAME : (e.name ?? UNKNOWN_REPORTER_NAME)}] ${e.text}`)
      .join('\n\n'),
    THREAD_MAX_CHARS,
  )
  const unresolved = d.unresolved
    .slice(0, UNRESOLVED_MAX_ITEMS)
    .map((v) => `- ${clean(v, UNRESOLVED_ITEM_MAX_CHARS)}`)
    .join('\n')
  const files = [...new Map([...s.files, ...s.transcript.flatMap((e) => e.files)].map((f) => [f.id, f])).values()]
  const listed = files
    .slice(0, MAX_LISTED_FILES)
    .map((f) => `- [${linkName(clean(f.name, TITLE_IN_BODY_MAX_CHARS))}](${f.permalink})`)
  if (files.length > MAX_LISTED_FILES)
    listed.push(MORE_FILES_NOTE.replace('{n}', String(files.length - MAX_LISTED_FILES)))
  const render = (): string =>
    [
      `## ${h.summary}\n\n${summary}`,
      `## ${h.details}\n\n${details}`,
      ...(unresolved ? [`## ${h.unresolved}\n\n${unresolved}`] : []),
      `## ${h.info}\n\n| ${t.key} | ${t.value} |\n|---|---|\n| ${t.category} | ${fields?.category ?? ''} |\n| ${t.priority} | ${fields?.priority ?? ''} |\n| ${t.reporter} | ${tableSafe(clean(s.reporterName ?? UNKNOWN_REPORTER_NAME, TITLE_IN_BODY_MAX_CHARS))}${SLACK_REPORTER_SUFFIX} |\n| ${t.slack} | [${t.source}](${s.permalink}) |`,
      ...(listed.length ? [`## ${h.files}\n\n${listed.join('\n')}`] : []),
      `<details>\n<summary>${h.original}</summary>\n\n${fenced(`${title}\n\n${original}\n\n${thread}`)}\n\n</details>`,
      issueMarker(s.channel, s.ts),
    ].join('\n\n')
  let body = render()
  for (const key of ['thread', 'original', 'details'] as const) {
    if (body.length <= ISSUE_BODY_MAX_CHARS) break
    const value = key === 'thread' ? thread : key === 'original' ? original : details
    const shortened = truncate(
      value,
      Math.max(0, value.length - (body.length - ISSUE_BODY_MAX_CHARS) - TRUNCATED_NOTE.length),
    )
    if (key === 'thread') thread = shortened
    else if (key === 'original') original = shortened
    else details = shortened
    body = render()
  }
  return body
}
