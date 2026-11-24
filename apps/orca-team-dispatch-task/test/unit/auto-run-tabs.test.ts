import { AUTO_JUDGE_LEASE_MS } from '../../lib/auto-paths.ts'
import { finishedPtyIds, RUN_TAB_QUIET_MS, tabsToClose } from '../../lib/auto-run-tabs.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const NOW = Date.parse('2026-11-24T02:00:00Z')
const RUNS = [
  { status: 'completed', terminalPtyId: 'pty-done', startedAt: 1 },
  { status: 'dispatching', terminalPtyId: null, startedAt: 1 },
  { status: 'completed', terminalPtyId: 'pty-gone', startedAt: 1 },
]
const TERMINALS = [
  { handle: 'term_done', ptyId: 'pty-done', lastOutputAt: 1 },
  { handle: 'term_worker', ptyId: 'pty-worker', lastOutputAt: 1 },
]
const last = (stdout: string) => stdout.trim().split('\n').at(-1)
const closes = (log: string) => log.split('\n').filter((line) => line.startsWith('terminal close'))

test('RT1 終わった回の端末だけを数える（動作中・端末の無い回・新しい dispatch_failed は数えない）', () => {
  const ids = finishedPtyIds(
    [
      { status: 'completed', terminalPtyId: 'pty-done', startedAt: NOW - 1000 },
      { status: 'dispatching', terminalPtyId: null, startedAt: NOW },
      { status: 'running', terminalPtyId: 'pty-running', startedAt: NOW - 1000 },
      { status: 'completed', terminalPtyId: null, startedAt: NOW },
      { status: 'dispatch_failed', terminalPtyId: 'pty-lost-new', startedAt: NOW - AUTO_JUDGE_LEASE_MS + 1000 },
      { status: 'dispatch_failed', terminalPtyId: 'pty-lost-old', startedAt: NOW - AUTO_JUDGE_LEASE_MS - 1000 },
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
      { handle: 'term_worker', ptyId: 'pty-worker', lastOutputAt: 1 },
      { handle: 'term_silent', ptyId: 'pty-silent' },
    ],
    new Set(['pty-done', 'pty-busy', 'pty-silent']),
    NOW,
  )
  assert.deepEqual(handles, ['term_done', 'term_silent'])
})
test('RT3 tick は終わった回の判定役のタブだけを閉じる', () => {
  const f = fixture()
  try {
    const base = last(f.cli('tick').stdout)
    f.put(f.configFile, { ...f.raw, automation: { id: 'auto-1', acceptedFingerprint: null } })
    f.respond('automations_runs', { ok: true, result: { runs: RUNS } }, f.orca)
    f.respond('terminal_list', { ok: true, result: { terminals: TERMINALS } }, f.orca)
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stdout, /終わった回の判定役のタブを閉じました: 1\nauto: judge=0 /)
    assert.equal(last(r.stdout), base)
    assert.match(f.calls(f.orca), /^automations runs --id auto-1 --limit 100 --json/m)
    assert.deepEqual(closes(f.calls(f.orca)), ['terminal close --terminal term_done --json '])
  } finally {
    f.cleanup()
  }
})
test('RT4 automation の無い設定では呼ばず、終わった回が無ければ端末を読まない', () => {
  const f = fixture()
  try {
    f.cli('tick')
    assert.doesNotMatch(f.calls(f.orca), /^automations runs/m)
    f.put(f.configFile, { ...f.raw, automation: { id: 'auto-1', acceptedFingerprint: null } })
    f.respond('automations_runs', { ok: true, result: { runs: [RUNS[1] ?? null] } }, f.orca)
    f.cli('tick')
    assert.match(f.calls(f.orca), /^automations runs/m)
    assert.doesNotMatch(f.calls(f.orca), /^terminal list/m)
  } finally {
    f.cleanup()
  }
})
test('RT5 履歴を読めない・閉じられないときは 1 行出すだけで、tick の結果は変えない', () => {
  const f = fixture()
  try {
    const base = last(f.cli('tick').stdout)
    f.put(f.configFile, { ...f.raw, automation: { id: 'auto-1', acceptedFingerprint: null } })
    f.respond('automations_runs', { ok: false, error: { message: 'Automation not found.' } }, f.orca)
    const lost = f.cli('tick')
    assert.equal(lost.status, 1, lost.stderr)
    assert.match(lost.stdout, /automation の実行履歴を読めません/)
    assert.equal(last(lost.stdout), base)
    f.respond('automations_runs', { ok: true, result: { runs: RUNS } }, f.orca)
    f.respond('terminal_list', { ok: true, result: { terminals: TERMINALS } }, f.orca)
    f.respond('terminal_close', { ok: false, error: { message: 'no' } }, f.orca)
    const stuck = f.cli('tick')
    assert.equal(stuck.status, 1, stuck.stderr)
    assert.match(stuck.stdout, /終わった回のタブを閉じられません: term_done/)
    assert.equal(last(stuck.stdout), base)
  } finally {
    f.cleanup()
  }
})
