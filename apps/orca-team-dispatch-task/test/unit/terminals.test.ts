import { issueOfSlug, switchCommand, terminalRows, terminalTable } from '../../lib/terminals.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('switchCommand は遠くの役にだけ --environment を付け、値を引用する', () => {
  process.env.ORCA_BIN = 'orca'
  assert.equal(switchCommand('term_a', ''), "'orca' terminal switch --terminal 'term_a'")
  assert.equal(
    switchCommand('term_a', "m2 'max"),
    "'orca' terminal switch --terminal 'term_a' --environment 'm2 '\\''max'",
  )
})

test('terminalRows は記録された役だけを役の順に並べ、止めた役と答えを待つ役を状態に出す', () => {
  const repo = mkdtempSync(join(tmpdir(), 'terminals-'))
  try {
    const sd = join(repo, '.dispatch', 'issue-7-x')
    mkdirSync(join(sd, 'roles', 'exec'), { recursive: true })
    mkdirSync(join(sd, 'roles', 'design'), { recursive: true })
    mkdirSync(join(repo, '.dispatch-issue'))
    writeFileSync(join(repo, '.dispatch-issue', 'state.json'), '{"issues":{"7":{"slug":"issue-7-x"}}}')
    writeFileSync(
      join(sd, 'workers.json'),
      '{"roles":{"exec":{"agent":"codex","terminal":"term_e"},"design":{"agent":"claude","terminal":"term_d"}}}',
    )
    writeFileSync(join(sd, 'roles', 'exec', 'stopped.json'), '{}')
    writeFileSync(join(sd, 'roles', 'design', 'awaiting-user.json'), '{}')
    assert.equal(issueOfSlug(sd), '#7')
    const rows = terminalRows(sd, '#7')
    assert.deepEqual(
      rows.map((row) => [row.role, row.state, row.terminal]),
      [
        ['design', '回答待ち', 'term_d'],
        ['exec', 'stopped', 'term_e'],
      ],
    )
    assert.equal(issueOfSlug(join(repo, '.dispatch', 'other')), '')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('terminalTable は端末の無い役に handle を推測せず、表を壊す | を逃がす', () => {
  process.env.ORCA_BIN = 'orca'
  const table = terminalTable([
    { task: 'a|b', issue: '', role: 'exec', agent: '', model: '', state: '-', terminal: '', environment: '' },
  ])
  assert.equal(
    table,
    '| タスク | Issue | 役 | agent / model | 状態 | 切り替え |\n|---|---|---|---|---|---|\n| a\\|b | - | exec | - | - | （端末の記録なし） |\n',
  )
})
