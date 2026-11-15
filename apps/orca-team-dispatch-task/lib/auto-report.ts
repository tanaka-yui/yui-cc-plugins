import { LOCAL_HOST } from './auto-hosts.ts'
import { orderQueue } from './auto-queue.ts'

import { hostname } from 'node:os'

import type { AutoConfig } from './auto-config.ts'
import type { HostConfig } from './auto-hosts.ts'
import type { AutoState } from './auto-state.ts'

export type AutoReport = {
  version: 1
  name: string
  updatedAt: string
  everyMinutes: number
  running: Array<{ issue: string; title: string; host: string; startedAt: string | null; limitMinutes: number }>
  queue: Array<{ issue: string; title: string; priority: string }>
  hosts: Array<{ name: string; used: number; max: number; reachable: boolean }>
}

export const buildReport = (
  config: AutoConfig,
  state: AutoState,
  hosts: Array<{ host: HostConfig; used: number; reachable: boolean }>,
  now: string,
): AutoReport => ({
  version: 1,
  name: config.name,
  updatedAt: now,
  everyMinutes: config.everyMinutes,
  running: Object.values(state.issues)
    .filter((i) => ['running', 'finishing'].includes(i.phase))
    .map((i) => ({
      issue: i.key,
      title: i.title,
      host: hosts.find((h) => h.host.id === (i.host ?? LOCAL_HOST))?.host.name ?? hostname(),
      startedAt: i.startedAt,
      limitMinutes: i.limitMinutes,
    })),
  queue: orderQueue(Object.values(state.issues).filter((i) => i.phase === 'queued')).map((i) => ({
    issue: i.key,
    title: i.title,
    priority: i.priority,
  })),
  hosts: hosts.map(({ host, used, reachable }) => ({ name: host.name, used, max: host.lanes, reachable })),
})
