import { continuationOf } from '../../lib/auto-github.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const old = { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' }
const next = { repo: 'acme/app', number: 102, url: 'https://github.com/acme/app/pull/102' }
test('RQ8/RQ9 continuation includes new human comments and CI, excluding markers and old comments', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    assert.equal(continuationOf(issue, '2026-11-13T04:00:00Z'), null)
    issue.generation = 2
    issue.prevBranch = 'user/previous'
    issue.prevPrs = [old]
    f.respond('api', [
      { created_at: '2026-11-13T05:00:00Z', body: 'レビューを直してください' },
      { created_at: '2026-11-13T03:00:00Z', body: '古いコメント' },
      { created_at: '2026-11-13T05:00:00Z', body: '除外する <!-- orca-auto:failed:1:failed -->' },
    ])
    f.respond('pr_checks', [{ name: 'ci', state: 'FAILURE', link: 'https://example.invalid/check' }])
    const text = continuationOf(issue, '2026-11-13T04:00:00Z')
    assert.ok(text)
    assert.ok(text.includes('レビューを直してください'))
    assert.ok(text.includes('FAILURE'))
    assert.ok(text.includes('git reset --hard origin/user/previous'))
    assert.ok(!text.includes('古いコメント'))
    assert.ok(!text.includes('除外する'))
    f.respond('api', [{ created_at: '2026-11-13T05:00:00Z', body: 'x'.repeat(30000) }])
    assert.ok((continuationOf(issue, '2026-11-13T04:00:00Z')?.length ?? 0) <= 20000)
  } finally {
    f.cleanup()
  }
})
test('AU60 resumed generation keeps slug and includes previous branch reset in the worker request', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    const s = readState('main')
    const i = s.issues[issue.key]
    assert.ok(i)
    i.generation = 2
    i.prevBranch = 'user/previous'
    i.prevPrs = [old]
    i.endedAt = '2026-11-13T04:00:00Z'
    writeState('main', s)
    f.cli('tick')
    const current = readState('main').issues[issue.key]
    assert.ok(current)
    assert.ok(
      readFileSync(join(current.statusDir, 'request.md'), 'utf8').includes('git reset --hard origin/user/previous'),
    )
  } finally {
    f.cleanup()
  }
})
test('AU61 same branch reuses the open PR through the existing push/PR helper', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('finishing')
    f.result(issue)
    const s = readState('main')
    const i = s.issues[issue.key]
    assert.ok(i)
    i.generation = 2
    i.prevBranch = i.branch
    i.prevPrs = [old]
    writeState('main', s)
    f.cli('tick')
    assert.deepEqual(readState('main').issues[issue.key]?.prs, [old])
    assert.ok(!f.calls().includes('pr close'))
    assert.ok(f.childCalls().includes('orca-pr.ts'))
  } finally {
    f.cleanup()
  }
})
test('AU62 new branch links and closes the previous open PR without closing the new PR', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('finishing')
    f.result(issue)
    const s = readState('main')
    const i = s.issues[issue.key]
    assert.ok(i)
    i.generation = 2
    i.prevBranch = 'user/previous'
    i.prevPrs = [old]
    writeState('main', s)
    const script = join(f.dir, 'pr-view.js')
    writeFileSync(
      script,
      `const fs=require('fs');const args=process.argv.slice(2);const p=args[2]==='101'?${JSON.stringify(old)}:${JSON.stringify(next)};fs.writeFileSync(process.env.GH_STUB_DIR+'/pr_view',JSON.stringify({...p,state:'OPEN',mergedAt:null,statusCheckRollup:[{__typename:'CheckRun',status:'COMPLETED',conclusion:'SUCCESS'}]}));`,
    )
    f.hook('pr_view', `exec '${process.execPath}' '${script}' "$@"`)
    f.cli('tick')
    assert.deepEqual(readState('main').issues[issue.key]?.prs, [next])
    assert.ok(f.calls().includes('pr comment 101'))
    assert.ok(f.calls().includes(next.url))
    assert.ok(f.calls().includes('pr close 101'))
    assert.ok(!f.calls().includes('pr close 102'))
  } finally {
    f.cleanup()
  }
})
