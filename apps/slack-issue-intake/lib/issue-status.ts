import {
  MSG_STATUS_CHANGED,
  MSG_STATUS_DONE,
  MSG_STATUS_NONE,
  MSG_STATUS_REOPENED,
  ORCA_MARKER_PATTERN,
  STATUS_COMMENT_MAX_CHARS,
  STATUS_EVENT_STALLED,
  STATUS_EVENTS,
  STATUS_LABELS,
  TRUSTED_ASSOCIATIONS,
} from './defaults.ts'
import { truncate } from './issue-body.ts'
import { maskSecrets } from './secrets.ts'
import { escapeMrkdwn } from './slack-text.ts'

const DONE = STATUS_LABELS.find((l) => l.slug === 'done')?.name

// 付いているステータスラベル。2 つ以上なら STATUS_LABELS の並び（優先順）で先のもの。名前は大文字小文字を区別しない
export const currentStatus = (labelNames: string[]): string | null => {
  const names = new Set(labelNames.map((n) => n.toLowerCase()))
  return STATUS_LABELS.find((l) => names.has(l.name.toLowerCase()))?.name ?? null
}
export const statusSlug = (name: string | null): string | null =>
  STATUS_LABELS.find((l) => l.name === name)?.slug ?? null

// コメントの空でない最終行が orca-team-dispatch-task のマーカーなら、その中身
export const parseMarker = (body: string): { slug: string; generation: number; event: string } | null => {
  const last = body
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .at(-1)
    ?.trim()
  const m = last?.match(ORCA_MARKER_PATTERN)
  if (!m?.[1] || !m[2] || !m[3] || !STATUS_LABELS.some((l) => l.slug === m[1])) return null
  return { slug: m[1], generation: Number(m[2]), event: m[3] }
}
export const isTrusted = (comment: { authorAssociation: string; login: string }, botLogin: string): boolean =>
  TRUSTED_ASSOCIATIONS.includes(comment.authorAssociation) || comment.login === botLogin

// GitHub のコメントを Slack の本文にする。HTML コメントの行を除き、秘密を伏せ、< > & を無効にしてから、太字とリンクだけを Slack の形にする
export const slackifyComment = (body: string): string =>
  truncate(
    escapeMrkdwn(
      maskSecrets(
        body
          .split(/\r?\n/)
          .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
          .join('\n')
          .trim(),
      ),
    )
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      .replace(/\[([^\]|\n]+)\]\((https?:\/\/[^\s)|]+)\)/g, '<$2|$1>'),
    STATUS_COMMENT_MAX_CHARS,
  )

export type StatusChange = {
  from: { status: string | null; state: string }
  to: { status: string | null; state: string }
  // 信じられるマーカー付きのコメント（書き手と、ラベルとの一致は呼び出し側で確かめる）
  marker: { event: string; body: string } | null
}
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)

// スレッドへ書く文。null は知らせない
export const renderStatusMessage = (change: StatusChange, issueUrl: string, mention: string): string | null => {
  const { from, to, marker } = change
  const changed = from.status !== to.status || from.state !== to.state
  const event = marker ? STATUS_EVENTS[marker.event] : undefined
  if (marker && event?.template && (changed || marker.event === STATUS_EVENT_STALLED)) {
    const comment = slackifyComment(marker.body)
    const text = fill(event.template, { issue: issueUrl, comment }).replace(/\n\n$/, '')
    return (event.mention ? mention : '') + text
  }
  if (!changed) return null
  if ((to.state === 'closed' && from.state !== 'closed') || (to.status === DONE && from.status !== DONE))
    return fill(MSG_STATUS_DONE, { issue: issueUrl })
  const name = to.status ?? MSG_STATUS_NONE
  if (from.state === 'closed' && to.state === 'open') return fill(MSG_STATUS_REOPENED, { to: name, issue: issueUrl })
  return fill(MSG_STATUS_CHANGED, { from: from.status ?? MSG_STATUS_NONE, to: name, issue: issueUrl })
}
