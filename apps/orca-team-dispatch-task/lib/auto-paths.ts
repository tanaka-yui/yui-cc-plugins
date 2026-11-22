import { configHome } from './config.ts'
import { type OrcaResult, runOrca } from './orca.ts'
import { envCount, type ProcResult, run } from './sys.ts'

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const autoDir = (name: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('invalid auto name')
  return join(configHome(), 'auto', name)
}
export const AUTO_FILES = {
  config: 'config.json',
  state: 'state.json',
  lock: 'lock.json',
  report: 'report.json',
  pending: 'judge/pending.json',
  decisions: 'judge/decisions.json',
  archive: 'archive',
} as const
export const autoNow = (): string => process.env.ORCA_AUTO_NOW || new Date().toISOString()

export const archiveStatusDir = (statusDir: string, archiveDir: string, name: string): boolean => {
  if (!existsSync(statusDir)) return true
  try {
    mkdirSync(archiveDir, { recursive: true })
    const target = join(archiveDir, existsSync(join(archiveDir, name)) ? `${name}-${Date.now()}` : name)
    try {
      renameSync(statusDir, target)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') return false
      cpSync(statusDir, target, { recursive: true })
      rmSync(statusDir, { recursive: true })
    }
    return true
  } catch {
    return false
  }
}

export const AUTO_WORKTREE_LIST_LIMIT = 1000

export const AUTO_TICK_BUDGET_MS = 100_000
export const AUTO_CALL_CAP_MS = 30_000
export const AUTO_JUDGE_LEASE_MS = 20 * 60_000
let deadline: number | null = null
let readFailures = 0
const skipped = new Set<string>()
export const beginAutoTick = (budget: number): number => {
  readFailures = 0
  skipped.clear()
  deadline = Date.now() + budget
  return deadline
}
export const endAutoTick = (): void => {
  deadline = null
}
const remainder = (): number => (deadline === null ? Infinity : deadline - Date.now())
const skip = (stage: string): false => {
  if (!skipped.has(stage)) {
    skipped.add(stage)
    console.log(`予算を使い切りました: ${stage}`)
  }
  return false
}
// 予算切れとして数えずに、残り時間だけを見る（始めたら途中で止められない処理の前に使う）
export const hasAutoTime = (reserve: number): boolean => remainder() >= reserve
export const canAutoCall = (stage: string, reserve = envCount('ORCA_AUTO_CALL_CAP_MS', AUTO_CALL_CAP_MS)): boolean =>
  remainder() >= reserve || skip(stage)
export const autoCallErrors = (): number => readFailures + skipped.size
const timeout = (): number | undefined =>
  deadline === null
    ? undefined
    : Math.max(1, Math.min(remainder(), envCount('ORCA_AUTO_CALL_CAP_MS', AUTO_CALL_CAP_MS)))
const readAllowed = (stage: string): boolean => remainder() > 0 || skip(stage)
export const autoReadUncounted = (command: string, args: string[]): ProcResult =>
  run(command, args, undefined, timeout())

export const autoRun = (command: string, args: string[], cwd?: string): ProcResult => {
  const action = command === 'git' ? (args[0] === '-C' ? args[2] : args[0]) : args[0]
  const gitRead =
    command === 'git' && !['push', 'checkout'].includes(action ?? '') && !(action === 'branch' && args.includes('-D'))
  const ghRead =
    command === 'gh' &&
    ((args[0] === 'api' && args.includes('GET')) ||
      (['issue', 'repo', 'pr'].includes(args[0] ?? '') && ['list', 'view', 'checks'].includes(args[1] ?? '')))
  const reading = command === 'ps' || gitRead || ghRead
  const stage = `${command} ${action ?? ''} ${args[1] ?? ''}`
  if (!(reading ? readAllowed(stage) : canAutoCall(stage))) return { rc: 1, stdout: '', stderr: 'timed out' }
  const result = run(command, args, cwd, reading ? timeout() : undefined)
  if (reading && result.stderr.includes('timed out')) readFailures++
  return result
}
export const autoOrca = (args: string[], env?: Record<string, string>): OrcaResult => {
  const reading =
    args[0] === 'status' ||
    [
      'terminal show',
      'orchestration run-current',
      'orchestration worker-list',
      'orchestration worker-show',
      'worktree list',
      'diagnostics memory',
    ].includes(args.slice(0, 2).join(' '))
  const stage = `Orca ${args.slice(0, 2).join(' ')}`
  if (!(reading ? readAllowed(stage) : canAutoCall(stage)))
    return { rc: 1, json: null, stdout: '', stderr: 'timed out' }
  const result = runOrca(args, env, reading ? timeout() : undefined)
  if (reading && result.stderr?.includes('timed out')) readFailures++
  return result
}
