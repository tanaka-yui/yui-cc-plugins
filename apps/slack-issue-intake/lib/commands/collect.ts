import { parseFlags, parseNow } from '../cli.ts'
import { AGENT_STATES, listByStates } from '../db.ts'
import { COMMAND_DEADLINE_MS, RUN_LEASE_MS } from '../defaults.ts'
import { writeJson } from '../fs.ts'
import { acquireLease, markCollected, releaseLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { prepareRun, removeRun } from '../runs.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { sync } from '../sync.ts'
import { buildWork } from '../work.ts'

import { randomUUID } from 'node:crypto'
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('collect', { args: argv, options: { now: { type: 'string' } } })
  const at = parseNow('collect', values.now)
  const now = () => (values.now ? new Date(at) : new Date())
  const opened = openRuntime(intakeHome())
  if (!opened.ok) {
    console.error(opened.reason)
    process.exitCode = 2
    return
  }
  const rt = opened.runtime
  const runId = randomUUID()
  const lease = acquireLease(rt.db, 'run', runId, now(), RUN_LEASE_MS)
  if (!lease.ok) {
    console.log('busy')
    rt.db.close()
    process.exitCode = 4
    return
  }
  let collected = false
  let prepared = false
  try {
    const run = prepareRun(rt.db, lease.token, rt.paths.runsDir, runId, now().toISOString())
    if (!run) {
      console.error('lease lost')
      process.exitCode = 2
      return
    }
    prepared = true
    const ctx = { rt, token: lease.token, ttlMs: RUN_LEASE_MS, now, deadline: Date.now() + COMMAND_DEADLINE_MS }
    const report = await sync(ctx)
    if (report.fatal || report.leaseLost) {
      console.error(report.fatal ?? 'lease lost')
      process.exitCode = report.fatal ? 3 : 2
      return
    }
    const result = await buildWork(ctx, listByStates(rt.db, AGENT_STATES), runId, run.paths)
    for (const skipped of result.skipped) console.log(`skipped id=${skipped.id} reason=${maskSecrets(skipped.reason)}`)
    for (const id of result.failed) console.log(`failed id=${id} reason=thread_not_found`)
    if (result.stop === 'lease lost') {
      console.error(result.stop)
      process.exitCode = 2
      return
    }
    if (result.work.items.length === 0) {
      console.log('items=0')
      return
    }
    writeJson(run.paths.workFile, result.work)
    if (!markCollected(rt.db, lease.token, now())) {
      console.error('lease lost')
      process.exitCode = 2
      return
    }
    collected = true
    console.log(`items=${result.work.items.length}\nrun=${runId}\nwork=${run.paths.workFile}`)
  } finally {
    if (!collected) {
      releaseLease(rt.db, lease.token)
      if (prepared) removeRun(rt.db, rt.paths.runsDir, runId)
    }
    rt.db.close()
  }
}
