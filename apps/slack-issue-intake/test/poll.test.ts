import { countByState, getMeta, getScan, getSubmission, openDb } from '../lib/db.ts'
import { acquireLease } from '../lib/lease.ts'
import { homePaths } from '../lib/paths.ts'
import { BOT_USER, CHANNEL, NOW, NOW_SEC, templateText, textMessage, tsAt } from './fixtures/slack-messages.ts'
import {
  fakeGh,
  ghCalls,
  historyHandler,
  repliesHandler,
  runCliAsync,
  seedIssues,
  seedSubmission,
  setupHome,
  startIdleProcess,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  options: {
    messages?: ReturnType<typeof textMessage>[]
    page?: number
    handler?: (r: SlackRequest) => SlackReply
    cursor?: string
  } = {},
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const history = historyHandler(options.messages ?? [], options.page ?? 100)
  const server = await startSlack(
    (r): SlackReply =>
      options.handler?.(r) ??
      (r.method === 'chat.postMessage'
        ? { json: { ok: true, ts: tsAt(1) } }
        : r.method === 'conversations.replies'
          ? { json: { ok: true, messages: [] } }
          : history(r)),
  )
  t.after(() => server.close())
  const env = {
    ...gh.env,
    ...(await setupHome(home, {
      apiBase: server.url,
      ghPath: gh.ghPath,
      ghState: gh.state,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    })),
  }
  const poll = (at = NOW, extra: string[] = [], patch: Record<string, string> = {}) =>
    runCliAsync(['poll', '--now', at, ...extra], { ...env, ...patch })
  const read = (id: number) => {
    const db = openDb(homePaths(home).db)
    const s = getSubmission(db, id)
    db.close()
    return s
  }
  return { home, gh, server, env, poll, read }
}
const content = { action: 'create' as const, summary: '要約', details: '詳細', unresolved: [] }
test('PO1/PO2/PO13/PO19 投稿を受付境界で選別し、cursorを進め、何も無ければ起動しない', async (t) => {
  const f = await fixture(t, {
    messages: [
      textMessage(tsAt(3595), templateText()),
      textMessage(tsAt(3605), templateText()),
      textMessage(tsAt(100), '雑談'),
      textMessage(tsAt(200), templateText(), { subtype: 'message_changed' }),
    ],
  })
  const r = await f.poll()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /result=work agent_work=1/)
  const db = openDb(homePaths(f.home).db)
  assert.equal(countByState(db).new, 1)
  assert.equal(getMeta(db, 'cursor_ts'), `${NOW_SEC - 60}.000000`)
  assert.equal(getScan(db), null)
  db.close()
  assert.equal(f.server.requests.filter((r) => r.method === 'chat.postMessage').length, 0)
  const idle = await fixture(t)
  assert.equal((await idle.poll()).code, 1)
})
test('PO3 不正なフォームはClaudeなしで不備を返信', async (t) => {
  const f = await fixture(t, { messages: [textMessage(tsAt(100), templateText({ category: 'その他' }))] })
  assert.equal((await f.poll()).code, 1)
  assert.equal(f.read(1)?.state, 'rejected')
  const sent = f.server.requests.find((r) => r.method === 'chat.postMessage')
  assert.ok(sent?.params.text?.startsWith('<@U012AB3CD> フォームの内容を読み取れませんでした（カテゴリが'))
})
test('PO4/PO5/PO12/PO18 読めた返信だけで回答・期限切れ・削除を判定', async (t) => {
  const threads = repliesHandler({
    [tsAt(1000)]: [{ ts: tsAt(1000) }, { ts: tsAt(100), user: 'U1' }],
    [tsAt(1100)]: [{ ts: tsAt(1100) }, { ts: tsAt(100), user: BOT_USER, bot_id: 'B1' }],
  })
  const f = await fixture(t, {
    handler: (r) => (r.method === 'conversations.replies' ? threads(r) : { json: { ok: true, messages: [] } }),
  })
  const a = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'waiting',
    lastQuestionTs: tsAt(500),
    askedAt: '2026-11-08T00:00:00.000Z',
  })
  const b = await seedSubmission(f.home, {
    ts: tsAt(1100),
    state: 'waiting',
    lastQuestionTs: tsAt(500),
    askedAt: '2026-11-08T00:00:00.000Z',
  })
  const c = await seedSubmission(f.home, { ts: tsAt(1200), state: 'waiting', lastQuestionTs: tsAt(500), askedAt: NOW })
  assert.equal((await f.poll()).code, 0)
  assert.equal(f.read(a)?.state, 'answered')
  assert.equal(f.read(b)?.state, 'timed_out')
  assert.equal(f.read(c)?.state, 'failed')
})
test('PO6 creatingから同じ回に作成とURL通知', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
    createLogin: 'intake-bot',
  })
  const r = await f.poll()
  assert.equal(r.code, 1, r.stderr)
  assert.equal(f.read(id)?.state, 'created')
  assert.equal(f.read(id)?.inflight, null)
  const create = ghCalls(f.gh.log).find((c) => c.argv[0] === 'issue')
  assert.ok(create?.body?.endsWith(`<!-- slack-issue-intake:${CHANNEL}:${tsAt(1000)} -->`))
  assert.match(
    f.server.requests.find((r) => r.method === 'chat.postMessage')?.params.text ?? '',
    /Issue を作成しました: https:/,
  )
})
test('PO7/PO23 応答喪失は死活確認から90秒待ち、アカウント復帰後に既存Issueを採用', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
  })
  await f.poll(NOW, [], { FAKE_GH_CREATE: 'lost' })
  const saved = JSON.parse(readFileSync(f.gh.state, 'utf8')) as Array<{ created_at: string }>
  seedIssues(
    f.gh.state,
    saved.map((issue) => ({ ...issue, created_at: NOW })),
  )
  assert.equal(f.read(id)?.state, 'creating')
  assert.ok(f.read(id)?.inflight)
  await f.poll('2026-11-12T00:00:30.000Z')
  assert.equal(f.read(id)?.lastError, 'create settling')
  assert.equal(f.read(id)?.inflight?.deadConfirmedAt, '2026-11-12T00:00:30.000Z')
  await f.poll('2026-11-12T00:01:40.000Z')
  assert.equal(f.read(id)?.lastError, 'create settling')
  await f.poll('2026-11-12T00:02:10.000Z', [], { FAKE_GH_LOGIN: 'other' })
  assert.equal(f.read(id)?.lastError, 'gh account changed')
  await f.poll('2026-11-12T00:02:20.000Z')
  assert.equal(f.read(id)?.state, 'created')
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
})
test('PO8 10回失敗したらfailedにして管理者確認だけを返信', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
    attempts: 9,
  })
  await f.poll(NOW, [], { FAKE_GH_CREATE: 'fail' })
  assert.equal(f.read(id)?.state, 'failed')
  assert.equal(f.read(id)?.failedFrom, 'creating')
  assert.match(
    f.server.requests.find((r) => r.method === 'chat.postMessage')?.params.text ?? '',
    /Issue の作成に失敗しました。管理者が確認します。/,
  )
})
test('PO9/PO18 429のあと呼び出さず、返信取得の失敗を期限切れにしない', async (t) => {
  const f = await fixture(t, {
    handler: (r) =>
      r.method === 'conversations.replies'
        ? { status: 429, headers: { 'Retry-After': '30' } }
        : { json: { ok: true, messages: [] } },
  })
  await seedSubmission(f.home, { ts: tsAt(3000), state: 'new' })
  const a = await seedSubmission(f.home, { ts: tsAt(2000), state: 'waiting', askedAt: '2026-11-08T00:00:00.000Z' })
  await seedSubmission(f.home, { ts: tsAt(1000), state: 'waiting', askedAt: '2026-11-08T00:00:00.000Z' })
  const r = await f.poll()
  assert.equal(r.code, 0)
  assert.match(r.stdout, /partial=true/)
  assert.equal(f.server.requests.filter((r) => r.method === 'conversations.replies').length, 1)
  assert.equal(f.read(a)?.state, 'waiting')
})
test('PO10/PO11 履歴を6時間区間とページに分け、失敗したページから再開', async (t) => {
  const all = Array.from({ length: 250 }, (_, i) => textMessage(tsAt(100 + i * 600), templateText()))
  const handler = historyHandler(all, 20)
  let n = 0
  let fail = true
  const f = await fixture(t, {
    cursor: tsAt(172800, 0),
    handler: (r) => {
      if (r.method !== 'conversations.history') return { json: { ok: true, messages: [] } }
      if (++n === 3 && fail) return { status: 500 }
      return handler(r)
    },
  })
  await f.poll()
  const db = openDb(homePaths(f.home).db)
  assert.ok(getScan(db)?.resumeLatest)
  db.close()
  fail = false
  await f.poll()
  const done = openDb(homePaths(f.home).db)
  assert.equal(countByState(done).new, 250)
  assert.equal(getMeta(done, 'cursor_ts'), `${NOW_SEC - 60}.000000`)
  assert.equal(getScan(done), null)
  done.close()
  assert.ok(f.server.requests.some((r) => r.params.inclusive === 'false'))
})
test('PO14/PO15 有効なリースと未設定・致命エラーを区別', async (t) => {
  const f = await fixture(t)
  const db = openDb(homePaths(f.home).db)
  acquireLease(db, 'run', 'r', new Date(NOW), 100000)
  db.close()
  const r = await f.poll()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /result=busy/)
  assert.equal(f.server.requests.length, 0)
  const absent = await runCliAsync(['poll'], { SLACK_ISSUE_INTAKE_HOME: tempHome() })
  assert.equal(absent.code, 2)
  const fatal = await fixture(t, { handler: () => ({ json: { ok: false, error: 'invalid_auth' } }) })
  assert.equal((await fatal.poll()).code, 3)
})
test('PO16 同じ時間予算を繰り返して大量の区間を必ず読み終える', async (t) => {
  const all = Array.from({ length: 15 }, (_, i) => textMessage(tsAt(100 + i * 10), templateText()))
  const handler = historyHandler(all, 3)
  const f = await fixture(t, { handler: (r) => ({ ...handler(r), delayMs: 150 }) })
  let finished = false
  let previousCount = 0
  let previousResume: string | null = null
  for (let i = 0; i < 5; i++) {
    const r = await f.poll(NOW, ['--deadline-ms', '400'])
    assert.ok(r.ms < 2000)
    const db = openDb(homePaths(f.home).db)
    const count = countByState(db).new
    const resume = getScan(db)?.resumeLatest ?? null
    assert.ok(count > previousCount)
    if (resume && previousResume) assert.ok(Number(resume) < Number(previousResume))
    previousCount = count
    previousResume = resume
    db.close()
    if (count === 15) {
      const done = openDb(homePaths(f.home).db)
      assert.equal(getMeta(done, 'cursor_ts'), `${NOW_SEC - 60}.000000`)
      done.close()
      finished = true
      break
    }
    assert.match(r.stdout, /partial=true/)
    assert.ok(count > 0)
  }
  assert.ok(finished)
})
test('PO17 ghの締め切り失敗後はIssueを作らない', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
  })
  const r = await f.poll(NOW, ['--deadline-ms', '200'], { FAKE_GH_SLEEP_MS: '5000', FAKE_GH_SLEEP_ON: 'api' })
  assert.ok(r.ms < 2000)
  assert.equal(f.read(id)?.state, 'creating')
  assert.match(f.read(id)?.lastError ?? '', /timeout|deadline/)
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 0)
})
test('PO20/PO21 生きた持ち主は見送り、古い印でも死んだ確認から待つ', async (t) => {
  const f = await fixture(t)
  const p = await startIdleProcess()
  t.after(() => p.stop())
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
    inflight: { owner: p.identity, child: null, at: '2026-11-11T23:00:00.000Z', deadConfirmedAt: null },
  })
  await f.poll()
  assert.equal(f.read(id)?.lastError, 'create in flight')
  assert.equal(f.read(id)?.attempts, 0)
  assert.equal(ghCalls(f.gh.log).length, 0)
  await p.stop()
  await f.poll('2026-11-12T00:00:10.000Z')
  assert.equal(f.read(id)?.lastError, 'create settling')
  assert.equal(ghCalls(f.gh.log).length, 0)
  seedIssues(f.gh.state, [
    {
      number: 42,
      html_url: 'https://github.com/acme/app/issues/42',
      body: `x\n<!-- slack-issue-intake:${CHANNEL}:${tsAt(1000)} -->`,
      created_at: NOW,
      user: { login: 'intake-bot' },
      labels: [{ name: 'from-slack' }],
    },
  ])
  await f.poll('2026-11-12T00:01:50.000Z')
  assert.equal(f.read(id)?.state, 'created')
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 0)
})
test('PO22 アカウント変更では照合も作成もしない', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
    createLogin: 'intake-bot',
  })
  await f.poll(NOW, [], { FAKE_GH_LOGIN: 'someone' })
  assert.equal(f.read(id)?.lastError, 'gh account changed')
  assert.equal(ghCalls(f.gh.log).length, 1)
  const status = JSON.parse(readFileSync(homePaths(f.home).pollStatus, 'utf8'))
  assert.equal(status.partial, true)
})
test('PO24 タイトルはメンション無効化後もGitHubの文字数上限内', async (t) => {
  const { parseSubmission } = await import('../lib/parse.ts')
  const parsed = parseSubmission(templateText({ title: '@alice '.repeat(100) }), null)
  assert.ok(parsed.kind === 'ok')
  const f = await fixture(t)
  await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    fields: parsed.fields,
    decision: content,
    createStartedAt: NOW,
  })
  await f.poll()
  const call = ghCalls(f.gh.log).find((c) => c.argv[0] === 'issue')
  assert.ok(call)
  const title = call.argv[call.argv.indexOf('--title') + 1] ?? ''
  assert.ok([...title].length <= 256, `chars=${[...title].length}`)
  assert.ok(!title.includes('@alice'))
})
test('PO25 必須リンクだけで本文上限を超える場合は送信せず失敗を記録', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    permalink: `https://acme.slack.com/${'x'.repeat(70000)}`,
    decision: content,
    createStartedAt: NOW,
  })
  await f.poll()
  assert.equal(f.read(id)?.state, 'creating')
  assert.match(f.read(id)?.lastError ?? '', /上限/)
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 0)
})
test('PO21b 死亡確認から90秒待ち、既存Issueが無ければ新しい印で1回だけ作る', async (t) => {
  const f = await fixture(t)
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'creating',
    decision: content,
    createStartedAt: NOW,
    inflight: { owner: { pid: 2147483647, start: 'dead' }, child: null, at: NOW, deadConfirmedAt: null },
  })
  await f.poll()
  assert.equal(f.read(id)?.lastError, 'create settling')
  await f.poll('2026-11-12T00:01:40.000Z')
  assert.equal(f.read(id)?.state, 'created')
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue').length, 1)
})
