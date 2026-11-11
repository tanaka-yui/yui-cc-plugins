import {
  MSG_IDENTITY_UNAVAILABLE,
  PROCESS_LOCALE,
  PROCESS_PROBE_TIMEOUT_MS,
  PROCESS_TIMEZONE,
  PS_PATH,
} from './defaults.ts'

import { spawnSync } from 'node:child_process'

import type { ProcessIdentity } from './types.ts'

type Probe = { kind: 'found'; identity: ProcessIdentity } | { kind: 'missing' } | { kind: 'unavailable' }
const probe = (pid: number, psPath: string): Probe => {
  const r = spawnSync(psPath, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    // 実行元のTZやロケールの違いで、同じPIDの起動時刻が変わらないようにする。
    env: { ...process.env, TZ: PROCESS_TIMEZONE, LC_ALL: PROCESS_LOCALE },
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = r.stdout?.trim() ?? ''
  if (r.error || r.signal) return { kind: 'unavailable' }
  if (r.status === 1 && !start && !r.stderr?.trim()) return { kind: 'missing' }
  return r.status === 0 && start ? { kind: 'found', identity: { pid, start } } : { kind: 'unavailable' }
}
export const identityOf = (pid: number): ProcessIdentity | null => {
  const result = probe(pid, PS_PATH)
  return result.kind === 'found' ? result.identity : null
}
export const selfIdentity = (): ProcessIdentity => {
  const id = identityOf(process.pid)
  if (!id) throw new Error(MSG_IDENTITY_UNAVAILABLE)
  return id
}
export const isAlive = (id: ProcessIdentity, psPath = PS_PATH): boolean => {
  try {
    process.kill(id.pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
  }
  const result = probe(id.pid, psPath)
  if (result.kind === 'missing') return false
  return result.kind === 'unavailable' || result.identity.start === id.start
}
