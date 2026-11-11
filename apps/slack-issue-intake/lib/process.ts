import { spawnSync } from 'node:child_process'

import type { ProcessIdentity } from './types.ts'
export const identityOf = (pid: number): ProcessIdentity | null => {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return r.status === 0 && r.stdout.trim() ? { pid, start: r.stdout.trim() } : null
}
export const selfIdentity = (): ProcessIdentity => {
  const id = identityOf(process.pid)
  if (!id) throw new Error('実行プロセスの身元を確認できません')
  return id
}
export const isAlive = (id: ProcessIdentity): boolean => {
  try {
    process.kill(id.pid, 0)
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ESRCH') return false
  }
  return identityOf(id.pid)?.start === id.start
}
