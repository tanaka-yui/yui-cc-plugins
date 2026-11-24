import { RUN_LEASE_MS, RUN_TAB_QUIET_MS } from '../../lib/defaults.ts'
import { finishedPtyIds, tabsToClose } from '../../lib/run-tabs.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const NOW = Date.parse('2026-11-24T02:00:00Z')

test('RT1 終わった回の端末だけを数える（動作中・端末の無い回・新しい dispatch_failed は数えない）', () => {
  const ids = finishedPtyIds(
    [
      { status: 'completed', terminalPtyId: 'pty-done', startedAt: NOW - 1000 },
      { status: 'dispatching', terminalPtyId: null, startedAt: NOW },
      { status: 'running', terminalPtyId: 'pty-running', startedAt: NOW - 1000 },
      { status: 'skipped_precheck', terminalPtyId: null, startedAt: NOW },
      { status: 'completed', terminalPtyId: null, startedAt: NOW },
      { status: 'dispatch_failed', terminalPtyId: 'pty-lost-new', startedAt: NOW - RUN_LEASE_MS + 1000 },
      { status: 'dispatch_failed', terminalPtyId: 'pty-lost-old', startedAt: NOW - RUN_LEASE_MS - 1000 },
    ],
    NOW,
  )
  assert.deepEqual([...ids].sort(), ['pty-done', 'pty-lost-old'])
})

test('RT2 履歴にある端末のうち、静かになったものだけを閉じる', () => {
  const handles = tabsToClose(
    [
      { handle: 'term_done', ptyId: 'pty-done', lastOutputAt: NOW - RUN_TAB_QUIET_MS },
      { handle: 'term_busy', ptyId: 'pty-busy', lastOutputAt: NOW - RUN_TAB_QUIET_MS + 1000 },
      { handle: 'term_human', ptyId: 'pty-human', lastOutputAt: NOW - RUN_TAB_QUIET_MS * 10 },
      { handle: 'term_silent', ptyId: 'pty-silent' },
      { ptyId: 'pty-done' },
    ],
    new Set(['pty-done', 'pty-busy', 'pty-silent']),
    NOW,
  )
  assert.deepEqual(handles, ['term_done', 'term_silent'])
})
