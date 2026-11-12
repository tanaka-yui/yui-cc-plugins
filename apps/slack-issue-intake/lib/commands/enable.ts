import { enableArgs } from '../automation.ts'
import { parseFlags, parseNow } from '../cli.ts'
import { loadConfig, saveConfig } from '../config.ts'
import { openDb } from '../db.ts'
import { ADMIN_LEASE_MS, PERMISSION_ASSUMPTIONS } from '../defaults.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { runOrca } from '../orca.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { inheritedGrants, permissionFingerprint, safetyProblems } from '../permissions.ts'
import { maskSecrets } from '../secrets.ts'
export const run = (argv: string[]): void => {
  const { values } = parseFlags('enable', {
    args: argv,
    options: { 'accept-inherited': { type: 'boolean' }, now: { type: 'string' } },
  })
  const home = intakeHome()
  const config = loadConfig(home)
  if (!config?.orca.automationId) {
    console.error('init で automation を登録してください')
    process.exitCode = 2
    return
  }
  const now = new Date(parseNow('enable', values.now))
  const db = openDb(homePaths(home).db)
  const lease = acquireLease(db, 'admin', null, now, ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error('処理中です。少し待ってから再実行してください')
    db.close()
    process.exitCode = 1
    return
  }
  try {
    const problems = safetyProblems(home)
    if (problems.length) {
      for (const p of problems) console.error(`problem ${p}`)
      process.exitCode = 1
      return
    }
    const inherited = inheritedGrants()
    const fingerprint = permissionFingerprint(home)
    if (!inherited || !fingerprint) {
      console.error('権限の設定を読めません')
      process.exitCode = 1
      return
    }
    for (const r of inherited.allow) console.log(maskSecrets(`inherited-allow ${r}`))
    for (const d of inherited.dirs) console.log(maskSecrets(`inherited-dir ${d}`))
    console.log(PERMISSION_ASSUMPTIONS)
    if ((inherited.allow.length || inherited.dirs.length) && !values['accept-inherited']) {
      console.error('確認したうえで --accept-inherited を付けて再実行してください')
      process.exitCode = 1
      return
    }
    if (!renewLease(db, lease.token, now, ADMIN_LEASE_MS)) {
      console.error('lease lost')
      process.exitCode = 1
      return
    }
    config.acceptedPermissions = fingerprint
    saveConfig(home, config)
    const enabled = runOrca(enableArgs(config.orca.automationId))
    if (!enabled.ok) {
      console.error(maskSecrets(enabled.stderr))
      process.exitCode = 1
      return
    }
    console.log(
      `enabled automation=${config.orca.automationId} inherited_allow=${inherited.allow.length} inherited_dirs=${inherited.dirs.length}`,
    )
  } finally {
    releaseLease(db, lease.token)
    db.close()
  }
}
