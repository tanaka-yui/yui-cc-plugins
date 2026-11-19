import {
  ANSWER_MAX_CHARS,
  ANSWER_MAX_SOURCES,
  DETAILS_MAX_CHARS,
  MAX_TITLE_CHARS,
  QUESTION_KIND_KEYS,
  QUESTION_KIND_UNSURE,
  QUESTION_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  UNRESOLVED_ITEM_MAX_CHARS,
  UNRESOLVED_MAX_ITEMS,
} from './defaults.ts'
import { asArray, asObject, asString } from './json.ts'
import { sourceLink } from './knowledge.ts'

import type { Json, JsonObject } from './json.ts'
import type { StoredDecision } from './types.ts'
import type { WorkFile, WorkItem } from './work.ts'
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
  const create = (id: number, o: JsonObject, title: string | null): Decision => {
    const summary = text(id, o.summary, 'summary', SUMMARY_MAX_CHARS)
    const details = text(id, o.details, 'details', DETAILS_MAX_CHARS)
    const unresolved = asArray(o.unresolved)
    if (!unresolved || unresolved.length > UNRESOLVED_MAX_ITEMS)
      errors.push(`id=${id} unresolved は${UNRESOLVED_MAX_ITEMS}件以内の配列にしてください`)
    return {
      id,
      action: 'create',
      summary,
      details,
      unresolved: (unresolved ?? []).map((v) => text(id, v, 'unresolved', UNRESOLVED_ITEM_MAX_CHARS)),
      ...(title === null ? {} : { title }),
    }
  }
  // 質問の item。answer / close / create（起票を提案済みで、種類が「バグか仕様なのかわからない」の返信のときだけ）
  const question = (id: number, o: JsonObject, item: WorkItem): void => {
    const unsure = item.questionKind === QUESTION_KIND_KEYS[QUESTION_KIND_UNSURE]
    if (item.mustClose && o.action !== 'close') errors.push(`id=${id} は close が必要です`)
    if (o.action === 'answer') {
      const message = text(id, o.message, 'message', ANSWER_MAX_CHARS)
      const sources = o.sources === undefined ? [] : asArray(o.sources)
      const known = item.knowledge?.files ?? []
      if (!sources || sources.length > ANSWER_MAX_SOURCES)
        errors.push(`id=${id} sources は${ANSWER_MAX_SOURCES}件以内の配列にしてください`)
      const paths = (sources ?? []).map((v) => asString(v) ?? '')
      for (const path of paths) if (!known.includes(path)) errors.push(`id=${id} sources の ${path} は索引にありません`)
      if (o.proposeIssue !== undefined && typeof o.proposeIssue !== 'boolean')
        errors.push(`id=${id} proposeIssue は true か false にしてください`)
      const proposeIssue = o.proposeIssue === true
      if (proposeIssue && !unsure) errors.push(`id=${id} proposeIssue は質問の種類が unsure のときだけ使えます`)
      const repo = item.knowledge?.repo ?? ''
      const commit = item.knowledge?.commit ?? ''
      decisions.push({
        id,
        action: 'answer',
        message,
        sources: paths,
        links: paths.map((path) => sourceLink(repo, commit, path)),
        proposeIssue,
      })
    } else if (o.action === 'close')
      decisions.push({ id, action: 'close', message: text(id, o.message, 'message', ANSWER_MAX_CHARS) })
    else if (o.action === 'create') {
      if (!unsure || item.kind !== 'answered' || !item.issueProposed)
        errors.push(`id=${id} は起票を提案して返信を受けた unsure の質問だけ create にできます`)
      decisions.push(create(id, o, text(id, o.title, 'title', MAX_TITLE_CHARS)))
    } else errors.push(`id=${id} action は answer・close・create のどれかにしてください`)
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
    if (item?.questionKind) question(id, o, item)
    else if (o.action === 'ask') {
      if (item?.mustCreate) errors.push(`id=${id} は create が必要です`)
      decisions.push({ id, action: 'ask', message: text(id, o.message, 'message', QUESTION_MAX_CHARS) })
    } else if (o.action === 'create') decisions.push(create(id, o, null))
    else errors.push(`id=${id} action は ask または create にしてください`)
  }
  for (const id of ids.keys()) if (!seen.has(id)) errors.push(`id=${id} の決定がありません`)
  return errors.length ? { ok: false, errors } : { ok: true, value: { runId: work.runId, decisions } }
}
