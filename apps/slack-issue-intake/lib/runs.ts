import { forgetRun, olderRuns, registerRun } from './db.ts'
import { ensurePrivateDir } from './fs.ts'
import { runPaths } from './paths.ts'

import { rmSync } from 'node:fs'

import type { Db } from './db.ts'
import type { RunPaths } from './paths.ts'
export const cleanupOlderRuns = (db: Db, runsDir: string, seq: number): void => {
  for (const id of olderRuns(db, seq)) {
    rmSync(runPaths(runsDir, id).dir, { recursive: true, force: true })
    forgetRun(db, id)
  }
}
export const prepareRun = (
  db: Db,
  token: string,
  runsDir: string,
  runId: string,
  now: string,
): { seq: number; paths: RunPaths } | null => {
  const seq = registerRun(db, token, runId, now)
  if (seq === null) return null
  cleanupOlderRuns(db, runsDir, seq)
  const paths = runPaths(runsDir, runId)
  ensurePrivateDir(paths.filesDir)
  return { seq, paths }
}
export const removeRun = (db: Db, runsDir: string, runId: string): void => {
  rmSync(runPaths(runsDir, runId).dir, { recursive: true, force: true })
  forgetRun(db, runId)
}
