import { assert, mountWorker, test } from 'orca/testing'

import * as main from './worker.ts'

test('activates and logs', async () => {
  const worker = await mountWorker(main)
  assert.ok(worker.logs.includes('account-failover activated'))
  await worker.deactivate()
})

test('forwards agent status events to failover', async () => {
  const worker = await mountWorker(main)
  const event = {
    workspaceId: 'w',
    paneKey: 'p',
    terminalId: 'term_does_not_exist',
    state: 'done' as const,
    receivedAt: 1,
  }
  await worker.emit('agent.status.changed', event)
  await worker.emit('agent.status.changed', { ...event, state: 'working' as const })
  assert.ok(worker.logs.some((line) => line.includes('term_does_not_exist')))
  assert.equal(worker.host.callsOf('terminal.sendText').length, 0)
  assert.equal(worker.host.callsOf('notifications.show').length, 0)
  await worker.deactivate()
})
