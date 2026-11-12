import { CLAUDE_HOME_ENV, DECISIONS_FILE, RUNS_DIRNAME, WORK_FILE } from './defaults.ts'

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
export const HOME_ENV = 'SLACK_ISSUE_INTAKE_HOME'
export const HOME_DIRNAME = '.slack-issue-intake'
export const CLAUDE_DIRNAME = '.claude'
export const intakeHome = (): string => process.env[HOME_ENV] || join(homedir(), HOME_DIRNAME)
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
