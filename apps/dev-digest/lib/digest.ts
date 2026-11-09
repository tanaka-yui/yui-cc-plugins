import { asArray, asObject, asString } from './json.ts'

import type { Json } from './json.ts'
import type { PendingFile } from './pending.ts'

export type DigestNote = { id: number; summaryJa: string; tags: string[] }
export type DigestGroup = { key: string; titleJa: string; summaryJa: string; itemIds: number[] }
export type DigestFile = {
  runId: number
  notes: DigestNote[]
  groups: DigestGroup[]
  repos: Array<{ slug: string; itemIds: number[] }>
}

export type DigestValidation = { ok: true; digest: DigestFile } | { ok: false; errors: string[] }

const isInt = (value: Json | undefined): value is number => typeof value === 'number' && Number.isInteger(value)

// 整数の配列。配列でなければ null、要素が整数でなければ errors に書く
const idList = (value: Json | undefined, field: string, errors: string[]): number[] | null => {
  const array = asArray(value)
  if (array === null) {
    errors.push(`${field}: 配列にしてください`)
    return null
  }
  const ids: number[] = []
  for (const [index, entry] of array.entries()) {
    if (isInt(entry)) ids.push(entry)
    else errors.push(`${field}[${index}]: 整数にしてください`)
  }
  return ids
}

export const validateDigest = (value: Json, pending: PendingFile): DigestValidation => {
  const errors: string[] = []
  const root = asObject(value)
  if (root === null) return { ok: false, errors: ['digest: オブジェクトにしてください'] }
  if (root.runId !== pending.runId) errors.push(`runId: ${pending.runId} にしてください`)
  const known = new Set(pending.items.map((item) => item.id))
  const checkKnown = (ids: number[], field: string): void => {
    for (const id of ids) if (!known.has(id)) errors.push(`${field}: id ${id} は pending にありません`)
  }

  // notes は欠けてもよい（publish が補う）
  const notes: DigestNote[] = []
  if (root.notes !== undefined) {
    const array = asArray(root.notes)
    if (array === null) errors.push('notes: 配列にしてください')
    for (const [index, entry] of (array ?? []).entries()) {
      const field = `notes[${index}]`
      const note = asObject(entry)
      if (note === null) {
        errors.push(`${field}: オブジェクトにしてください`)
        continue
      }
      const summaryJa = asString(note.summaryJa)
      const tagArray = asArray(note.tags)
      const tags = tagArray?.filter((tag): tag is string => typeof tag === 'string') ?? []
      if (!isInt(note.id)) errors.push(`${field}.id: 整数にしてください`)
      else checkKnown([note.id], `${field}.id`)
      if (summaryJa === null) errors.push(`${field}.summaryJa: 文字列にしてください`)
      if (tagArray === null || tags.length !== tagArray.length) errors.push(`${field}.tags: 文字列の配列にしてください`)
      if (isInt(note.id) && summaryJa !== null) notes.push({ id: note.id, summaryJa, tags })
    }
  }

  const groups: DigestGroup[] = []
  const grouped = new Set<number>()
  const groupArray = asArray(root.groups)
  if (groupArray === null) errors.push('groups: 配列にしてください')
  for (const [index, entry] of (groupArray ?? []).entries()) {
    const field = `groups[${index}]`
    const group = asObject(entry)
    if (group === null) {
      errors.push(`${field}: オブジェクトにしてください`)
      continue
    }
    const key = asString(group.key)
    const titleJa = asString(group.titleJa)
    const summaryJa = asString(group.summaryJa)
    if (key === null) errors.push(`${field}.key: 文字列にしてください`)
    if (titleJa === null) errors.push(`${field}.titleJa: 文字列にしてください`)
    if (summaryJa === null) errors.push(`${field}.summaryJa: 文字列にしてください`)
    const itemIds = idList(group.itemIds, `${field}.itemIds`, errors)
    if (itemIds === null) continue
    if (itemIds.length === 0) errors.push(`${field}.itemIds: 1 件以上にしてください`)
    checkKnown(itemIds, `${field}.itemIds`)
    for (const id of itemIds) {
      if (grouped.has(id)) errors.push(`${field}.itemIds: id ${id} は別の group にも入っています`)
      grouped.add(id)
    }
    if (key !== null && titleJa !== null && summaryJa !== null) groups.push({ key, titleJa, summaryJa, itemIds })
  }

  const repos: DigestFile['repos'] = []
  const repoArray = asArray(root.repos)
  if (repoArray === null) errors.push('repos: 配列にしてください')
  for (const [index, entry] of (repoArray ?? []).entries()) {
    const field = `repos[${index}]`
    const repo = asObject(entry)
    if (repo === null) {
      errors.push(`${field}: オブジェクトにしてください`)
      continue
    }
    const slug = asString(repo.slug)
    const itemIds = idList(repo.itemIds, `${field}.itemIds`, errors)
    if (slug === null) {
      errors.push(`${field}.slug: 文字列にしてください`)
      continue
    }
    const target = pending.repos.find((candidate) => candidate.slug === slug)
    if (target === undefined) {
      errors.push(`${field}.slug: ${slug} は pending にありません`)
      continue
    }
    if (itemIds === null) continue
    const allowed = new Set([...target.candidateIds, ...target.ownIds])
    for (const id of itemIds) {
      if (!allowed.has(id)) errors.push(`${field}.itemIds: id ${id} は ${slug} の候補にありません`)
    }
    repos.push({ slug, itemIds })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, digest: { runId: pending.runId, notes, groups, repos } }
}
