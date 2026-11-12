import { SQLITE_BUSY_TIMEOUT_MS, USER_NAME_TTL_HOURS } from './defaults.ts'
import { ensurePrivateDir } from './fs.ts'
import { maskSecrets } from './secrets.ts'
import { compareTs, tsMicro } from './slack-text.ts'

import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { JsonObject } from './json.ts'
import type {
  FileRef,
  HistoryScan,
  InflightRecord,
  ProcessIdentity,
  State,
  StoredDecision,
  SubmissionFields,
  TranscriptEntry,
} from './types.ts'
export type Db = DatabaseSync
export const AGENT_STATES: readonly State[] = ['new', 'answered', 'timed_out']
export const DRIVEN_STATES: readonly State[] = ['asking', 'creating', 'notifying', 'rejecting']
export const ALL_STATES: readonly State[] = [
  'new',
  'asking',
  'waiting',
  'answered',
  'timed_out',
  'creating',
  'notifying',
  'created',
  'rejecting',
  'rejected',
  'failed',
]
export type Submission = {
  id: number
  channel: string
  ts: string
  permalink: string
  raw: JsonObject
  fields: SubmissionFields | null
  problems: string[]
  reporterId: string | null
  reporterName: string | null
  files: FileRef[]
  state: State
  failedFrom: State | null
  rounds: number
  lastQuestionTs: string | null
  askedAt: string | null
  timedOutAt: string | null
  transcript: TranscriptEntry[]
  decision: StoredDecision | null
  createStartedAt: string | null
  createLogin: string | null
  inflight: InflightRecord | null
  issueUrl: string | null
  issueNumber: number | null
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}
export type NewSubmission = Pick<
  Submission,
  'channel' | 'ts' | 'permalink' | 'raw' | 'fields' | 'problems' | 'reporterId'
> & { state: 'new' | 'rejecting' }
export type SubmissionPatch = Partial<Omit<Submission, 'id' | 'channel' | 'ts' | 'createdAt' | 'updatedAt'>>
type Row = Record<string, SQLOutputValue>
export const inTransaction = <T>(db: Db, fn: () => T): T => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
export const leaseValid = (db: Db, token: string, now: string): boolean =>
  Boolean(db.prepare('SELECT 1 FROM lease WHERE id=1 AND token=? AND expires_at>?').get(token, now))
export const openDb = (file: string): Db => {
  ensurePrivateDir(dirname(file))
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,fetched_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,token TEXT NOT NULL,run_id TEXT,phase TEXT NOT NULL,pid INTEGER NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS submissions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,ts TEXT NOT NULL,ts_micro INTEGER NOT NULL,permalink TEXT NOT NULL,
      raw TEXT NOT NULL,fields TEXT,problems TEXT NOT NULL,reporter_id TEXT,reporter_name TEXT,files TEXT NOT NULL,state TEXT NOT NULL,failed_from TEXT,
      rounds INTEGER NOT NULL,last_question_ts TEXT,asked_at TEXT,timed_out_at TEXT,transcript TEXT NOT NULL,decision TEXT,create_started_at TEXT,create_login TEXT,
      inflight TEXT,issue_url TEXT,issue_number INTEGER,attempts INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(channel,ts));
    CREATE INDEX IF NOT EXISTS submissions_state_ts ON submissions(state,ts_micro);
    CREATE TABLE IF NOT EXISTS issue_status(issue_number INTEGER PRIMARY KEY,status TEXT,state TEXT NOT NULL,
      last_comment_id INTEGER NOT NULL,seen_updated_at TEXT,attempts INTEGER NOT NULL,updated_at TEXT NOT NULL);`)
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema_version','1')").run()
  return db
}
export const getMeta = (db: Db, key: string): string | null => {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key)
  return r ? String(r.value) : null
}
export const setMeta = (db: Db, key: string, value: string): void => {
  db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
export const deleteMeta = (db: Db, key: string): void => {
  db.prepare('DELETE FROM meta WHERE key=?').run(key)
}
const nullable = (r: Row, key: string): string | null =>
  r[key] === null || r[key] === undefined ? null : String(r[key])
const decode = (r: Row): Submission => ({
  id: Number(r.id),
  channel: String(r.channel),
  ts: String(r.ts),
  permalink: String(r.permalink),
  raw: JSON.parse(String(r.raw)) as JsonObject,
  fields: JSON.parse(String(r.fields ?? 'null')) as SubmissionFields | null,
  problems: JSON.parse(String(r.problems)) as string[],
  reporterId: nullable(r, 'reporter_id'),
  reporterName: nullable(r, 'reporter_name'),
  files: JSON.parse(String(r.files)) as FileRef[],
  state: String(r.state) as State,
  failedFrom: nullable(r, 'failed_from') as State | null,
  rounds: Number(r.rounds),
  lastQuestionTs: nullable(r, 'last_question_ts'),
  askedAt: nullable(r, 'asked_at'),
  timedOutAt: nullable(r, 'timed_out_at'),
  transcript: JSON.parse(String(r.transcript)) as TranscriptEntry[],
  decision: JSON.parse(String(r.decision ?? 'null')) as StoredDecision | null,
  createStartedAt: nullable(r, 'create_started_at'),
  createLogin: nullable(r, 'create_login'),
  inflight: JSON.parse(String(r.inflight ?? 'null')) as InflightRecord | null,
  issueUrl: nullable(r, 'issue_url'),
  issueNumber: r.issue_number === null ? null : Number(r.issue_number),
  attempts: Number(r.attempts),
  lastError: nullable(r, 'last_error'),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
export const insertSubmission = (db: Db, input: NewSubmission, now: string): number | null => {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO submissions(channel,ts,ts_micro,permalink,raw,fields,problems,reporter_id,files,state,rounds,transcript,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'[]',?,0,'[]',0,?,?)`,
    )
    .run(
      input.channel,
      input.ts,
      tsMicro(input.ts),
      input.permalink,
      maskSecrets(JSON.stringify(input.raw)),
      maskSecrets(JSON.stringify(input.fields)),
      JSON.stringify(input.problems),
      input.reporterId,
      input.state,
      now,
      now,
    )
  return r.changes ? Number(r.lastInsertRowid) : null
}
export const getSubmission = (db: Db, id: number): Submission | null => {
  const r = db.prepare('SELECT * FROM submissions WHERE id=?').get(id)
  return r ? decode(r) : null
}
export const listByStates = (db: Db, states: readonly State[], limit = Number.MAX_SAFE_INTEGER): Submission[] =>
  states.length
    ? db
        .prepare(
          `SELECT * FROM submissions WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY ts_micro,id LIMIT ?`,
        )
        .all(...states, limit)
        .map(decode)
    : []
export const countByState = (db: Db): Record<State, number> =>
  Object.fromEntries(
    ALL_STATES.map((s) => [
      s,
      Number(db.prepare('SELECT count(*) AS n FROM submissions WHERE state=?').get(s)?.n ?? 0),
    ]),
  ) as Record<State, number>
const jsonKeys = new Set(['raw', 'fields', 'problems', 'files', 'transcript', 'decision', 'inflight'])
const patchUpdate = (db: Db, id: number, patch: SubmissionPatch, now: string): void => {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  const columns = entries.map(([key]) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
  const values: SQLInputValue[] = entries.map(([key, value]) =>
    jsonKeys.has(key)
      ? maskSecrets(JSON.stringify(value))
      : typeof value === 'string'
        ? maskSecrets(value)
        : (value as number | null),
  )
  db.prepare(`UPDATE submissions SET ${[...columns.map((c) => `${c}=?`), 'updated_at=?'].join(',')} WHERE id=?`).run(
    ...values,
    now,
    id,
  )
}
export const transition = (
  db: Db,
  token: string,
  id: number,
  from: State,
  patch: SubmissionPatch,
  now: string,
): boolean =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now) || getSubmission(db, id)?.state !== from) return false
    patchUpdate(db, id, patch, now)
    return true
  })
// Issue のステータスの前回の記録。通知はこれとの差だけを出す（submissions の created は書き換えない決まりなので別の表）
export type IssueStatusRow = {
  issueNumber: number
  status: string | null
  state: 'open' | 'closed'
  lastCommentId: number
  seenUpdatedAt: string | null
  attempts: number
}
export const getIssueStatus = (db: Db, issueNumber: number): IssueStatusRow | null => {
  const r = db.prepare('SELECT * FROM issue_status WHERE issue_number=?').get(issueNumber)
  return r
    ? {
        issueNumber: Number(r.issue_number),
        status: nullable(r, 'status'),
        state: String(r.state) === 'closed' ? 'closed' : 'open',
        lastCommentId: Number(r.last_comment_id),
        seenUpdatedAt: nullable(r, 'seen_updated_at'),
        attempts: Number(r.attempts),
      }
    : null
}
const writeIssueStatus = (db: Db, row: IssueStatusRow, now: string, replace: boolean): void => {
  db.prepare(
    `INSERT INTO issue_status VALUES (?,?,?,?,?,?,?) ON CONFLICT(issue_number) DO ${
      replace
        ? 'UPDATE SET status=excluded.status,state=excluded.state,last_comment_id=excluded.last_comment_id,seen_updated_at=excluded.seen_updated_at,attempts=excluded.attempts,updated_at=excluded.updated_at'
        : 'NOTHING'
    }`,
  ).run(row.issueNumber, row.status, row.state, row.lastCommentId, row.seenUpdatedAt, row.attempts, now)
}
export const saveIssueStatus = (db: Db, token: string, row: IssueStatusRow, now: string): boolean =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now)) return false
    writeIssueStatus(db, row, now, true)
    return true
  })
// 起票（または既存の Issue の採用）と同じトランザクションで、最初の状態を記録する。すでに行があれば残す
export const transitionWithStatus = (
  db: Db,
  token: string,
  id: number,
  from: State,
  patch: SubmissionPatch,
  seed: IssueStatusRow,
  now: string,
): boolean =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now) || getSubmission(db, id)?.state !== from) return false
    patchUpdate(db, id, patch, now)
    writeIssueStatus(db, seed, now, false)
    return true
  })
export type TrackedIssue = { channel: string; ts: string; reporterId: string | null }
export const trackedIssues = (db: Db): Map<number, TrackedIssue> =>
  new Map(
    db
      .prepare('SELECT issue_number,channel,ts,reporter_id FROM submissions WHERE issue_number IS NOT NULL')
      .all()
      .map((r) => [
        Number(r.issue_number),
        { channel: String(r.channel), ts: String(r.ts), reporterId: nullable(r, 'reporter_id') },
      ]),
  )
export const getScan = (db: Db): HistoryScan | null =>
  JSON.parse(getMeta(db, 'history_scan') ?? 'null') as HistoryScan | null
export const saveScan = (db: Db, token: string, scan: HistoryScan, now: string): boolean =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now)) return false
    setMeta(db, 'history_scan', JSON.stringify(scan))
    return true
  })
export const completeSlice = (db: Db, token: string, sliceLatest: string, now: string): boolean =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now) || compareTs(sliceLatest, getMeta(db, 'cursor_ts') ?? '0') < 0) return false
    setMeta(db, 'cursor_ts', sliceLatest)
    db.prepare("DELETE FROM meta WHERE key='history_scan'").run()
    return true
  })
export const setInflight = (db: Db, token: string, id: number, record: InflightRecord, now: string): boolean =>
  transition(db, token, id, 'creating', { inflight: record }, now)
export const confirmInflightDead = (db: Db, token: string, id: number, now: string): string | null =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now)) return null
    const s = getSubmission(db, id)
    if (s?.state !== 'creating' || !s.inflight) return null
    const at = s.inflight.deadConfirmedAt ?? now
    patchUpdate(db, id, { inflight: { ...s.inflight, deadConfirmedAt: at } }, now)
    return at
  })
export const setInflightChild = (db: Db, id: number, ownerPid: number, child: ProcessIdentity): boolean =>
  inTransaction(db, () => {
    const s = getSubmission(db, id)
    if (s?.state !== 'creating' || s.inflight?.owner.pid !== ownerPid) return false
    patchUpdate(db, id, { inflight: { ...s.inflight, child } }, s.updatedAt)
    return true
  })
export const registerRun = (db: Db, token: string, runId: string, now: string): number | null =>
  inTransaction(db, () => {
    if (!leaseValid(db, token, now)) return null
    return Number(db.prepare('INSERT INTO runs(run_id,created_at) VALUES (?,?)').run(runId, now).lastInsertRowid)
  })
export const olderRuns = (db: Db, seq: number): string[] =>
  db
    .prepare('SELECT run_id FROM runs WHERE seq<? ORDER BY seq')
    .all(seq)
    .map((r) => String(r.run_id))
export const forgetRun = (db: Db, runId: string): void => {
  db.prepare('DELETE FROM runs WHERE run_id=?').run(runId)
}
export const cachedUserName = (db: Db, userId: string, now: string): string | null => {
  const r = db.prepare('SELECT * FROM users WHERE id=?').get(userId)
  return r && Date.parse(now) - Date.parse(String(r.fetched_at)) < USER_NAME_TTL_HOURS * 3600000 ? String(r.name) : null
}
export const saveUserName = (db: Db, userId: string, name: string, now: string): void => {
  db.prepare(
    'INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,fetched_at=excluded.fetched_at',
  ).run(userId, maskSecrets(name), now)
}
