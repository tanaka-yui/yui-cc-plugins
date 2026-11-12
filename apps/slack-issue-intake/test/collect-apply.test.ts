import { getSubmission, listByStates, openDb } from '../lib/db.ts'
import { acquireLease, readLease, releaseLease } from '../lib/lease.ts'
import { homePaths, runPaths } from '../lib/paths.ts'
import { cleanupOlderRuns, prepareRun } from '../lib/runs.ts'
import { readWork } from '../lib/work.ts'
import { NOW, templateText, textMessage, tsAt } from './fixtures/slack-messages.ts'
import {
  fakeGh,
  ghCalls,
  historyHandler,
  repliesHandler,
  runCliAsync,
  seedSubmission,
  setupHome,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const setup = async (t: { after: (fn: () => Promise<void>) => void }, handler?: (r: SlackRequest) => SlackReply) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const server = await startSlack((r): SlackReply => {
    if (handler) return handler(r)
    if (r.method === 'conversations.history') return historyHandler([], 10)(r)
    if (r.method === 'conversations.replies')
      return repliesHandler({
        [tsAt(1000)]: [textMessage(tsAt(1000), templateText()), { ts: tsAt(500), user: 'U012AB3CD', text: '追加です' }],
      })(r)
    if (r.method === 'users.info') return { json: { ok: true, user: { profile: { display_name: '山田 太郎' } } } }
    if (r.method === 'chat.postMessage') return { json: { ok: true, ts: tsAt(1) } }
    return { json: { ok: true } }
  })
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const cli = (args: string[], extra: Record<string, string> = {}) =>
    runCliAsync([...args, '--now', NOW], { ...env, ...extra })
  const read = (id: number) => {
    const db = openDb(homePaths(home).db)
    const s = getSubmission(db, id)
    db.close()
    return s
  }
  const collect = async () => {
    const r = await cli(['collect'])
    assert.equal(r.code, 0, r.stderr)
    const id = r.stdout.match(/^run=(.+)$/m)?.[1] ?? ''
    return { r, id, paths: runPaths(homePaths(home).runsDir, id) }
  }
  return { home, gh, server, env, cli, read, collect }
}
test('CA1/CA2 collectは自分のrunに文脈を書き、空ならリースを放す', async (t) => {
  const f = await setup(t)
  await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const c = await f.collect()
  const work = readWork(c.paths.workFile)
  assert.equal(work?.runId, c.id)
  assert.equal(work?.items[0]?.reporter, '山田 太郎')
  assert.equal(work?.items[0]?.thread[0]?.name, '山田 太郎')
  const db = openDb(homePaths(f.home).db)
  assert.equal(readLease(db)?.phase, 'collected')
  assert.equal(readLease(db)?.runId, c.id)
  db.close()
  const empty = await setup(t)
  const no = await empty.cli(['collect'])
  assert.match(no.stdout, /items=0/)
  const db2 = openDb(homePaths(empty.home).db)
  assert.equal(readLease(db2), null)
  db2.close()
})
test('CA3 リースがあればrunの内容に触れない', async (t) => {
  const f = await setup(t)
  const paths = runPaths(homePaths(f.home).runsDir, 'existing')
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.workFile, 'old')
  const before = statSync(paths.workFile).mtimeMs
  const db = openDb(homePaths(f.home).db)
  acquireLease(db, 'poll', null, new Date(NOW), 90000)
  db.close()
  const r = await f.cli(['collect'])
  assert.equal(r.code, 4)
  assert.equal(readFileSync(paths.workFile, 'utf8'), 'old')
  assert.equal(statSync(paths.workFile).mtimeMs, before)
})
test('CA4 askにメンション・エスケープ・案内を付けてwaiting', async (t) => {
  const f = await setup(t)
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const c = await f.collect()
  writeFileSync(
    c.paths.decisionsFile,
    JSON.stringify({
      runId: c.id,
      decisions: [{ id, action: 'ask', message: '<!channel> こういうことですか？\n1. いつから？' }],
    }),
  )
  const r = await f.cli(['apply', '--run', c.id])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /asked id=/)
  assert.equal(f.read(id)?.state, 'waiting')
  assert.equal(f.read(id)?.rounds, 1)
  assert.equal(
    f.server.requests.at(-1)?.params.text,
    '<@U012AB3CD> &lt;!channel&gt; こういうことですか？\n1. いつから？\n\n（このスレッドに返信してください。返信をもとに Issue を作成します）',
  )
  assert.ok(!existsSync(c.paths.dir))
})
test('CA5/CA6 createを作成して通知し、期限切れを明示', async (t) => {
  for (const state of ['new', 'timed_out'] as const) {
    const f = await setup(t)
    const id = await seedSubmission(f.home, {
      ts: tsAt(1000),
      state,
      ...(state === 'timed_out' ? { timedOutAt: NOW } : {}),
    })
    const c = await f.collect()
    writeFileSync(
      c.paths.decisionsFile,
      JSON.stringify({
        runId: c.id,
        decisions: [{ id, action: 'create', summary: '要約', details: '詳細', unresolved: [] }],
      }),
    )
    const r = await f.cli(['apply', '--run', c.id])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(f.read(id)?.state, 'created')
    assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
    if (state === 'timed_out') assert.match(f.server.requests.at(-1)?.params.text ?? '', /回答がなかったため/)
  }
})
test('CA7/CA8 不正な決定とrunIdは副作用なく拒否して直せる', async (t) => {
  const f = await setup(t)
  await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const c = await f.collect()
  f.server.requests.length = 0
  writeFileSync(c.paths.decisionsFile, '{}')
  assert.equal((await f.cli(['apply', '--run', c.id])).code, 3)
  const db = openDb(homePaths(f.home).db)
  assert.equal(readLease(db)?.phase, 'collected')
  db.close()
  assert.equal(f.server.requests.length, 0)
  assert.equal(ghCalls(f.gh.log).length, 0)
  assert.equal((await f.cli(['apply', '--run', '../x'])).code, 2)
  assert.equal((await f.cli(['apply', '--run', randomUUID()])).code, 2)
  const otherId = randomUUID()
  const other = runPaths(homePaths(f.home).runsDir, otherId)
  mkdirSync(other.dir, { recursive: true })
  const work = readWork(c.paths.workFile)
  assert.ok(work)
  work.runId = otherId
  writeFileSync(other.workFile, JSON.stringify(work))
  writeFileSync(
    other.decisionsFile,
    JSON.stringify({
      runId: otherId,
      decisions: work.items.map((i) => ({ id: i.id, action: 'ask', message: '確認ですか？' })),
    }),
  )
  assert.equal((await f.cli(['apply', '--run', otherId])).code, 2)
  assert.ok(existsSync(other.workFile))
  assert.equal(f.server.requests.length, 0)
  const unchanged = openDb(homePaths(f.home).db)
  assert.equal(readLease(unchanged)?.runId, c.id)
  assert.equal(readLease(unchanged)?.phase, 'collected')
  unchanged.close()
})
test('CA9 procedureは値を埋めた許可コマンドと上限を表示', async (t) => {
  const f = await setup(t)
  const r = await runCliAsync(['procedure'], f.env)
  assert.equal(r.code, 0)
  assert.ok(!r.stdout.includes('{{'))
  assert.match(r.stdout, /apply --run <run id>/)
  assert.match(r.stdout, /at most 3 numbered questions/i)
})
test('CA10 同じrunを同時applyしても作成は1回', async (t) => {
  const f = await setup(t)
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const c = await f.collect()
  writeFileSync(
    c.paths.decisionsFile,
    JSON.stringify({
      runId: c.id,
      decisions: [{ id, action: 'create', summary: '要約', details: '詳細', unresolved: [] }],
    }),
  )
  const outputs = await Promise.all([
    f.cli(['apply', '--run', c.id], { FAKE_GH_SLEEP_ON: 'issue create', FAKE_GH_SLEEP_MS: '300' }),
    f.cli(['apply', '--run', c.id], { FAKE_GH_SLEEP_ON: 'issue create', FAKE_GH_SLEEP_MS: '300' }),
  ])
  assert.deepEqual(outputs.map((o) => o.code).sort(), [0, 2])
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
})
test('CA11/CA13 読めないスレッドは記録を保ち、後ろの件で10件埋める', async (t) => {
  const f = await setup(t, (r): SlackReply => {
    if (r.method === 'conversations.history') return { json: { ok: true, messages: [] } }
    if (r.method === 'conversations.replies') {
      if (r.params.ts === tsAt(2000)) return { status: 500 }
      if (r.params.ts === tsAt(3000)) return { json: { ok: false, error: 'thread_not_found' } }
      return { json: { ok: true, messages: [] } }
    }
    return { json: { ok: true } }
  })
  const transcript = [{ ts: '1', from: 'human' as const, userId: 'U1', name: '山田', text: '保存済み', files: [] }]
  const failed = await seedSubmission(f.home, { ts: tsAt(3000), state: 'answered', transcript })
  const skipped = await seedSubmission(f.home, { ts: tsAt(2000), state: 'answered', transcript })
  for (let i = 0; i < 11; i++) await seedSubmission(f.home, { ts: tsAt(1000 - i), state: 'new' })
  const c = await f.collect()
  assert.equal(readWork(c.paths.workFile)?.items.length, 10)
  assert.equal(f.read(failed)?.state, 'failed')
  assert.equal(f.read(skipped)?.state, 'answered')
  assert.deepEqual(f.read(skipped)?.transcript, transcript)
  assert.deepEqual(f.read(failed)?.transcript, transcript)
})
test('CA14 遅れて再開したcollectは新しい世代のディレクトリを消さない', () => {
  const home = tempHome()
  const paths = homePaths(home)
  const db = openDb(paths.db)
  const a = acquireLease(db, 'run', 'A', new Date(NOW), 1000)
  assert.ok(a.ok)
  const old = prepareRun(db, a.token, paths.runsDir, 'old', NOW)
  const runA = prepareRun(db, a.token, paths.runsDir, 'A', NOW)
  assert.ok(old && runA)
  releaseLease(db, a.token)
  const b = acquireLease(db, 'run', 'B', new Date(NOW), 1000)
  assert.ok(b.ok)
  const runB = prepareRun(db, b.token, paths.runsDir, 'B', NOW)
  assert.ok(runB)
  writeFileSync(runB.paths.workFile, 'new')
  const before = statSync(runB.paths.workFile).mtimeMs
  cleanupOlderRuns(db, paths.runsDir, runA.seq)
  assert.equal(readFileSync(runB.paths.workFile, 'utf8'), 'new')
  assert.equal(statSync(runB.paths.workFile).mtimeMs, before)
  assert.equal(prepareRun(db, a.token, paths.runsDir, 'stale', NOW), null)
  assert.ok(!existsSync(join(paths.runsDir, 'stale')))
  assert.equal(listByStates(db, ['new']).length, 0)
  db.close()
})
test('CA12 古いapplyがリースを失っても新しいrunを壊さず、作成を回復できる', async (t) => {
  const f = await setup(t, (r): SlackReply => {
    if (r.method === 'chat.postMessage') return { json: { ok: true, ts: tsAt(1) } }
    return { json: { ok: true, messages: [] } }
  })
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const a = await f.collect()
  writeFileSync(
    a.paths.decisionsFile,
    JSON.stringify({
      runId: a.id,
      decisions: [{ id, action: 'create', summary: '要約', details: '詳細', unresolved: [] }],
    }),
  )
  const applying = f.cli(['apply', '--run', a.id], { FAKE_GH_SLEEP_ON: 'issue create', FAKE_GH_SLEEP_MS: '1000' })
  let entered = false
  for (let i = 0; i < 100; i++) {
    if (ghCalls(f.gh.log).some((c) => c.argv[0] === 'issue')) {
      entered = true
      break
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  assert.ok(entered)
  const db = openDb(homePaths(f.home).db)
  db.prepare("UPDATE lease SET expires_at='2000-01-01T00:00:00.000Z'").run()
  db.close()
  const second = await seedSubmission(f.home, { ts: tsAt(900), state: 'new' })
  const b = await f.collect()
  writeFileSync(b.paths.decisionsFile, 'keep')
  const before = statSync(b.paths.workFile).mtimeMs
  const old = await applying
  assert.equal(old.code, 1)
  assert.ok(!existsSync(a.paths.dir))
  assert.equal(statSync(b.paths.workFile).mtimeMs, before)
  assert.equal(readFileSync(b.paths.decisionsFile, 'utf8'), 'keep')
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
  writeFileSync(
    b.paths.decisionsFile,
    JSON.stringify({ runId: b.id, decisions: [{ id: second, action: 'ask', message: '確認ですか？' }] }),
  )
  assert.equal((await f.cli(['apply', '--run', b.id])).code, 0)
  const { seedIssues } = await import('./helpers.ts')
  const issues = JSON.parse(readFileSync(f.gh.state, 'utf8')) as Array<{ created_at: string }>
  seedIssues(
    f.gh.state,
    issues.map((i) => ({ ...i, created_at: NOW })),
  )
  await runCliAsync(['poll', '--now', '2026-11-12T00:02:00.000Z'], f.env)
  assert.equal(f.read(id)?.lastError, 'create settling')
  await runCliAsync(['poll', '--now', '2026-11-12T00:04:00.000Z'], f.env)
  assert.equal(f.read(id)?.state, 'created')
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
})
test('CA1 添付をfilesとpermalinkと返信から集め、連番で保存してIssueへリンク', async (t) => {
  let base = ''
  const ref = (id: string, name: string, mimetype: string) => ({
    id,
    name,
    mimetype,
    size: 3,
    permalink: `https://acme.slack.com/files/U1/${id}/${name}`,
    url_private_download: `${base}/download/${id}`,
  })
  const f = await setup(t, (r): SlackReply => {
    if (r.method === 'conversations.history') return { json: { ok: true, messages: [] } }
    if (r.method === 'conversations.replies')
      return {
        json: {
          ok: true,
          messages: [
            { ts: tsAt(500), user: 'U012AB3CD', text: '追加資料', files: [ref('F3', 'thread.txt', 'text/plain')] },
          ],
        },
      }
    if (r.method === 'users.info') return { json: { ok: true, user: { profile: { display_name: '山田 太郎' } } } }
    if (r.method === 'files.info') return { json: { ok: true, file: ref('F2', 'second.png', 'image/png') } }
    if (r.method === 'chat.postMessage') return { json: { ok: true, ts: tsAt(1) } }
    return { bytes: new Uint8Array([1, 2, 3]) }
  })
  base = f.server.url
  const raw = textMessage(tsAt(1000), templateText({ body: '見て https://acme.slack.com/files/U1/F2/second.png' }), {
    files: [ref('F1', 'first.png', 'image/png')],
  })
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'new', raw })
  const c = await f.collect()
  const work = readWork(c.paths.workFile)
  const item = work?.items[0]
  assert.equal(item?.attachments.length, 2)
  assert.equal(item?.thread[0]?.attachments.length, 1)
  assert.equal(item?.attachments[0]?.localPath, join(c.paths.filesDir, String(id), '1-first.png'))
  assert.equal(item?.attachments[1]?.localPath, join(c.paths.filesDir, String(id), '2-second.png'))
  assert.equal(item?.thread[0]?.attachments[0]?.localPath, join(c.paths.filesDir, String(id), '3-thread.txt'))
  for (const a of [...(item?.attachments ?? []), ...(item?.thread[0]?.attachments ?? [])])
    assert.ok(a.localPath && existsSync(a.localPath))
  writeFileSync(
    c.paths.decisionsFile,
    JSON.stringify({
      runId: c.id,
      decisions: [{ id, action: 'create', summary: '要約', details: '詳細', unresolved: [] }],
    }),
  )
  assert.equal((await f.cli(['apply', '--run', c.id])).code, 0)
  const body = ghCalls(f.gh.log).find((c) => c.argv[0] === 'issue')?.body ?? ''
  for (const file of ['first.png', 'second.png', 'thread.txt']) assert.ok(body.includes(file))
})
test('CA15 files.infoの一時失敗では添付・やり取り・名前を空で確定しない', async (t) => {
  for (const status of [500, 429])
    for (const root of [true, false]) {
      const f = await setup(t, (r): SlackReply => {
        if (r.method === 'conversations.history') return { json: { ok: true, messages: [] } }
        if (r.method === 'conversations.replies')
          return {
            json: {
              ok: true,
              messages: root
                ? []
                : [{ ts: tsAt(500), user: 'U012AB3CD', text: 'https://acme.slack.com/files/U1/F2/a.png' }],
            },
          }
        if (r.method === 'users.info') return { json: { ok: true, user: { profile: { display_name: '山田' } } } }
        if (r.method === 'files.info') return { status }
        return { json: { ok: true } }
      })
      const oldFile = {
        id: 'FOLD',
        name: 'old.png',
        mimetype: 'image/png',
        size: 3,
        permalink: 'https://acme.slack.com/files/U1/FOLD/a.png',
        downloadUrl: null,
      }
      const transcript = [
        {
          ts: tsAt(800),
          from: 'human' as const,
          userId: 'U012AB3CD',
          name: '旧名',
          text: '保存済み',
          files: [oldFile],
        },
      ]
      const id = await seedSubmission(f.home, {
        ts: tsAt(1000),
        state: 'answered',
        reporterName: '旧名',
        files: [oldFile],
        transcript,
        raw: textMessage(
          tsAt(1000),
          templateText({ body: root ? 'https://acme.slack.com/files/U1/F2/a.png' : '本文' }),
        ),
      })
      const r = await f.cli(['collect'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`skipped id=${id} reason=`))
      assert.match(r.stdout, /items=0/)
      assert.deepEqual(f.read(id)?.files, [oldFile])
      assert.deepEqual(f.read(id)?.transcript, transcript)
      assert.equal(f.read(id)?.reporterName, '旧名')
      if (status === 429) assert.equal(f.server.requests.at(-1)?.method, 'files.info')
    }
})
test('CA16 users.infoの一時失敗でも既存の名前とやり取りを保持', async (t) => {
  const f = await setup(
    t,
    (r): SlackReply =>
      r.method === 'users.info'
        ? { status: 500 }
        : {
            json: {
              ok: true,
              messages:
                r.method === 'conversations.replies' ? [{ ts: tsAt(500), user: 'U012AB3CD', text: '返信' }] : [],
            },
          },
  )
  const transcript = [
    { ts: tsAt(800), from: 'human' as const, userId: 'U012AB3CD', name: '旧名', text: '保存済み', files: [] },
  ]
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'answered', reporterName: '旧名', transcript })
  const r = await f.cli(['collect'])
  assert.match(r.stdout, /items=0/)
  assert.match(r.stdout, /skipped id=/)
  assert.equal(f.read(id)?.reporterName, '旧名')
  assert.deepEqual(f.read(id)?.transcript, transcript)
})
test('CA17 本番のapplyから試験用時刻を注入できない', async (t) => {
  const f = await setup(t)
  const id = await seedSubmission(f.home, { ts: tsAt(1000), state: 'new' })
  const c = await f.collect()
  writeFileSync(
    c.paths.decisionsFile,
    JSON.stringify({ runId: c.id, decisions: [{ id, action: 'ask', message: '確認ですか？' }] }),
  )
  const env = { ...f.env }
  delete env.SLACK_ISSUE_INTAKE_API_BASE
  const count = f.server.requests.length
  const r = await runCliAsync(['apply', '--run', c.id, '--now', '2000-01-01T00:00:00.000Z'], env)
  assert.equal(r.code, 2)
  assert.equal(f.server.requests.length, count)
  assert.equal(f.read(id)?.state, 'new')
})
test('CA18 恒久的に見えない名前やファイルでも件を処理対象に入れる', async (t) => {
  for (const error of ['user_not_visible', 'no_permission', 'access_denied', 'ekm_access_denied']) {
    const userError = error === 'user_not_visible'
    const f = await setup(t, (r): SlackReply => {
      if (r.method === 'conversations.history') return { json: { ok: true, messages: [] } }
      if (r.method === 'conversations.replies')
        return { json: { ok: true, messages: userError ? [{ ts: tsAt(500), user: 'U012AB3CD', text: '返信' }] : [] } }
      if (r.method === 'users.info')
        return userError
          ? { json: { ok: false, error } }
          : { json: { ok: true, user: { profile: { display_name: '山田' } } } }
      if (r.method === 'files.info') return { json: { ok: false, error } }
      return { json: { ok: true } }
    })
    const previous = [
      { ts: tsAt(800), from: 'human' as const, userId: 'U012AB3CD', name: '旧名', text: '記録', files: [] },
    ]
    const raw = textMessage(
      tsAt(1000),
      templateText({ body: userError ? '本文' : 'https://acme.slack.com/files/U1/F2/a.png' }),
    )
    await seedSubmission(f.home, { ts: tsAt(1000), state: 'new', raw, reporterName: '旧名', transcript: previous })
    const c = await f.collect()
    const work = readWork(c.paths.workFile)
    assert.equal(work?.items.length, 1)
    if (userError) {
      assert.equal(work?.items[0]?.reporter, '旧名')
      assert.equal(work?.items[0]?.thread[0]?.name, '旧名')
    } else assert.equal(work?.items[0]?.attachments.length, 0)
  }
})
test('CA19 一時障害の連続スキップも上限でfailedにしてClaudeの起動を止める', async (t) => {
  const { MAX_ACTION_ATTEMPTS } = await import('../lib/defaults.ts')
  const f = await setup(
    t,
    (r): SlackReply => (r.method === 'files.info' ? { status: 500 } : { json: { ok: true, messages: [] } }),
  )
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'new',
    raw: textMessage(tsAt(1000), templateText({ body: 'https://acme.slack.com/files/U1/F2/a.png' })),
  })
  for (let i = 1; i <= MAX_ACTION_ATTEMPTS; i++) {
    const r = await f.cli(['collect'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(f.read(id)?.attempts, i)
    if (i < MAX_ACTION_ATTEMPTS) assert.equal(f.read(id)?.state, 'new')
    else assert.match(r.stdout, new RegExp(`failed id=${id} reason=http: 500`))
  }
  assert.equal(f.read(id)?.state, 'failed')
  assert.equal(f.read(id)?.failedFrom, 'new')
  assert.equal(f.read(id)?.lastError, 'http: 500')
  const poll = await f.cli(['poll'])
  assert.equal(poll.code, 1)
  assert.match(poll.stdout, /agent_work=0/)
})
test('CA20 メタデータ取得が成功したら連続失敗の回数をリセットする', async (t) => {
  const f = await setup(
    t,
    (r): SlackReply =>
      r.method === 'files.info'
        ? {
            json: {
              ok: true,
              file: {
                id: 'F2',
                name: 'a.mp4',
                mimetype: 'video/mp4',
                size: 3,
                permalink: 'https://acme.slack.com/files/U1/F2/a.mp4',
              },
            },
          }
        : { json: { ok: true, messages: [] } },
  )
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'new',
    attempts: 9,
    lastError: 'http: 500',
    raw: textMessage(tsAt(1000), templateText({ body: 'https://acme.slack.com/files/U1/F2/a.mp4' })),
  })
  const c = await f.collect()
  assert.equal(readWork(c.paths.workFile)?.items.length, 1)
  assert.equal(f.read(id)?.attempts, 0)
  assert.equal(f.read(id)?.lastError, null)
})
test('CA21 認証などの致命エラーは縮退して続行せず停止する', async (t) => {
  const f = await setup(
    t,
    (r): SlackReply =>
      r.method === 'files.info' ? { json: { ok: false, error: 'invalid_auth' } } : { json: { ok: true, messages: [] } },
  )
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'new',
    raw: textMessage(tsAt(1000), templateText({ body: 'https://acme.slack.com/files/U1/F2/a.png' })),
  })
  const r = await f.cli(['collect'])
  assert.equal(r.code, 3)
  assert.equal(f.read(id)?.state, 'new')
  assert.equal(f.read(id)?.attempts, 1)
  assert.equal(f.server.requests.at(-1)?.method, 'files.info')
})
