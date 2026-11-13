import {
  cachedUserName,
  completeSlice,
  confirmInflightDead,
  countByState,
  forgetRun,
  getIssueStatus,
  getMeta,
  getScan,
  getSubmission,
  insertSubmission,
  listByStates,
  migrateToRepos,
  olderRuns,
  openDb,
  registerRun,
  saveIssueStatus,
  saveScan,
  saveUserName,
  setInflight,
  setInflightChild,
  setMeta,
  trackedIssues,
  transition,
  transitionWithStatus,
} from '../../lib/db.ts'
import { acquireLease, claimApply, markCollected, readLease, releaseLease, renewLease } from '../../lib/lease.ts'
import { parseSubmission } from '../../lib/parse.ts'
import { CHANNEL, NOW, templateText, textMessage } from '../fixtures/slack-messages.ts'
import { seedLegacyDb, tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { NewSubmission } from '../../lib/db.ts'

const sample = (ts: string): NewSubmission => {
  const p = parseSubmission(templateText(), null, [])
  assert.ok(p.kind === 'ok')
  return {
    repo: 'acme/app',
    channel: CHANNEL,
    ts,
    permalink: 'https://acme.slack.com/x',
    raw: textMessage(ts, templateText()),
    fields: p.fields,
    problems: [],
    reporterId: p.fields.reporterId,
    state: 'new',
  }
}
const setup = () => {
  const db = openDb(join(tempHome(), 'db'))
  const a = acquireLease(db, 'admin', null, new Date(NOW), 300000)
  assert.ok(a.ok)
  const id = insertSubmission(db, sample('1.0'), NOW)
  assert.ok(id)
  return { db, token: a.token, id }
}
test('DB1/DB2 スキーマの再初期化は既存の投稿を壊さず、重複を挿入しない', () => {
  const file = join(tempHome(), 'db')
  const db = openDb(file)
  assert.equal(getMeta(db, 'schema_version'), '1')
  assert.ok(insertSubmission(db, sample('1.0'), NOW))
  assert.equal(insertSubmission(db, sample('1.0'), NOW), null)
  db.close()
  const reopened = openDb(file)
  assert.equal(listByStates(reopened, ['new']).length, 1)
  reopened.close()
})
test('DB3 ts の数値順と上限', () => {
  const { db } = setup()
  for (const ts of ['1000.5', '999.9', '1000.000001']) insertSubmission(db, sample(ts), NOW)
  assert.deepEqual(
    listByStates(db, ['new'], 3).map((s) => s.ts),
    ['1.0', '999.9', '1000.000001'],
  )
  db.close()
})
test('DB4/DB5/DB6 状態とリースで比較更新し、位置と印を保存', () => {
  const { db, token, id } = setup()
  assert.ok(!transition(db, 'wrong', id, 'new', { state: 'creating' }, NOW))
  assert.ok(transition(db, token, id, 'new', { state: 'creating' }, NOW))
  assert.ok(!transition(db, token, id, 'new', {}, NOW))
  setMeta(db, 'cursor_ts', '1000.0')
  const scan = { sliceOldest: '1000.0', sliceLatest: '1100.0', resumeLatest: '1050.0' }
  assert.ok(saveScan(db, token, scan, NOW))
  assert.deepEqual(getScan(db), scan)
  assert.ok(completeSlice(db, token, '1100.0', NOW))
  assert.equal(getScan(db), null)
  assert.ok(!completeSlice(db, token, '1050.0', NOW))
  assert.equal(getMeta(db, 'cursor_ts'), '1100.0')
  assert.ok(
    setInflight(db, token, id, { owner: { pid: 1, start: 's' }, child: null, at: NOW, deadConfirmedAt: null }, NOW),
  )
  assert.ok(!setInflightChild(db, id, 3, { pid: 2, start: 'c' }))
  assert.ok(setInflightChild(db, id, 1, { pid: 2, start: 'c' }))
  assert.equal(confirmInflightDead(db, token, id, NOW), NOW)
  assert.equal(confirmInflightDead(db, token, id, '2026-11-12T00:01:00.000Z'), NOW)
  assert.equal(confirmInflightDead(db, 'wrong', id, NOW), null)
  assert.equal(getSubmission(db, id)?.inflight?.child?.pid, 2)
  db.close()
})
test('DB7 名前キャッシュの期限と全状態の件数', () => {
  const { db } = setup()
  assert.equal(Object.keys(countByState(db)).length, 11)
  saveUserName(db, 'U1', '山田', '2026-11-01T00:00:00.000Z')
  assert.equal(cachedUserName(db, 'U1', '2026-11-07T23:00:00.000Z'), '山田')
  assert.equal(cachedUserName(db, 'U1', '2026-11-08T01:00:00.000Z'), null)
  db.close()
})
test('DB8/LE7 古いリースでは run・状態・位置・印を変更できない', () => {
  const { db, token, id } = setup()
  assert.equal(registerRun(db, token, 'A', NOW), 1)
  const later = '2026-11-12T00:06:00.000Z'
  const b = acquireLease(db, 'run', 'B', new Date(later), 300000)
  assert.ok(b.ok)
  assert.equal(registerRun(db, token, 'stale', later), null)
  assert.equal(registerRun(db, b.token, 'B', later), 2)
  assert.deepEqual(olderRuns(db, 2), ['A'])
  assert.deepEqual(olderRuns(db, 1), [])
  forgetRun(db, 'A')
  assert.deepEqual(olderRuns(db, 2), [])
  assert.ok(!transition(db, token, id, 'new', { state: 'creating' }, later))
  assert.ok(!saveScan(db, token, { sliceOldest: '1', sliceLatest: '2', resumeLatest: null }, later))
  assert.ok(!completeSlice(db, token, '3', later))
  assert.ok(
    !setInflight(db, token, id, { owner: { pid: 1, start: 's' }, child: null, at: NOW, deadConfirmedAt: null }, later),
  )
  assert.ok(!renewLease(db, token, new Date(later), 10000))
  db.close()
})
test('LE1–LE5 リースの取得、回収、延長、引き継ぎは原子的', () => {
  const db = openDb(join(tempHome(), 'db'))
  const a = acquireLease(db, 'poll', null, new Date(NOW), 1000)
  assert.ok(a.ok)
  assert.ok(!acquireLease(db, 'run', 'r', new Date(NOW), 1000).ok)
  assert.ok(!releaseLease(db, 'wrong'))
  assert.ok(renewLease(db, a.token, new Date(NOW), 1000))
  const b = acquireLease(db, 'run', 'r', new Date(Date.parse(NOW) + 1001), 1000)
  assert.ok(b.ok)
  assert.notEqual(a.token, b.token)
  assert.ok(!releaseLease(db, a.token))
  const now = new Date(Date.parse(NOW) + 1100)
  assert.ok(markCollected(db, b.token, now))
  assert.ok(!claimApply(db, 'other', now).ok)
  const c = claimApply(db, 'r', now)
  assert.ok(c.ok)
  assert.notEqual(c.token, b.token)
  assert.ok(!claimApply(db, 'r', now).ok)
  assert.equal(readLease(db)?.phase, 'applying')
  assert.ok(releaseLease(db, c.token))
  assert.equal(readLease(db), null)
  db.close()
})
test('LE6 期限切れの同時回収は20回とも1プロセスだけ成功', async () => {
  const { spawn } = await import('node:child_process')
  const race = (file: string): Promise<string> =>
    new Promise((done, reject) => {
      const p = spawn(process.execPath, [join(import.meta.dirname, '../fixtures/lease-race.ts'), file, NOW], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let text = ''
      let err = ''
      p.stdout.on('data', (b: Buffer) => {
        text += b.toString()
      })
      p.stderr.on('data', (b: Buffer) => {
        err += b.toString()
      })
      p.on('close', (code) => (code === 0 ? done(text.trim()) : reject(new Error(err))))
    })
  for (let i = 0; i < 20; i++) {
    const file = join(tempHome(), 'db')
    const db = openDb(file)
    acquireLease(db, 'poll', null, new Date('2026-11-11T00:00:00.000Z'), 1000)
    db.close()
    const outputs = await Promise.all([race(file), race(file)])
    assert.deepEqual(outputs.sort(), ['busy', 'ok'])
  }
})
const row = (issueNumber: number, status: string | null) => ({
  repo: 'acme/app',
  issueNumber,
  status,
  state: 'open' as const,
  lastCommentId: 0,
  seenUpdatedAt: null,
  attempts: 0,
})
test('DB9 saveIssueStatus はリースが無効なら書かず false、有効なら upsert', () => {
  const { db, token } = setup()
  assert.equal(saveIssueStatus(db, 'wrong', row(7, 'Ready'), NOW), false)
  assert.equal(getIssueStatus(db, 'acme/app', 7), null)
  assert.ok(saveIssueStatus(db, token, row(7, 'Ready'), NOW))
  assert.ok(saveIssueStatus(db, token, { ...row(7, 'Done'), state: 'closed', lastCommentId: 5, attempts: 2 }, NOW))
  assert.deepEqual(getIssueStatus(db, 'acme/app', 7), {
    repo: 'acme/app',
    issueNumber: 7,
    status: 'Done',
    state: 'closed',
    lastCommentId: 5,
    seenUpdatedAt: null,
    attempts: 2,
  })
})
test('DB10 transitionWithStatus は状態が違えば submissions も issue_status も変えない', () => {
  const { db, token, id } = setup()
  const patch = { state: 'notifying' as const, issueUrl: 'https://github.com/acme/app/issues/9', issueNumber: 9 }
  assert.equal(transitionWithStatus(db, token, id, 'creating', patch, row(9, 'Backlog'), NOW), false)
  assert.equal(getIssueStatus(db, 'acme/app', 9), null)
  assert.equal(getSubmission(db, id)?.state, 'new')
  assert.ok(transitionWithStatus(db, token, id, 'new', patch, row(9, 'Backlog'), NOW))
  assert.equal(getIssueStatus(db, 'acme/app', 9)?.status, 'Backlog')
  assert.equal(getSubmission(db, id)?.issueNumber, 9)
  assert.deepEqual(trackedIssues(db, 'acme/app').get('acme/app#9'), {
    number: 9,
    label: 'from-slack',
    repo: 'acme/app',
    channel: CHANNEL,
    ts: '1.0',
    reporterId: getSubmission(db, id)?.reporterId,
  })
  // すでに行があれば上書きしない（最初の記録だけを残す）
  saveIssueStatus(db, token, row(9, 'Ready'), NOW)
  assert.ok(transitionWithStatus(db, token, id, 'notifying', { state: 'created' }, row(9, 'Backlog'), NOW))
  assert.equal(getIssueStatus(db, 'acme/app', 9)?.status, 'Ready')
})

test('DB11/DB13 旧DBの移行は有効なリースの下だけで行い、再実行できる', () => {
  const file = join(tempHome(), 'db')
  seedLegacyDb(file, {
    submissions: [{ ts: '1.0', issueNumber: 42, state: 'created' }],
    statuses: [{ issueNumber: 42, status: 'Ready' }],
    meta: { labels_hash: 'old' },
  })
  const db = openDb(file)
  const unchanged = () => {
    assert.equal(db.prepare('SELECT repo FROM submissions').get()?.repo, null)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='issue_status'").get())
    assert.equal(getMeta(db, 'labels_hash'), 'old')
  }
  assert.equal(migrateToRepos(db, 'missing', 'acme/app', NOW), false)
  unchanged()
  const lease = acquireLease(db, 'poll', null, new Date(NOW), 1000)
  assert.ok(lease.ok)
  assert.equal(migrateToRepos(db, 'other', 'acme/app', NOW), false)
  unchanged()
  assert.equal(migrateToRepos(db, lease.token, 'acme/app', new Date(Date.parse(NOW) + 1001).toISOString()), false)
  unchanged()
  assert.equal(migrateToRepos(db, lease.token, 'acme/app', NOW), true)
  assert.equal(migrateToRepos(db, lease.token, 'acme/web', NOW), true)
  assert.equal(db.prepare('SELECT repo FROM submissions').get()?.repo, 'acme/app')
  assert.equal(getIssueStatus(db, 'acme/app', 42)?.status, 'Ready')
  assert.equal(getIssueStatus(db, 'acme/web', 42), null)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='issue_status'").get(), undefined)
  db.close()
  const again = openDb(file)
  assert.equal(again.prepare("SELECT name FROM sqlite_master WHERE name='issue_status'").get(), undefined)
  again.close()
})
test('DB12 同じ番号をリポジトリ別に記録し、投稿のある adopted を通知対象に加える', () => {
  const { db, token } = setup()
  saveIssueStatus(db, token, { ...row(42, 'Ready'), repo: 'acme/app' }, NOW)
  saveIssueStatus(db, token, { ...row(42, 'Done'), repo: 'acme/web' }, NOW)
  assert.equal(getIssueStatus(db, 'acme/app', 42)?.status, 'Ready')
  assert.equal(getIssueStatus(db, 'acme/web', 42)?.status, 'Done')
  for (const [repo, ts] of [
    ['acme/app', '2.0'],
    ['acme/web', '3.0'],
    ['acme/none', null],
  ] as const) {
    db.prepare('INSERT INTO adopted(repo,issue_number,channel,ts,title,url,created_at) VALUES (?,42,?,?,?, ?,?)').run(
      repo,
      CHANNEL,
      ts,
      'title',
      'https://github.com/x',
      NOW,
    )
  }
  assert.deepEqual([...trackedIssues(db, 'acme/app').keys()], ['acme/app#42', 'acme/web#42'])
  assert.equal(trackedIssues(db, 'acme/app').get('acme/web#42')?.label, 'slack-thread')
  const id = insertSubmission(db, { ...sample('4.0'), repo: 'acme/app' }, NOW)
  assert.ok(id)
  transition(db, token, id, 'new', { issueNumber: 42 }, NOW)
  assert.equal(trackedIssues(db, 'acme/app').get('acme/app#42')?.label, 'from-slack')
  assert.equal(trackedIssues(db, 'acme/app').get('acme/app#42')?.ts, '4.0')
  db.close()
})
