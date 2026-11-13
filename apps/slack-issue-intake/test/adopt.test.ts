import { loadConfig, saveConfig } from '../lib/config.ts'
import { getMeta, openDb, setMeta } from '../lib/db.ts'
import { homePaths } from '../lib/paths.ts'
import { BOT_ID, BOT_USER, CHANNEL, NOW, textMessage, tsAt } from './fixtures/slack-messages.ts'
import { fakeGh, ghCalls, historyHandler, runCliAsync, seedIssues, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RepoSetting } from '../lib/config.ts'
import type { JsonObject } from '../lib/json.ts'

const AFTER = '2026-11-11T23:00:00.000Z'
const oldAt = (n: number): string => new Date(Date.parse('2026-11-10T00:00:00Z') + n * 120000).toISOString()
const issue = (n: number, labels: string[] = [], repo = 'acme/app', created = oldAt(n)): JsonObject => ({
  repo,
  number: n,
  title: `Issue <${n}>&`,
  html_url: `https://github.com/${repo}/issues/${n}`,
  created_at: created,
  updated_at: created,
  state: 'open',
  labels: labels.map((name) => ({ name })),
})
const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  repos: RepoSetting[] = [{ name: 'acme/app', form: true, existing: 'thread' }],
  after = true,
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const messages: JsonObject[] = []
  const history = historyHandler(messages, 100)
  let count = 0
  const server = await startSlack((r): import('./helpers.ts').SlackReply =>
    r.method === 'chat.postMessage'
      ? { json: { ok: true, ts: `99.${++count}` } }
      : r.method === 'conversations.replies'
        ? { json: { ok: true, messages: [] } }
        : history(r),
  )
  t.after(() => server.close())
  const env = {
    ...gh.env,
    ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state, repos })),
  }
  const db = () => openDb(homePaths(home).db)
  const meta = (key: string, value?: string) => {
    const d = db()
    if (value !== undefined) setMeta(d, key, value)
    const result = getMeta(d, key)
    d.close()
    return result
  }
  if (after) for (const repo of repos) meta(`adopt_after:${repo.name}`, AFTER)
  const rows = () => {
    const d = db()
    const rows = d.prepare('SELECT * FROM adopted ORDER BY repo,issue_number').all()
    d.close()
    return rows
  }
  const seed = (repo: string, n: number, ts: string | null = null, created = oldAt(n)) => {
    const d = db()
    d.prepare('INSERT INTO adopted(repo,issue_number,channel,ts,title,url,created_at) VALUES (?,?,?,?,?,?,?)').run(
      repo,
      n,
      CHANNEL,
      ts,
      `Issue ${n}`,
      `https://github.com/${repo}/issues/${n}`,
      created,
    )
    d.close()
  }
  return {
    home,
    gh,
    messages,
    db,
    meta,
    rows,
    seed,
    setIssues: (issues: JsonObject[]) => seedIssues(gh.state, issues),
    poll: (patch: Record<string, string> = {}) => runCliAsync(['poll', '--now', NOW], { ...env, ...patch }),
    posts: () => server.requests.filter((r) => r.method === 'chat.postMessage'),
    top: () => server.requests.filter((r) => r.method === 'chat.postMessage' && !r.params.thread_ts),
  }
}
test('AD1/AD5 新しい Issue を管理し、変更はそのスレッドへ通知、自分の投稿は取り込まない', async (t) => {
  const f = await fixture(t)
  f.setIssues([issue(1, [], 'acme/app', '2026-11-11T23:30:00Z')])
  const r = await f.poll()
  assert.match(r.stdout, /adopted=1/)
  const post = f.top()[0]
  assert.ok(post)
  assert.ok(post.params.text?.startsWith('📌 この Issue をスレッドで管理します: acme/app#1 '))
  assert.ok(post.params.text?.includes('&lt;1&gt;&amp;'))
  assert.equal(f.rows()[0]?.labeled, 1)
  f.messages.push(textMessage(tsAt(1000), post.params.text ?? '', { user: BOT_USER, bot_id: BOT_ID }))
  f.setIssues([{ ...issue(1, ['slack-thread', 'Ready']), updated_at: '2026-11-12T01:00:00Z' }])
  const next = await f.poll()
  assert.match(next.stdout, /inserted=0/)
  assert.match(f.posts()[1]?.params.text ?? '', /ステータスが （なし） から Ready に変わりました/)
  assert.equal(f.posts()[1]?.params.thread_ts, f.rows()[0]?.ts)
})
test('AD2 古い Issue はステータス付きだけを 5 件ずつ管理する', async (t) => {
  const f = await fixture(t)
  f.setIssues(Array.from({ length: 12 }, (_, i) => issue(i + 1, i < 7 ? ['Ready'] : [])))
  await f.poll()
  assert.equal(f.top().length, 5)
  await f.poll()
  assert.equal(f.top().length, 7)
  assert.equal(f.rows().length, 7)
})
test('AD3 skip と管理ラベル付きと PR は対象にしない', async (t) => {
  const f = await fixture(t, [{ name: 'acme/app', form: true, existing: 'skip' }])
  f.setIssues([issue(1, ['Ready'])])
  await f.poll()
  assert.ok(!ghCalls(f.gh.log).some((c) => c.argv.some((a) => a.includes('state=open'))))
  const c = loadConfig(f.home)
  assert.ok(c)
  saveConfig(f.home, { ...c, repos: [{ name: 'acme/app', form: true, existing: 'thread' }] })
  f.setIssues([
    issue(1, ['from-slack', 'Ready']),
    issue(2, ['slack-thread', 'Ready']),
    { ...issue(3, ['Ready']), pull_request: {} },
  ])
  await f.poll()
  assert.equal(f.top().length, 0)
})
test('AD4 ts の無い予定行を一覧の対象外でも完成させる', async (t) => {
  const f = await fixture(t)
  f.seed('acme/app', 1)
  f.setIssues([issue(1)])
  await f.poll()
  assert.equal(f.top().length, 1)
  assert.equal(f.rows()[0]?.labeled, 1)
})
test('AD6 ラベル失敗後に閉じても再投稿せず完成し、次の回に完了を知らせる', async (t) => {
  const f = await fixture(t)
  f.setIssues([issue(1, ['Ready'])])
  assert.match((await f.poll({ FAKE_GH_EDIT: 'fail' })).stdout, /partial=true/)
  assert.equal(f.rows()[0]?.labeled, 0)
  f.setIssues([{ ...issue(1, ['Ready']), state: 'closed', updated_at: '2026-11-12T01:00:00Z' }])
  await f.poll()
  assert.equal(f.top().length, 1)
  assert.equal(f.rows()[0]?.labeled, 1)
  await f.poll()
  assert.match(f.posts().at(-1)?.params.text ?? '', /完了しました/)
})
test('AD7 205件のページ境界とラベル更新で対象を取り落とさない', async (t) => {
  const f = await fixture(t)
  const targets = [1, 60, 101, 130, 160, 201]
  f.setIssues(Array.from({ length: 205 }, (_, i) => issue(i + 1, targets.includes(i + 1) ? ['Ready'] : [])))
  await f.poll()
  assert.equal(f.top().length, 4)
  await f.poll()
  assert.equal(f.top().length, 6)
  await f.poll()
  assert.deepEqual(
    f.rows().map((r) => r.issue_number),
    targets,
  )
})
test('AD8 閉じた予定行も残し、読めない間は再試行、再開後の変更も通知する', async (t) => {
  const f = await fixture(t)
  f.seed('acme/app', 1)
  f.messages.push(
    textMessage(tsAt(1000), '📌 この Issue をスレッドで管理します: acme/app#1', { user: BOT_USER, bot_id: BOT_ID }),
  )
  f.setIssues([{ ...issue(1), state: 'closed' }])
  assert.match((await f.poll({ FAKE_GH_API_FAIL_PATH: 'repos/acme/app/issues/1' })).stdout, /partial=true/)
  assert.equal(f.rows()[0]?.ts, null)
  assert.equal(f.top().length, 0)
  await f.poll()
  assert.equal(f.rows()[0]?.labeled, 1)
  assert.match(f.top()[0]?.params.text ?? '', /（閉じています）/)
  const d = f.db()
  assert.equal(d.prepare('SELECT state FROM issue_status2').get()?.state, 'closed')
  d.close()
  f.setIssues([{ ...issue(1, ['slack-thread']), updated_at: '2026-11-12T01:00:00Z' }])
  await f.poll()
  assert.match(f.posts().at(-1)?.params.text ?? '', /Issue が開き直されました/)
})
test('AD9 開始時刻が無ければ poll が保存し、その後の新しい Issue だけ取り込む', async (t) => {
  const f = await fixture(t, undefined, false)
  f.setIssues([issue(1), issue(2, [], 'acme/app', '2026-11-12T00:01:00Z')])
  await f.poll()
  assert.equal(f.meta('adopt_after:acme/app'), NOW)
  assert.deepEqual(
    f.rows().map((r) => r.issue_number),
    [2],
  )
})
test('AD10 ページ間の他者の更新による読み落としを作成順の見直しで拾う', async (t) => {
  const f = await fixture(t)
  f.setIssues(Array.from({ length: 201 }, (_, i) => issue(i + 1, i === 100 ? ['Ready'] : [])))
  await f.poll({ FAKE_GH_TOUCH: '2:1' })
  assert.equal(f.top().length, 0)
  assert.ok(Date.parse(f.meta('adopt_cursor:acme/app') ?? '') > Date.parse(NOW))
  await f.poll()
  assert.deepEqual(
    f.rows().map((r) => r.issue_number),
    [101],
  )
})
test('AD11 新しい対象が続いても見直しのための枠を残す', async (t) => {
  const f = await fixture(t)
  const list = Array.from({ length: 120 }, (_, i) => issue(i + 1, i === 109 ? ['Ready'] : []))
  f.meta('adopt_cursor:acme/app', NOW)
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++)
      list.push(
        issue(
          121 + round * 5 + i,
          [],
          'acme/app',
          new Date(Date.parse(NOW) + (round * 5 + i + 1) * 120000).toISOString(),
        ),
      )
    f.setIssues(list)
    const before = f.top().length
    await f.poll()
    assert.ok(f.top().length - before <= 5)
    if (round === 0) assert.equal(f.meta('adopt_sweep:acme/app'), '2')
    if (round === 1) assert.ok(f.rows().some((r) => r.issue_number === 110))
  }
})
test('AD12 複数リポジトリを交代して走査し、先頭だけで枠を使い続けない', async (t) => {
  const f = await fixture(
    t,
    ['acme/app', 'acme/web'].map((name) => ({ name, form: true, existing: 'thread' })),
  )
  const list = Array.from({ length: 200 }, (_, i) =>
    issue(i + 1, [], 'acme/app', new Date(Date.parse(AFTER) + (i + 1) * 120000).toISOString()),
  )
  list.push(...Array.from({ length: 10 }, (_, i) => issue(i + 1, i === 4 ? ['Ready'] : [], 'acme/web')))
  f.meta('adopt_cursor:acme/web', NOW)
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++)
      list.push(
        issue(
          201 + round * 5 + i,
          [],
          'acme/app',
          new Date(Date.parse(NOW) + (round * 5 + i + 300) * 120000).toISOString(),
        ),
      )
    f.setIssues(list)
    const before = f.top().length
    await f.poll()
    assert.ok(f.top().length - before <= 5)
    if (round < 2) assert.equal(f.meta('adopt_rotation'), round === 0 ? '1' : '0')
    if (round === 1) assert.ok(f.rows().some((r) => r.repo === 'acme/web' && r.issue_number === 5))
  }
})
test('AD13 ラベル失敗が続いても 5 回以下で止め、他の行に順番を回す', async (t) => {
  const f = await fixture(
    t,
    ['acme/app', 'acme/web'].map((name) => ({ name, form: true, existing: 'thread' })),
  )
  const list: JsonObject[] = []
  for (let i = 1; i <= 7; i++) {
    const repo = i === 7 ? 'acme/web' : 'acme/app'
    f.seed(repo, i, `7.${i}`, new Date(Date.parse(NOW) - (10 - i) * 60000).toISOString())
    list.push({ ...issue(i, [], repo), state: 'closed' })
  }
  f.setIssues(list)
  for (let round = 0; round < 2; round++) {
    const before = ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue' && c.argv[1] === 'edit').length
    await f.poll({ FAKE_GH_EDIT_FAIL_REPO: 'acme/app' })
    const after = ghCalls(f.gh.log).filter((c) => c.argv[0] === 'issue' && c.argv[1] === 'edit').length
    assert.ok(after - before <= 5)
  }
  assert.equal(f.rows().find((r) => r.repo === 'acme/web')?.labeled, 1)
  assert.ok(
    f
      .rows()
      .filter((r) => r.repo === 'acme/app')
      .every((r) => r.labeled === 0),
  )
})
