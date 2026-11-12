import {
  DETAILS_MAX_CHARS,
  QUESTION_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  UNRESOLVED_ITEM_MAX_CHARS,
  UNRESOLVED_MAX_ITEMS,
} from './defaults.ts'
import { asArray, asObject, asString } from './json.ts'

import type { Json } from './json.ts'
import type { StoredDecision } from './types.ts'
import type { WorkFile } from './work.ts'
export type Decision = { id: number } & StoredDecision
export type DecisionsFile = { runId: string; decisions: Decision[] }
export const validateDecisions = (
  raw: Json | null,
  work: WorkFile,
): { ok: true; value: DecisionsFile } | { ok: false; errors: string[] } => {
  const errors: string[] = []
  const object = asObject(raw)
  const decisions: Decision[] = []
  if (!object) return { ok: false, errors: ['決定ファイルはJSONオブジェクトにしてください'] }
  if (object.runId !== work.runId) errors.push('runId が一致しません')
  const entries = asArray(object.decisions)
  if (!entries) errors.push('decisions は配列にしてください')
  const ids = new Map(work.items.map((item) => [item.id, item]))
  const seen = new Set<number>()
  const text = (id: number, value: Json | undefined, label: string, max: number): string => {
    const s = asString(value)
    if (!s?.trim() || s.length > max) errors.push(`id=${id} ${label} は1〜${max}文字にしてください`)
    return s ?? ''
  }
  for (const entry of entries ?? []) {
    const o = asObject(entry)
    if (!o || typeof o.id !== 'number' || !Number.isSafeInteger(o.id)) {
      errors.push('決定に整数のidが必要です')
      continue
    }
    const id = o.id
    const item = ids.get(id)
    if (!item) errors.push(`id=${id} は今回の対象にありません`)
    if (seen.has(id)) errors.push(`id=${id} が重複しています`)
    seen.add(id)
    if (o.action === 'ask') {
      if (item?.mustCreate) errors.push(`id=${id} は create が必要です`)
      decisions.push({ id, action: 'ask', message: text(id, o.message, 'message', QUESTION_MAX_CHARS) })
    } else if (o.action === 'create') {
      const summary = text(id, o.summary, 'summary', SUMMARY_MAX_CHARS)
      const details = text(id, o.details, 'details', DETAILS_MAX_CHARS)
      const unresolved = asArray(o.unresolved)
      if (!unresolved || unresolved.length > UNRESOLVED_MAX_ITEMS)
        errors.push(`id=${id} unresolved は${UNRESOLVED_MAX_ITEMS}件以内の配列にしてください`)
      decisions.push({
        id,
        action: 'create',
        summary,
        details,
        unresolved: (unresolved ?? []).map((v) => text(id, v, 'unresolved', UNRESOLVED_ITEM_MAX_CHARS)),
      })
    } else errors.push(`id=${id} action は ask または create にしてください`)
  }
  for (const id of ids.keys()) if (!seen.has(id)) errors.push(`id=${id} の決定がありません`)
  return errors.length ? { ok: false, errors } : { ok: true, value: { runId: work.runId, decisions } }
}
