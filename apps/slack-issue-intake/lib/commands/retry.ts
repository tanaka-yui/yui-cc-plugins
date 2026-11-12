import { parseFlags, parseNow } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { getSubmission, openDb, transition } from '../db.ts'
import { ADMIN_LEASE_MS } from '../defaults.ts'
import { acquireLease, releaseLease } from '../lease.ts'
import { homePaths, intakeHome } from '../paths.ts'
export const run = (argv: string[]): void => {
  const { values } = parseFlags('retry', { args: argv, options: { id: { type: 'string' }, now: { type: 'string' } } })
  const id = Number(values.id)
  if (!Number.isSafeInteger(id) || id <= 0) {
    process.exitCode = 2
    return
  }
  const home = intakeHome()
  if (!loadConfig(home)) {
    console.error('init を先に実行してください')
    process.exitCode = 2
    return
  }
  const now = new Date(parseNow('retry', values.now))
  const db = openDb(homePaths(home).db)
  const lease = acquireLease(db, 'admin', null, now, ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error('処理中です。少し待ってから再実行してください')
    db.close()
    process.exitCode = 1
    return
  }
  try {
    const s = getSubmission(db, id)
    if (s?.state !== 'failed' || !s.failedFrom || s.failedFrom === 'failed') {
      console.error('再試行できる失敗した投稿がありません')
      process.exitCode = 1
      return
    }
    if (
      !transition(
        db,
        lease.token,
        id,
        'failed',
        { state: s.failedFrom, failedFrom: null, attempts: 0, lastError: null },
        now.toISOString(),
      )
    ) {
      console.error('lease lost')
      process.exitCode = 1
      return
    }
    console.log(`retried id=${id} state=${s.failedFrom}`)
  } finally {
    releaseLease(db, lease.token)
    db.close()
  }
}
