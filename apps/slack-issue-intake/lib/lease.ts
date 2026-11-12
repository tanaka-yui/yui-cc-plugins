import { inTransaction } from './db.ts'
import { APPLY_LEASE_MS, RUN_LEASE_MS } from './defaults.ts'

import { randomUUID } from 'node:crypto'

import type { Db } from './db.ts'
export type LeaseOwner = 'poll' | 'run' | 'admin'
export type LeasePhase = 'active' | 'collected' | 'applying'
export type Lease = {
  owner: LeaseOwner
  token: string
  runId: string | null
  phase: LeasePhase
  pid: number
  expiresAt: string
}
export const readLease = (db: Db): Lease | null => {
  const r = db.prepare('SELECT * FROM lease WHERE id=1').get()
  return r
    ? {
        owner: String(r.owner) as LeaseOwner,
        token: String(r.token),
        runId: r.run_id === null ? null : String(r.run_id),
        phase: String(r.phase) as LeasePhase,
        pid: Number(r.pid),
        expiresAt: String(r.expires_at),
      }
    : null
}
export const acquireLease = (
  db: Db,
  owner: LeaseOwner,
  runId: string | null,
  now: Date,
  ttlMs: number,
): { ok: true; token: string } | { ok: false; holder: Lease } =>
  inTransaction(db, () => {
    const holder = readLease(db)
    if (holder && holder.expiresAt > now.toISOString()) return { ok: false, holder }
    const token = randomUUID()
    db.prepare("INSERT OR REPLACE INTO lease VALUES (1,?,?,?,'active',?,?)").run(
      owner,
      token,
      runId,
      process.pid,
      new Date(now.getTime() + ttlMs).toISOString(),
    )
    return { ok: true, token }
  })
export const renewLease = (db: Db, token: string, now: Date, ttlMs: number): boolean =>
  Boolean(
    db
      .prepare('UPDATE lease SET expires_at=? WHERE id=1 AND token=? AND expires_at>?')
      .run(new Date(now.getTime() + ttlMs).toISOString(), token, now.toISOString()).changes,
  )
export const markCollected = (db: Db, token: string, now: Date): boolean =>
  Boolean(
    db
      .prepare(
        "UPDATE lease SET phase='collected',expires_at=? WHERE id=1 AND owner='run' AND phase='active' AND token=? AND expires_at>?",
      )
      .run(new Date(now.getTime() + RUN_LEASE_MS).toISOString(), token, now.toISOString()).changes,
  )
export const claimApply = (
  db: Db,
  runId: string,
  now: Date,
): { ok: true; token: string } | { ok: false; reason: string } =>
  inTransaction(db, () => {
    const token = randomUUID()
    const r = db
      .prepare(
        "UPDATE lease SET token=?,phase='applying',pid=?,expires_at=? WHERE id=1 AND owner='run' AND run_id=? AND phase='collected' AND expires_at>?",
      )
      .run(token, process.pid, new Date(now.getTime() + APPLY_LEASE_MS).toISOString(), runId, now.toISOString())
    return r.changes ? { ok: true, token } : { ok: false, reason: 'リースを引き継げません' }
  })
export const releaseLease = (db: Db, token: string): boolean =>
  Boolean(db.prepare('DELETE FROM lease WHERE id=1 AND token=?').run(token).changes)
