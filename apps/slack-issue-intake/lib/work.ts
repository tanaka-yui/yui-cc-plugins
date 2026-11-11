import { downloadFiles, resolveFiles } from './attachments.ts'
import { cachedUserName, saveUserName, transition } from './db.ts'
import {
  CATEGORY_KEYS,
  ERROR_LEASE_LOST,
  ERROR_THREAD_NOT_FOUND,
  MAX_ITEMS_PER_RUN,
  MAX_QUESTION_ROUNDS,
} from './defaults.ts'
import { stopError } from './drive.ts'
import { readJson } from './fs.ts'
import { asArray, asObject, asString } from './json.ts'
import { maskSecrets } from './secrets.ts'
import { fetchReplies, userInfoName } from './slack-api.ts'
import { messageText } from './slack-text.ts'

import { join } from 'node:path'

import type { WorkAttachment } from './attachments.ts'
import type { Submission } from './db.ts'
import type { DriveContext } from './drive.ts'
import type { RunPaths } from './paths.ts'
import type { Category, CategoryKey, Priority, TranscriptEntry } from './types.ts'
export type WorkThreadEntry = {
  from: 'bot' | 'human'
  name: string | null
  text: string
  attachments: WorkAttachment[]
}
export type WorkItem = {
  id: number
  kind: 'new' | 'answered' | 'timed_out'
  mustCreate: boolean
  roundsAsked: number
  maxRounds: number
  title: string
  category: Category
  categoryKey: CategoryKey
  priority: Priority
  reporter: string | null
  body: string
  attachments: WorkAttachment[]
  thread: WorkThreadEntry[]
}
export type WorkFile = { runId: string; createdAt: string; items: WorkItem[] }
export type BuildResult = {
  work: WorkFile
  skipped: Array<{ id: number; reason: string }>
  failed: number[]
  stop: string | null
}
export const buildWork = async (
  ctx: DriveContext,
  candidates: Submission[],
  runId: string,
  run: RunPaths,
): Promise<BuildResult> => {
  const { rt, token } = ctx
  const result: BuildResult = {
    work: { runId, createdAt: ctx.now().toISOString(), items: [] },
    skipped: [],
    failed: [],
    stop: null,
  }
  const name = async (id: string | null): Promise<string | null> => {
    if (!id) return null
    const cached = cachedUserName(rt.db, id, ctx.now().toISOString())
    if (cached) return cached
    const fetched = await userInfoName(rt.slack, id, ctx.deadline)
    if (fetched) saveUserName(rt.db, id, fetched, ctx.now().toISOString())
    return fetched
  }
  const mentions = async (text: string): Promise<string> => {
    let output = text
    for (const match of text.matchAll(/<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g)) {
      const id = match[1] ?? ''
      output = output.replaceAll(match[0], `@${(await name(id)) ?? id}`)
    }
    return maskSecrets(output)
  }
  for (const s of candidates) {
    if (result.work.items.length >= MAX_ITEMS_PER_RUN) break
    const replies = await fetchReplies(rt.slack, s.channel, s.ts, null, ctx.deadline)
    if (!replies.ok) {
      if (replies.error === ERROR_THREAD_NOT_FOUND) {
        if (
          !transition(
            rt.db,
            token,
            s.id,
            s.state,
            { state: 'failed', failedFrom: s.state, lastError: ERROR_THREAD_NOT_FOUND },
            ctx.now().toISOString(),
          )
        ) {
          result.stop = ERROR_LEASE_LOST
          break
        }
        result.failed.push(s.id)
        continue
      }
      result.skipped.push({ id: s.id, reason: replies.error })
      if (stopError(replies.error)) {
        result.stop = replies.error
        break
      }
      continue
    }
    if (!s.fields || !['new', 'answered', 'timed_out'].includes(s.state)) continue
    const transcript: TranscriptEntry[] = []
    for (const m of replies.messages) {
      const userId = asString(m.user)
      const own = m.bot_id === rt.config.slack.botId || userId === rt.config.slack.botUserId
      if (!own && (m.bot_id || !userId)) continue
      transcript.push({
        ts: asString(m.ts) ?? '',
        from: own ? 'bot' : 'human',
        userId,
        name: own ? null : await name(userId),
        text: await mentions(messageText(m).text),
        files: await resolveFiles(rt.slack, m, ctx.deadline),
      })
    }
    const files = await resolveFiles(rt.slack, s.raw, ctx.deadline)
    const reporterName = await name(s.reporterId)
    if (!transition(rt.db, token, s.id, s.state, { transcript, files, reporterName }, ctx.now().toISOString())) {
      result.stop = ERROR_LEASE_LOST
      break
    }
    const dir = join(run.filesDir, String(s.id))
    let index = 1
    const attachments = await downloadFiles(rt.slack, files, dir, index, ctx.deadline)
    index += files.length
    const thread: WorkThreadEntry[] = []
    for (const e of transcript) {
      const attachments = await downloadFiles(rt.slack, e.files, dir, index, ctx.deadline)
      index += e.files.length
      thread.push({ from: e.from, name: e.name, text: e.text, attachments })
    }
    result.work.items.push({
      id: s.id,
      kind: s.state as WorkItem['kind'],
      mustCreate: s.state === 'timed_out' || s.rounds >= MAX_QUESTION_ROUNDS,
      roundsAsked: s.rounds,
      maxRounds: MAX_QUESTION_ROUNDS,
      title: s.fields.title,
      category: s.fields.category,
      categoryKey: CATEGORY_KEYS[s.fields.category],
      priority: s.fields.priority,
      reporter: reporterName,
      body: await mentions(s.fields.body),
      attachments,
      thread,
    })
  }
  return result
}
export const readWork = (file: string): WorkFile | null => {
  const raw = asObject(readJson(file))
  if (!raw || !asString(raw.runId) || !asString(raw.createdAt) || !asArray(raw.items)) return null
  for (const value of asArray(raw.items) ?? []) {
    const item = asObject(value)
    if (
      !item ||
      typeof item.id !== 'number' ||
      !Number.isSafeInteger(item.id) ||
      !['new', 'answered', 'timed_out'].includes(asString(item.kind) ?? '') ||
      typeof item.mustCreate !== 'boolean'
    )
      return null
  }
  return JSON.parse(JSON.stringify(raw)) as WorkFile
}
