import { AUTO_FILES, autoDir } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asObject, type Json } from './json.ts'
import { sleepSeconds } from './sys.ts'

import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export const AUTO_LOCK_WAIT_MS = 120_000
export const AUTO_LOCK_TTL_MS = 160_000

export type Priority = 'critical' | 'high' | 'middle' | 'low'
export type Phase =
  | 'judging'
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'finishing'
  | 'review'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'eng'
export type PrRef = { repo: string; number: number; url: string }
export type IssueState = {
  key: string
  repo: string
  number: number
  title: string
  generation: number
  phase: Phase
  priority: Priority
  category: string
  readyAt: string
  targets: string[]
  limitMinutes: number
  relayMinutes: number
  reason: string
  slug: string
  statusDir: string
  branch: string
  branches: Record<string, string>
  prevBranches: Record<string, string>
  prevTargets: string[]
  host: string | null
  hostUnreachableSince: string | null
  coordinator: string | null
  worktrees: number
  startedAt: string | null
  stalledNotified: boolean
  startFailures: number
  startAttempt: { at: string; pid: number; host: string } | null
  prs: PrRef[]
  decisions: string[]
  reviewPoints: string[]
  finishingSince: string | null
  cleanupPending: boolean
  returnedFromEng: boolean
  endedAt: string | null
  checkedAt: string | null
  prevBranch: string | null
  prevPrs: PrRef[]
  pendingLabel: {
    event: string
    from: string
    to: string
    close: boolean
    body: string
    commented: boolean
    labeled: boolean
    then: Phase
  } | null
  failReason: string | null
  updatedAt: string
}
export type ProjectPair = { status: string; label: string }
export type AutoState = {
  version: 1
  judgingSince: string | null
  issues: Record<string, IssueState>
  projectSync: Record<string, ProjectPair>
}
export const limitOf = (issue: Pick<IssueState, 'limitMinutes' | 'relayMinutes'>): number =>
  issue.limitMinutes + issue.relayMinutes
export const readState = (name: string): AutoState => {
  const file = join(autoDir(name), AUTO_FILES.state)
  if (!existsSync(file)) return { version: 1, judgingSince: null, issues: {}, projectSync: {} }
  const value = asObject(readJson(file))
  const issues = asObject(value?.issues)
  if (
    !value ||
    value.version !== 1 ||
    !issues ||
    (value.judgingSince !== null && typeof value.judgingSince !== 'string')
  )
    throw new Error('状態ファイルが壊れています')
  for (const [key, entry] of Object.entries(issues)) {
    const issue = asObject(entry)
    if (
      !issue ||
      issue.key !== key ||
      ![
        'judging',
        'queued',
        'dispatching',
        'running',
        'finishing',
        'review',
        'done',
        'failed',
        'stopped',
        'eng',
      ].includes(String(issue.phase)) ||
      typeof issue.generation !== 'number' ||
      !Array.isArray(issue.targets) ||
      !Array.isArray(issue.prs)
    )
      throw new Error(`状態ファイルが壊れています: ${key}`)
    for (const field of ['branches', 'prevBranches']) {
      if (issue[field] === undefined) issue[field] = {}
      else {
        const branches = asObject(issue[field])
        if (!branches || Object.values(branches).some((v) => typeof v !== 'string'))
          throw new Error(`状態ファイルが壊れています: ${key}`)
      }
    }
    if (issue.relayMinutes === undefined) issue.relayMinutes = 0
    else if (typeof issue.relayMinutes !== 'number' || !Number.isInteger(issue.relayMinutes) || issue.relayMinutes < 0)
      throw new Error(`状態ファイルが壊れています: ${key}`)
    if (issue.reviewPoints === undefined) issue.reviewPoints = []
    else if (!Array.isArray(issue.reviewPoints) || issue.reviewPoints.some((v) => typeof v !== 'string'))
      throw new Error(`状態ファイルが壊れています: ${key}`)
    if (issue.prevTargets === undefined) issue.prevTargets = []
    else if (!Array.isArray(issue.prevTargets) || issue.prevTargets.some((v) => typeof v !== 'string'))
      throw new Error(`状態ファイルが壊れています: ${key}`)
    for (const field of ['host', 'hostUnreachableSince']) {
      if (issue[field] === undefined) issue[field] = null
      else if (issue[field] !== null && typeof issue[field] !== 'string')
        throw new Error(`状態ファイルが壊れています: ${key}`)
    }
  }
  if (value.projectSync === undefined) value.projectSync = {}
  const projectSync = asObject(value.projectSync)
  if (
    !projectSync ||
    Object.values(projectSync).some((entry) => {
      const pair = asObject(entry)
      return !pair || typeof pair.status !== 'string' || typeof pair.label !== 'string'
    })
  )
    throw new Error('状態ファイルが壊れています')
  return value as AutoState
}
export const writeState = (name: string, state: AutoState): void => {
  mkdirSync(autoDir(name), { recursive: true })
  if (!writeAtomic(join(autoDir(name), AUTO_FILES.state), JSON.stringify(state)))
    throw new Error('状態ファイルを書けません')
}
const owners = new Map<string, string>()
const stale = (lock: Json): boolean => {
  const data = asObject(lock)
  if (
    !data ||
    typeof data.host !== 'string' ||
    typeof data.pid !== 'number' ||
    !Number.isInteger(data.pid) ||
    data.pid < 1 ||
    typeof data.token !== 'string' ||
    typeof data.expiresAt !== 'string'
  )
    return false
  if (data.host !== hostname()) return Date.parse(data.expiresAt) < Date.now()
  try {
    process.kill(data.pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}
export const takeLock = (name: string, ttlMs: number): boolean => {
  const dir = autoDir(name)
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, AUTO_FILES.lock)
  const mutex = `${lock}.reclaim`
  const warn = () =>
    console.log(
      `lock.json.reclaim が残っています。tick と judge が動いていないことを確かめてから消してください: ${mutex}`,
    )
  if (existsSync(mutex)) {
    warn()
    return false
  }
  const token = randomUUID()
  const temporary = `${lock}.${token}.tmp`
  writeFileSync(
    temporary,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }),
    { flag: 'wx' },
  )
  const acquire = (): boolean => {
    try {
      linkSync(temporary, lock)
      owners.set(name, token)
      return true
    } catch {
      return false
    }
  }
  try {
    if (acquire()) return true
    const old = readJson(lock)
    if (!stale(old)) return false
    const pause = Number(process.env.ORCA_AUTO_LOCK_TEST_PAUSE_MS || 0)
    if (pause > 0) sleepSeconds(pause / 1000)
    try {
      mkdirSync(mutex)
    } catch {
      if (existsSync(mutex)) warn()
      return false
    }
    try {
      const current = readJson(lock)
      if (asObject(current)?.token !== asObject(old)?.token || !stale(current)) return false
      const retired = `${lock}.stale-${randomUUID()}`
      renameSync(lock, retired)
      const taken = acquire()
      rmSync(retired, { force: true })
      return taken
    } finally {
      rmdirSync(mutex)
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}
export const releaseLock = (name: string): void => {
  const file = join(autoDir(name), AUTO_FILES.lock)
  if (owners.has(name) && asObject(readJson(file))?.token === owners.get(name)) rmSync(file, { force: true })
  owners.delete(name)
}
export const takeLockWait = (name: string, ttlMs: number, waitMs: number): boolean => {
  const end = Date.now() + waitMs
  for (;;) {
    if (takeLock(name, ttlMs)) return true
    if (Date.now() >= end) return false
    sleepSeconds(Math.min(1000, end - Date.now()) / 1000)
  }
}
