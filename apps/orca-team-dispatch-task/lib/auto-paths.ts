import { configHome } from './config.ts'

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
