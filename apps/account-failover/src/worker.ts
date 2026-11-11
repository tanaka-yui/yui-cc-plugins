// Orca が読み込み時に変換する worker のエントリ。ビルド工程はない。

import { createFailover } from './failover.ts'
import { createSystemDeps } from './system-deps.ts'

import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  const failover = createFailover(createSystemDeps(orca))
  orca.events.on('agent.status.changed', (event) => failover.onStatus(event))
  orca.log('account-failover activated')
}
