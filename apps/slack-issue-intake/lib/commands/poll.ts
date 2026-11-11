import { parseFlags, parseNow } from '../cli.ts'
import { POLL_DEADLINE_MS, POLL_LEASE_MS } from '../defaults.ts'
import { writeJson } from '../fs.ts'
import { acquireLease, releaseLease } from '../lease.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { permissionFingerprint, safetyProblems } from '../permissions.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { agentWorkCount, sync } from '../sync.ts'
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('poll', {
    args: argv,
    options: { now: { type: 'string' }, 'deadline-ms': { type: 'string' } },
  })
  const at = parseNow('poll', values.now)
  const budget = Number(values['deadline-ms'] ?? POLL_DEADLINE_MS)
  if (!Number.isFinite(budget) || budget <= 0) {
    process.exitCode = 2
    return
  }
  const deadline = Date.now() + budget
  const home = intakeHome()
  const opened = openRuntime(home)
  const finish = (
    result: string,
    code: number,
    agentWork = 0,
    partial = false,
    errors: string[] = [],
    counts = { inserted: 0, rejected: 0, answered: 0, timedOut: 0, driven: 0 },
    reason = '',
  ): void => {
    console.log(
      `result=${result}${reason ? ` reason=${reason}` : ''} agent_work=${agentWork} inserted=${counts.inserted} rejected=${counts.rejected} answered=${counts.answered} timed_out=${counts.timedOut} driven=${counts.driven} errors=${errors.length} partial=${partial}`,
    )
    for (const e of errors) console.error(maskSecrets(e))
    writeJson(homePaths(home).pollStatus, {
      at,
      result,
      exitCode: code,
      agentWork,
      partial,
      errors: errors.map(maskSecrets),
      ...(reason ? { reason } : {}),
    })
    process.exitCode = code
  }
  if (!opened.ok) {
    finish('unconfigured', 2, 0, false, [opened.reason])
    return
  }
  const rt = opened.runtime
  try {
    const problems = safetyProblems(home)
    if (problems.length) {
      finish('permissions', 1, 0, false, problems, undefined, 'unsafe')
      return
    }
    if (!rt.config.acceptedPermissions || permissionFingerprint(home) !== rt.config.acceptedPermissions) {
      finish('permissions', 1, 0, false, [], undefined, 'changed')
      return
    }
    const now = () => (values.now ? new Date(at) : new Date())
    const lease = acquireLease(rt.db, 'poll', null, now(), POLL_LEASE_MS)
    if (!lease.ok) {
      finish('busy', 1)
      return
    }
    try {
      const report = await sync({ rt, token: lease.token, ttlMs: POLL_LEASE_MS, now, deadline })
      const work = agentWorkCount(rt.db)
      const code = report.fatal ? 3 : work ? 0 : 1
      finish(report.fatal ? 'error' : work ? 'work' : 'idle', code, work, report.partial, report.errors, {
        ...report,
        driven: report.driven.length,
      })
    } finally {
      releaseLease(rt.db, lease.token)
    }
  } finally {
    rt.db.close()
  }
}
