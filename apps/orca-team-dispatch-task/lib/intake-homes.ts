import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// slack-issue-intake の lib/defaults.ts の写し。scripts/check-shared-contracts.mjs が一致を確かめる
export const INTAKE_HOME_DIRNAME = '.slack-issue-intake'
export const INTAKE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const INTAKE_NAME_RESERVED_SUFFIX = '-slack-app'
export const INTAKE_EXISTING_ACTIVE = 'active'
export const INTAKE_EXISTING_THREAD = 'thread'

export const listIntakeConfigs = (home: string): string[] => {
  let names: string[]
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  const prefix = `${INTAKE_HOME_DIRNAME}-`
  return names
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        INTAKE_NAME_PATTERN.test(name.slice(prefix.length)) &&
        !name.endsWith(INTAKE_NAME_RESERVED_SUFFIX),
    )
    .sort()
    .map((name) => join(home, name, 'config.json'))
    .filter((path) => existsSync(path))
}
