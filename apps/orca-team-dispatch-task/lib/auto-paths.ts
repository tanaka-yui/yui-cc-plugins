import { configHome } from './config.ts'

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
