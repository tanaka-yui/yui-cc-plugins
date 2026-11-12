import { loadConfig, saveConfig } from '../lib/config.ts'
import { getIssueStatus, openDb } from '../lib/db.ts'
import { STATUS_MAX_ATTEMPTS } from '../lib/defaults.ts'
import { homePaths } from '../lib/paths.ts'
import { NOW, templateText, textMessage, tsAt } from './fixtures/slack-messages.ts'
import {
  fakeGh,
  ghCalls,
  historyHandler,
  runCliAsync,
  seedIssues,
  seedSubmission,
  setupHome,
  startSlack,
  tempHome,
} from './helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

// orca-team-dispatch-task と共有するコメントの例
const EXAMPLES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/orca-auto-comments.json'), 'utf8')) as {
  event: string
  body: string
}[]
const body = (event: string): string => EXAMPLES.find((e) => e.event === event)?.body ?? assert.fail(event)
const REPO_URL = 'https://github.com/acme/app/issues/'
const GROUP = '<!subteam^S0DEV0001> '
const at = (minute: number): string => `2026-11-12T01:${String(minute).padStart(2, '0')}:00Z`
type Comment = { id: number; body: string; author_association: string; user: { login: string }; created_at: string }
const comment = (id: number, text: string, minute: number, association = 'MEMBER', login = 'orca-bot'): Comment => ({
  id,
  body: text,
  author_association: association,
  user: { login },
  created_at: at(minute),
})
const issue = (
  n: number,
  labels: string[],
  minute: number,
  o: { state?: 'open' | 'closed'; comments?: Comment[] } = {},
) => ({
  number: n,
  html_url: `${REPO_URL}${n}`,
  created_at: at(0),
  updated_at: at(minute),
  state: o.state ?? 'open',
  user: { login: 'intake-bot' },
  labels: ['from-slack', ...labels].map((name) => ({ name })),
  comments: o.comments ?? [],
})

const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  o: { issues?: number[]; post?: (r: SlackRequest) => SlackReply; messages?: ReturnType<typeof textMessage>[] } = {},
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const history = historyHandler(o.messages ?? [], 100)
  const server = await startSlack((r): SlackReply => {
    if (r.method === 'chat.postMessage') return o.post?.(r) ?? { json: { ok: true, ts: tsAt(1) } }
    if (r.method === 'conversations.replies') return { json: { ok: true, messages: [] } }
    return history(r)
  })
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const threads = new Map<number, string>()
  for (const [i, n] of (o.issues ?? [42]).entries()) {
    const ts = tsAt(5000 + i)
    threads.set(n, ts)
    await seedSubmission(home, { ts, state: 'created', issueNumber: n, issueUrl: `${REPO_URL}${n}` })
  }
  return {
    home,
    gh,
    threads,
    setIssues: (list: ReturnType<typeof issue>[]) => seedIssues(gh.state, list),
    poll: (extra: string[] = [], patch: Record<string, string> = {}) =>
      runCliAsync(['poll', '--now', NOW, ...extra], { ...env, ...patch }),
    posts: () =>
      server.requests
        .filter((r) => r.method === 'chat.postMessage')
        .map((r) => ({ text: r.params.text ?? '', thread: r.params.thread_ts ?? '' })),
    mention: (groupId: string | null) => {
      const c = loadConfig(home)
      assert.ok(c)
      saveConfig(home, { ...c, mention: { asked: true, groupId, handle: groupId ? 'dev-member' : null } })
    },
    row: (n: number) => {
      const db = openDb(homePaths(home).db)
      const r = getIssueStatus(db, n)
      db.close()
      return r
    },
  }
}

test('ST1 最初の回は記録だけで書き込まず、次の回で Backlog→Ready を人の変化としてメンション無しで書く', async (t) => {
  const f = await fixture(t)
  f.mention('S0DEV0001')
  f.setIssues([issue(42, [], 1)])
  const first = await f.poll()
  assert.equal(first.code, 1, first.stderr)
  assert.match(first.stdout, /result=idle .*notified=0/)
  assert.deepEqual(f.posts(), [])
  assert.equal(f.row(42)?.status, null)
  f.setIssues([issue(42, ['Ready'], 2)])
  const second = await f.poll()
  assert.match(second.stdout, /notified=1/)
  assert.deepEqual(f.posts(), [
    { text: `ステータスが （なし） から Ready に変わりました\n${REPO_URL}42`, thread: f.threads.get(42) },
  ])
  assert.equal(f.row(42)?.status, 'Ready')
})
test('ST2 judged のマーカー付きで Ready_Eng になれば、グループのメンションとコメント本文を書く。mention 未設定ならメンション無し', async (t) => {
  for (const group of ['S0DEV0001', null]) {
    const f = await fixture(t)
    f.mention(group)
    f.setIssues([issue(42, ['Ready'], 1)])
    await f.poll()
    f.setIssues([issue(42, ['Ready_Eng'], 3, { comments: [comment(10, body('judged'), 3)] })])
    await f.poll()
    const [post] = f.posts()
    assert.ok(post, String(group))
    assert.equal(post.text.startsWith(GROUP), group !== null)
    assert.ok(!group ? !post.text.includes('<!subteam^') : true)
    assert.match(post.text, /エンジニアの対応が必要と判断しました/)
    assert.match(post.text, /判定の理由: 対象リポジトリが 3 つあり/)
  }
})
test('ST3 ai-merged はメンションあり、human-merged はメンション無しで、どちらも完了を書く。Done 無しで閉じても完了を書く', async (t) => {
  const f = await fixture(t, { issues: [42, 43, 44] })
  f.mention('S0DEV0001')
  f.setIssues([issue(42, ['In review'], 1), issue(43, ['In review'], 1), issue(44, ['Ready'], 1)])
  await f.poll()
  f.setIssues([
    issue(42, ['Done'], 3, { state: 'closed', comments: [comment(10, body('ai-merged'), 3)] }),
    issue(43, ['Done'], 4, { state: 'closed', comments: [comment(11, body('human-merged'), 4)] }),
    issue(44, ['Ready'], 5, { state: 'closed' }),
  ])
  const r = await f.poll()
  assert.match(r.stdout, /notified=3/)
  const byThread = new Map(f.posts().map((p) => [p.thread, p.text]))
  const ai = byThread.get(f.threads.get(42) ?? '') ?? ''
  assert.ok(ai.startsWith(GROUP))
  assert.match(ai, /AI が修正を merge して完了にしました/)
  assert.match(ai, /<https:\/\/github.com\/acme\/app\/pull\/102\|acme\/app#102>/)
  const human = byThread.get(f.threads.get(43) ?? '') ?? ''
  assert.ok(!human.includes('<!subteam^'))
  assert.match(human, /PR が merge されたので完了にしました/)
  assert.equal(byThread.get(f.threads.get(44) ?? ''), `完了しました\n${REPO_URL}44`)
})
test('ST4 信じられない人のマーカーや、ラベルと合わないマーカーは、人の変化として扱う', async (t) => {
  const f = await fixture(t, { issues: [42, 43] })
  f.mention('S0DEV0001')
  f.setIssues([issue(42, ['Ready'], 1), issue(43, ['Ready'], 1)])
  await f.poll()
  f.setIssues([
    issue(42, ['Ready_Eng'], 3, { comments: [comment(10, body('judged'), 3, 'NONE', 'stranger')] }),
    issue(43, ['In review'], 4, { comments: [comment(11, body('ai-merged'), 4)] }),
  ])
  await f.poll()
  const texts = f.posts().map((p) => p.text)
  assert.deepEqual(texts, [
    `ステータスが Ready から Ready_Eng に変わりました\n${REPO_URL}42`,
    `ステータスが Ready から In review に変わりました\n${REPO_URL}43`,
  ])
})
test('ST5 ラベルが変わらず、新しい stalled のマーカーがあれば止まっていると書き、同じコメントで二度書かない', async (t) => {
  const f = await fixture(t)
  f.mention('S0DEV0001')
  f.setIssues([issue(42, ['In progress'], 1, { comments: [comment(10, body('started'), 1)] })])
  await f.poll()
  const stalled = [comment(10, body('started'), 1), comment(11, body('stalled'), 30)]
  f.setIssues([issue(42, ['In progress'], 30, { comments: stalled })])
  await f.poll()
  // 同じコメントのまま Issue だけ更新されても、二度は書かない
  f.setIssues([issue(42, ['In progress'], 31, { comments: stalled })])
  await f.poll()
  const posts = f.posts()
  assert.equal(posts.length, 1)
  assert.ok(posts[0]?.text.startsWith(GROUP))
  assert.match(posts[0]?.text ?? '', /AI の作業が進んでいません/)
  assert.match(posts[0]?.text ?? '', /経過時間: 45 分/)
  assert.equal(f.row(42)?.lastCommentId, 11)
})
test('ST6 thread_not_found なら記録を進めて次へ。ほかの失敗は STATUS_MAX_ATTEMPTS 回で諦める', async (t) => {
  const gone = await fixture(t, { post: () => ({ json: { ok: false, error: 'thread_not_found' } }) })
  gone.setIssues([issue(42, ['Ready'], 1)])
  await gone.poll()
  gone.setIssues([issue(42, ['Done'], 2)])
  await gone.poll()
  assert.equal(gone.row(42)?.status, 'Done')
  await gone.poll()
  assert.equal(gone.posts().length, 1)
  const broken = await fixture(t, { post: () => ({ json: { ok: false, error: 'msg_too_long' } }) })
  broken.setIssues([issue(42, ['Ready'], 1)])
  await broken.poll()
  broken.setIssues([issue(42, ['Done'], 2)])
  for (let i = 1; i <= STATUS_MAX_ATTEMPTS; i++) {
    const r = await broken.poll()
    assert.match(r.stdout, /partial=true/)
  }
  assert.equal(broken.row(42)?.status, 'Done')
  await broken.poll()
  assert.equal(broken.posts().length, STATUS_MAX_ATTEMPTS)
})
test('ST7 gh の失敗は partial になるが、終了コードは変えず、取り込みも進む', async (t) => {
  const idle = await fixture(t)
  idle.setIssues([issue(42, ['Ready'], 1)])
  const a = await idle.poll([], { FAKE_GH_API_FAIL_PATH: 'sort=updated' })
  assert.equal(a.code, 1, a.stderr)
  assert.match(a.stdout, /result=idle .*errors=1 partial=true notified=0/)
  const busy = await fixture(t, { messages: [textMessage(tsAt(100), templateText())] })
  busy.setIssues([issue(42, ['Ready'], 1)])
  const b = await busy.poll([], { FAKE_GH_API_FAIL_PATH: 'sort=updated' })
  assert.equal(b.code, 0, b.stderr)
  assert.match(b.stdout, /result=work agent_work=1 inserted=1 .*partial=true/)
})
test('ST8 締め切りで止まった回は status_cursor を処理済みの所までしか進めず、次の回で続きを知らせる', async (t) => {
  const f = await fixture(t, { issues: [42, 43] })
  f.setIssues([issue(42, ['Ready'], 1), issue(43, ['Ready'], 2)])
  await f.poll()
  f.setIssues([issue(42, ['In progress'], 3), issue(43, ['In progress'], 4)])
  const slow = await f.poll(['--deadline-ms', '13000'], {
    FAKE_GH_SLEEP_ON: 'api repos/acme/app/issues/43/comments',
    FAKE_GH_SLEEP_MS: '20000',
  })
  assert.match(slow.stdout, /notified=1/)
  assert.match(slow.stdout, /partial=true/)
  assert.deepEqual(
    f.posts().map((p) => p.thread),
    [f.threads.get(42)],
  )
  const next = await f.poll()
  assert.match(next.stdout, /notified=1/)
  assert.deepEqual(
    f.posts().map((p) => p.thread),
    [f.threads.get(42), f.threads.get(43)],
  )
})
test('ST9 残り時間が STATUS_MIN_REMAINING_MS より少なければ、ステータスの処理を呼ばない', async (t) => {
  const f = await fixture(t)
  f.setIssues([issue(42, ['Ready'], 1)])
  const r = await f.poll(['--deadline-ms', '5000'])
  assert.equal(r.code, 1, r.stderr)
  assert.ok(!ghCalls(f.gh.log).some((c) => c.argv.join(' ').includes('sort=updated')))
})
