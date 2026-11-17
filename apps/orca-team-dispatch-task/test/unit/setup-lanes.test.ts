import {
  SETUP_WORKTREE_DISK_MB as DISK,
  SETUP_WORKTREE_MEMORY_MB as MEMORY,
  SETUP_RESERVE_MEMORY_MB as RESERVE,
  recommendLanes,
  worktreesPerIssue,
} from '../../lib/setup-lanes.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('SU3 recommendLanes obeys memory, disk, CPU and the minimum', () => {
  const spec = {
    cpus: 64,
    memoryTotalMb: RESERVE + 3 * MEMORY,
    memoryFreeMb: 0,
    swapTotalMb: 0,
    diskFreeMb: 100 * DISK,
    measuredAt: '2026-11-17T00:00:00Z',
  }
  assert.equal(recommendLanes(spec), 3)
  assert.equal(recommendLanes({ ...spec, memoryTotalMb: RESERVE + 100 * MEMORY, diskFreeMb: 2 * DISK }), 2)
  assert.equal(recommendLanes({ ...spec, cpus: 1 }), 1)
  assert.equal(recommendLanes({ ...spec, memoryTotalMb: 1 }), 1)
})
test('SU4 worktreesPerIssue counts all role combinations', () => {
  for (const [review_mode, phase_b, count] of [
    ['off', 'off', 1],
    ['on', 'off', 2],
    ['off', 'on', 2],
    ['on', 'on', 4],
  ] as const) {
    assert.equal(worktreesPerIssue({ review_mode, phase_b }, 1), count)
    assert.equal(worktreesPerIssue({ review_mode, phase_b }, 2), count * 2)
  }
})
