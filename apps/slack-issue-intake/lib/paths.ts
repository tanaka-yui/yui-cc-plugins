import {
  CLAUDE_HOME_ENV,
  DECISIONS_FILE,
  INTAKE_HOME_DIRNAME,
  INTAKE_NAME_PATTERN,
  INTAKE_NAME_RESERVED_SUFFIX,
  MSG_NAME_REQUIRED,
  MSG_NAME_RESERVED,
  MSG_NAME_RULE,
  RUNS_DIRNAME,
  SLACK_APP_DIR_SUFFIX,
  WORK_FILE,
} from './defaults.ts'

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
export const HOME_ENV = 'SLACK_ISSUE_INTAKE_HOME'
export const HOME_DIRNAME = INTAKE_HOME_DIRNAME
export const intakeNameProblem = (name: string): string | null => {
  if (!INTAKE_NAME_PATTERN.test(name)) return `${MSG_NAME_RULE}: ${JSON.stringify(name)}`
  if (`${INTAKE_HOME_DIRNAME}-${name}`.endsWith(INTAKE_NAME_RESERVED_SUFFIX))
    return `${MSG_NAME_RESERVED}: ${JSON.stringify(name)}`
  return null
}
export const homeForName = (name: string | null): string =>
  join(homedir(), name === null ? INTAKE_HOME_DIRNAME : `${INTAKE_HOME_DIRNAME}-${name}`)
export const nameOfHome = (home: string): string | null => {
  const base = basename(home)
  const prefix = `${INTAKE_HOME_DIRNAME}-`
  if (!base.startsWith(prefix)) return null
  const name = base.slice(prefix.length)
  return intakeNameProblem(name) === null ? name : null
}
export const CLAUDE_DIRNAME = '.claude'
export const intakeHome = (): string => {
  const home = process.env[HOME_ENV]
  if (!home) throw new Error(MSG_NAME_REQUIRED)
  return home
}
export const claudeHome = (): string => process.env[CLAUDE_HOME_ENV] || join(homedir(), CLAUDE_DIRNAME)
export const pluginRoot = (): string => dirname(import.meta.dirname)
export type HomePaths = {
  config: string
  secrets: string
  db: string
  pollStatus: string
  tmpDir: string
  binDir: string
  launcher: string
  launcherScript: string
  runDir: string
  runsDir: string
  projectSettings: string
  projectLocalSettings: string
}
export const homePaths = (home: string): HomePaths => {
  const runDir = join(home, 'run')
  const binDir = join(home, 'bin')
  return {
    config: join(home, 'config.json'),
    secrets: join(home, 'secrets.json'),
    db: join(home, 'intake.db'),
    pollStatus: join(home, 'poll-status.json'),
    tmpDir: join(home, 'tmp'),
    binDir,
    launcher: join(binDir, 'slack-issue-intake'),
    launcherScript: join(binDir, 'launch.mts'),
    runDir,
    runsDir: join(runDir, RUNS_DIRNAME),
    projectSettings: join(runDir, CLAUDE_DIRNAME, 'settings.json'),
    projectLocalSettings: join(runDir, CLAUDE_DIRNAME, 'settings.local.json'),
  }
}
export type RunPaths = { dir: string; workFile: string; decisionsFile: string; filesDir: string }
export const runPaths = (runsDir: string, runId: string): RunPaths => {
  const dir = join(runsDir, runId)
  return { dir, workFile: join(dir, WORK_FILE), decisionsFile: join(dir, DECISIONS_FILE), filesDir: join(dir, 'files') }
}

export const listIntakeNames = (base: string): string[] => {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => nameOfHome(entry.name))
      .filter((name): name is string => name !== null)
      .sort()
  } catch {
    return []
  }
}
export const homeOfSlackProject = (dir: string): string | null => {
  if (!basename(dir).endsWith(SLACK_APP_DIR_SUFFIX)) return null
  const home = dir.slice(0, -SLACK_APP_DIR_SUFFIX.length)
  return basename(home) === INTAKE_HOME_DIRNAME || nameOfHome(home) !== null ? home : null
}
