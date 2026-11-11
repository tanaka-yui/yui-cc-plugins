import { assert, mountWorker, test } from 'orca/testing'

import * as main from './worker.ts'

test('activates and logs', async () => {
  const worker = await mountWorker(main)
  assert.ok(worker.logs.includes('account-failover activated'))
  await worker.deactivate()
})
