import { trustBlocked, trustHint, trustRoot } from '../../lib/trust.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trust-unit-')))
after(() => rmSync(dir, { recursive: true, force: true }))
// ★ tmpdir が別の repository の中にあっても、その repository を拾わせない（trustRoot が走らせる git も同じ env を読む）
process.env.GIT_CEILING_DIRECTORIES = dir

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

// ★ 2026-09-24 の influencer-platform: 起動が agent-trust-workspace で failed になった。worker-show の
//   worker.lastError と dispatch.lastFailure にその語が載る
test('trustBlocked は worker.lastError と dispatch.lastFailure だけを読む', () => {
  const blocked = 'Agent startup blocked: agent-trust-workspace'
  assert.equal(trustBlocked({ ok: true, result: { worker: { lastError: blocked } } }), true)
  assert.equal(trustBlocked({ ok: true, result: { dispatch: { lastFailure: blocked } } }), true)
  // 画面にこの語が出ているだけの worker を、信頼で止まった起動と取り違えない
  assert.equal(trustBlocked({ ok: true, result: { terminal: { preview: blocked } } }), false)
  assert.equal(trustBlocked({ ok: true, result: { worker: { lastError: 'terminal_handle_stale' } } }), false)
  assert.equal(trustBlocked(null), false)
})

// ★ codex は信頼を worktree ではなく本体の checkout の root に記録する（resolve_root_git_project_for_trust）
test('trustRoot は linked worktree から本体の checkout の root を返す', () => {
  const main = join(dir, 'main')
  mkdirSync(main)
  git(main, 'init', '-q')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'seed')
  const linked = join(dir, 'linked')
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked)
  assert.equal(realpathSync(trustRoot(linked)), realpathSync(main))
  assert.equal(realpathSync(trustRoot(main)), realpathSync(main))
  // git が読めない path はそのまま返し、空の path を git に渡さない（`git -C ''` は今のディレクトリを答える）
  const plain = join(dir, 'plain')
  mkdirSync(plain)
  assert.equal(trustRoot(plain), plain)
  assert.equal(trustRoot(''), '')
})

test('trustHint は信頼する 2 行と、信頼したあとの回復の 1 行を出す', () => {
  const plain = join(dir, 'hint')
  mkdirSync(plain)
  const lines = trustHint('design_review', 'term_t', plain, 'node recover.ts --status-dir /sd --role design_review')
  assert.ok(lines[0]?.startsWith('design_review: codex stopped at its "Trust this folder?" screen in terminal term_t'))
  assert.ok(lines.includes(`  [projects."${plain}"]`))
  assert.ok(lines.includes('  trust_level = "trusted"'))
  assert.ok(lines.some((line) => line.endsWith('node recover.ts --status-dir /sd --role design_review')))
})
