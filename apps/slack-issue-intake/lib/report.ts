import { getMeta, writeMetaFenced } from './db.ts'
import {
  ERROR_DEADLINE,
  ERROR_LEASE_LOST,
  META_REPORT_CHANNEL,
  META_REPORT_DAY,
  META_REPORT_HASH,
  META_REPORT_TS,
  REPORT_QUEUE_MAX_LINES,
  REPORT_SOURCE_DIR,
  REPORT_SOURCE_FILE,
  REPORT_STALE_FACTOR,
  REPORT_TEXT,
} from './defaults.ts'
import { readJson } from './fs.ts'
import { asArray, asObject } from './json.ts'
import { renewLease } from './lease.ts'
import { claudeHome } from './paths.ts'
import { maskSecrets } from './secrets.ts'
import { createSlackClient, postMessage, updateMessage } from './slack-api.ts'
import { escapeMrkdwn } from './slack-text.ts'

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { DriveContext } from './drive.ts'
import type { Json, JsonObject } from './json.ts'

export type AutoReport = {
  version: 1
  name: string
  updatedAt: string
  everyMinutes: number
  running: Array<{ issue: string; title: string; host: string; startedAt: string; limitMinutes: number }>
  queue: Array<{ issue: string; title: string; priority: string }>
  hosts: Array<{ name: string; used: number; max: number; reachable: boolean }>
}
export type ReportResult = { posted: 'new' | 'updated' | 'unchanged' | 'off' | 'failed'; errors: string[] }
const strings = (o: JsonObject, keys: readonly string[]): boolean => keys.every((k) => typeof o[k] === 'string')
const date = (v: Json | undefined): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v))
const number = (v: Json | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
export const readReport = (path: string): AutoReport | null => {
  const o = asObject(readJson(path))
  if (
    !o ||
    o.version !== 1 ||
    typeof o.name !== 'string' ||
    !date(o.updatedAt) ||
    !number(o.everyMinutes) ||
    o.everyMinutes <= 0
  )
    return null
  const running = asArray(o.running)
  const queue = asArray(o.queue)
  const hosts = asArray(o.hosts)
  if (!running || !queue || !hosts) return null
  for (const value of running) {
    const r = asObject(value)
    if (!r || !strings(r, ['issue', 'title', 'host']) || !date(r.startedAt) || !number(r.limitMinutes)) return null
  }
  for (const value of queue) {
    const r = asObject(value)
    if (!r || !strings(r, ['issue', 'title', 'priority'])) return null
  }
  for (const value of hosts) {
    const r = asObject(value)
    if (!r || typeof r.name !== 'string' || !number(r.used) || !number(r.max) || typeof r.reachable !== 'boolean')
      return null
  }
  return o as AutoReport
}
const pad = (n: number): string => String(n).padStart(2, '0')
const time = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match))
const safe = (s: string): string => escapeMrkdwn(maskSecrets(s))
export const renderReport = (report: AutoReport, now: Date): string => {
  const updated = new Date(report.updatedAt)
  const lines: string[] = []
  if (now.getTime() - updated.getTime() > report.everyMinutes * REPORT_STALE_FACTOR * 60000)
    lines.push(fill(REPORT_TEXT.stale, { time: time(updated) }))
  lines.push(
    fill(REPORT_TEXT.heading, { date: `${updated.getMonth() + 1}/${updated.getDate()}`, time: time(updated) }),
    fill(REPORT_TEXT.running, { n: report.running.length }),
  )
  for (const r of report.running)
    lines.push(
      fill(REPORT_TEXT.runningItem, {
        issue: safe(r.issue),
        title: safe(r.title),
        host: safe(r.host),
        elapsed: Math.floor((updated.getTime() - Date.parse(r.startedAt)) / 60000),
        limit: r.limitMinutes,
      }),
    )
  lines.push(fill(REPORT_TEXT.queue, { n: report.queue.length }))
  for (const [i, q] of report.queue.slice(0, REPORT_QUEUE_MAX_LINES).entries())
    lines.push(
      fill(REPORT_TEXT.queueItem, {
        order: i + 1,
        priority: safe(q.priority),
        issue: safe(q.issue),
        title: safe(q.title),
      }),
    )
  if (report.queue.length > REPORT_QUEUE_MAX_LINES)
    lines.push(fill(REPORT_TEXT.more, { n: report.queue.length - REPORT_QUEUE_MAX_LINES }))
  lines.push(
    REPORT_TEXT.hosts +
      (report.hosts
        .map((h) =>
          fill(h.reachable ? REPORT_TEXT.host : REPORT_TEXT.unreachable, {
            name: safe(h.name),
          }),
        )
        .join('・') || REPORT_TEXT.none),
  )
  return lines.join('\n')
}
export const postReport = async (ctx: DriveContext): Promise<ReportResult> => {
  const { rt, token } = ctx
  const setting = rt.config.report
  if (!setting.source) return { posted: 'off', errors: [] }
  const report = readReport(setting.source)
  if (!report)
    return { posted: 'failed', errors: [maskSecrets(fill(REPORT_TEXT.unreadable, { path: setting.source }))] }
  // 報告先だけの失敗を、起票・既存 Issue の取り込みに使うクライアントへ持ち越さない
  const slack = createSlackClient(rt.token)
  const errors: string[] = []
  const failed = (): ReportResult => ({ posted: 'failed', errors })
  const valid = (): boolean => {
    if (Date.now() >= ctx.deadline) {
      errors.push(ERROR_DEADLINE)
      return false
    }
    if (!renewLease(rt.db, token, ctx.now(), ctx.ttlMs)) {
      errors.push(ERROR_LEASE_LOST)
      return false
    }
    return true
  }
  const now = ctx.now()
  const channel = setting.channel ?? rt.config.channel
  const text = renderReport(report, now)
  const hash = createHash('sha256').update(text).digest('hex')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const [hours = 0, minutes = 0] = setting.dailyAt.split(':').map(Number)
  const afterDaily = now.getHours() * 60 + now.getMinutes() >= hours * 60 + minutes
  const save = (set: Record<string, string>): boolean => {
    if (!valid()) return false
    if (writeMetaFenced(rt.db, token, ctx.now().toISOString(), set)) return true
    errors.push(ERROR_LEASE_LOST)
    return false
  }
  const post = async (): Promise<ReportResult> => {
    if (!valid()) return failed()
    const r = await postMessage(slack, channel, text, ctx.deadline)
    if (!r.ok) {
      errors.push(maskSecrets(r.error))
      return failed()
    }
    return save({
      [META_REPORT_TS]: r.ts,
      [META_REPORT_CHANNEL]: channel,
      [META_REPORT_HASH]: hash,
      ...(afterDaily ? { [META_REPORT_DAY]: today } : {}),
    })
      ? { posted: 'new', errors }
      : failed()
  }
  const ts = getMeta(rt.db, META_REPORT_TS)
  if (
    !ts ||
    getMeta(rt.db, META_REPORT_CHANNEL) !== channel ||
    (afterDaily && getMeta(rt.db, META_REPORT_DAY) !== today)
  )
    return post()
  if (getMeta(rt.db, META_REPORT_HASH) === hash) return { posted: 'unchanged', errors }
  if (!valid()) return failed()
  const r = await updateMessage(slack, channel, ts, text, ctx.deadline)
  if (r.ok) return save({ [META_REPORT_HASH]: hash }) ? { posted: 'updated', errors } : failed()
  if (r.error === 'message_not_found') return post()
  errors.push(maskSecrets(r.error))
  return failed()
}

export const findReportSources = (): string[] => {
  const root = join(claudeHome(), ...REPORT_SOURCE_DIR)
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name, REPORT_SOURCE_FILE))
      .filter((path) => existsSync(path))
  } catch {
    return []
  }
}
