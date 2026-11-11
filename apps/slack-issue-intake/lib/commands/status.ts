import { parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { ALL_STATES, countByState, getScan, listByStates, openDb } from '../db.ts'
import { readJson } from '../fs.ts'
import { asArray, asObject } from '../json.ts'
import { readLease } from '../lease.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { permissionStatus, safetyProblems } from '../permissions.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
export const run = (argv: string[]): void => {
  parseFlags('status', { args: argv, options: {} })
  const home = intakeHome()
  const paths = homePaths(home)
  const config = loadConfig(home)
  console.log(`config=${paths.config}`)
  if (config)
    console.log(
      `channel=${config.channel} repo=${config.repo} every=${config.everyMinutes}m github=${config.github.login}`,
    )
  console.log(
    `token=${loadToken(paths.secrets) ? 'registered' : 'missing'}\nautomation=${config?.orca.automationId ?? 'none'}`,
  )
  const status = permissionStatus(home, config?.acceptedPermissions ?? null)
  console.log(`permissions=${status}`)
  if (status === 'unsafe') for (const p of safetyProblems(home)) console.log(`problem ${p}`)
  if (!config) return
  const db = openDb(paths.db)
  try {
    const lease = readLease(db)
    console.log(lease ? `lease=${lease.owner}/${lease.phase} until=${lease.expiresAt}` : 'lease=none')
    const scan = getScan(db)
    console.log(scan ? `scan=${scan.sliceOldest}..${scan.sliceLatest} resume=${scan.resumeLatest ?? '-'}` : 'scan=none')
    const poll = asObject(readJson(paths.pollStatus))
    console.log(
      `last_poll=${poll?.at ?? 'none'} result=${poll?.result ?? 'none'} agent_work=${poll?.agentWork ?? 0} partial=${poll?.partial ?? false} errors=${asArray(poll?.errors)?.length ?? 0}`,
    )
    const counts = countByState(db)
    console.log(`counts ${ALL_STATES.map((s) => `${s}=${counts[s]}`).join(' ')}`)
    const line = (text: string): string => maskSecrets(text.replace(/[\r\n]/g, ' '))
    for (const s of listByStates(db, ['waiting', 'creating', 'failed'])) {
      const title = line(s.fields?.title ?? '-')
      const error = line(s.lastError ?? '-')
      if (s.state === 'waiting')
        console.log(`waiting id=${s.id} asked_at=${s.askedAt} rounds=${s.rounds} link=${s.permalink} title=${title}`)
      else if (s.state === 'creating')
        console.log(
          `creating id=${s.id} inflight=${s.inflight?.owner.pid ?? '-'} error=${error} link=${s.permalink} title=${title}`,
        )
      else console.log(`failed id=${s.id} from=${s.failedFrom} error=${error} link=${s.permalink} title=${title}`)
    }
  } finally {
    db.close()
  }
}
