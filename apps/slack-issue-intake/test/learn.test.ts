import { BOT_ID, BOT_USER } from './fixtures/slack-messages.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Json, JsonObject } from '../lib/json.ts'
import type { SlackReply, SlackRequest } from './helpers.ts'

const REPORT_CHANNEL = 'C0REPORT01'
const LEARN_MARK = '🧠'
const ACK = '取り消しを受け付けました。次の確認で反映します'
const PUBLISH_ACK = '公開を受け付けました。次の確認で Issue を作ります'
const DRAFT_TITLE = 'Treat copy-only fixes as automatic'
const DRAFT_HINT =
  '公開してよければ、このスレッドに「公開 1」のように番号を返信してください。出さないなら「取り消し 1」と返信してください'
// Slack の chat.postMessage の text の推奨の上限
const SLACK_TEXT_MAX = 4000
const fixtureNotices = (): JsonObject =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/learn-notices.json'), 'utf8')) as JsonObject
const firstNotice = (): Json => (fixtureNotices().notices as Json[])[0] ?? null
const item = (n: number, kind: string, extra: JsonObject = {}): JsonObject => ({
  n,
  kind,
  ruleId: `r${n}`,
  direction: 'auto',
  text: `規則${n}`,
  evidence: [],
  url: '',
  ...extra,
})
const notice = (id: number, repo: string, items: JsonObject[]): JsonObject => ({
  id,
  repo,
  at: '2026-11-13T00:00:00Z',
  items,
})

const fixture = async (t: { after: (fn: () => Promise<void>) => void }, withSource = true) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const source = join(home, 'auto', 'report.json')
  const threads: Record<string, JsonObject[]> = {}
  // 消された投稿の ts
  const gone = new Set<string>()
  // failAcks: 失敗させる受け付けの返信の数。learnDelayMs: 学びの投稿の応答を遅らせる時間
  const control = { failAcks: 0, learnDelayMs: 0 }
  let count = 0
  const slack = await startSlack((r): SlackReply => {
    if (r.method === 'chat.postMessage' && r.params.thread_ts && control.failAcks > 0) {
      control.failAcks -= 1
      return { json: { ok: false, error: 'internal_error' } }
    }
    if (r.method === 'chat.postMessage')
      return {
        json: { ok: true, ts: `66.${++count}` },
        delayMs: (r.params.text ?? '').startsWith(LEARN_MARK) ? control.learnDelayMs : 0,
      }
    if (r.method === 'conversations.replies') {
      const ts = r.params.ts ?? ''
      if (gone.has(ts)) return { json: { ok: false, error: 'thread_not_found' } }
      const messages = threads[ts] ?? [{ ts }]
      return { json: { ok: true, messages, response_metadata: { next_cursor: '' } } }
    }
    return { json: { ok: true, messages: [] } }
  })
  t.after(() => slack.close())
  const env = {
    ...gh.env,
    TZ: 'UTC',
    ...(await setupHome(home, {
      apiBase: slack.url,
      ghPath: gh.ghPath,
      ghState: gh.state,
      repos: [{ name: 'acme/app', form: true, existing: 'skip' }],
      defaultRepo: 'acme/app',
      cursor: String(Date.parse('2026-11-13T08:50:00Z') / 1000),
      report: { channel: REPORT_CHANNEL, dailyAt: '09:00', source: withSource ? source : null },
    })),
  }
  // 報告の材料は正しいものを置き、errors の数が学びの分だけになるようにする
  mkdirSync(join(home, 'auto', 'learn'), { recursive: true })
  const report = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/auto-report.json'), 'utf8')) as JsonObject
  writeFileSync(source, JSON.stringify({ ...report, updatedAt: '2026-11-13T09:00:00Z' }))
  const noticesFile = join(home, 'auto', 'learn', 'notices.json')
  const cancelsFile = join(home, 'learn-cancels.json')
  const posts = () => slack.requests.filter((r) => r.method === 'chat.postMessage')
  return {
    home,
    threads,
    noticesFile,
    cancelsFile,
    writeNotices: (notices: Json[]) => writeFileSync(noticesFile, JSON.stringify({ version: 1, notices })),
    control,
    poll: (at: string, extra: string[] = []) => runCliAsync(['poll', '--now', `2026-11-13T${at}:00Z`, ...extra], env),
    learnPosts: () => posts().filter((r) => !r.params.thread_ts && (r.params.text ?? '').startsWith(LEARN_MARK)),
    threadPosts: () => posts().filter((r) => r.params.thread_ts),
    // 偽の Slack は chat.postMessage の順に 66.1, 66.2, … を返す
    gone,
    repliesOf: (ts: string) => slack.requests.filter((r) => r.method === 'conversations.replies' && r.params.ts === ts),
    tsOf: (request: SlackRequest): string => `66.${posts().indexOf(request) + 1}`,
    cancels: () => JSON.parse(readFileSync(cancelsFile, 'utf8')) as JsonObject,
  }
}
const reply = (ts: string, text: string, user = 'UHUMAN001'): JsonObject => ({ ts, text, user })
const parent = (ts: string): JsonObject => ({ ts, text: `${LEARN_MARK} parent`, user: BOT_USER, bot_id: BOT_ID })

test('LE1 まだ投稿していない学びの知らせを定期報告のチャンネルへ投稿し、次の poll では投稿し直さない。ほかのホームのリポジトリの知らせは出さない', async (t) => {
  const f = await fixture(t)
  f.writeNotices([
    firstNotice(),
    notice(2, 'other/web', [item(1, 'new')]),
    notice(3, 'acme/app', [item(1, 'support', { evidence: ['acme/app#9@1'] })]),
    notice(4, 'acme/app', [item(1, 'withdrawn')]),
    notice(5, 'acme/app', [item(1, 'graduated')]),
    notice(6, 'ACME/App', [item(1, 'global-issue', { url: 'https://github.com/acme/app/issues/9' })]),
    notice(7, 'acme/app', [item(1, 'global-pr', { url: 'https://github.com/acme/app/pull/10' })]),
    notice(8, 'acme/app', [item(1, 'global-hint')]),
  ])
  const first = await f.poll('09:05')
  assert.match(first.stdout, /errors=0 .*learn=5\/0/, first.stderr)
  const texts = f.learnPosts().map((r) => r.params.text ?? '')
  assert.equal(texts.length, 5)
  assert.equal(
    texts[0],
    [
      '🧠 判定の学び（acme/app）',
      '1. 文言だけの修正（今後は自動で進めます。最初の 3 件は人が確認します）',
      '   根拠: #1 #2',
      '2. 認証まわりの変更（今後はエンジニアに回します）',
      '   根拠: #3 #4',
      '取り消すときは、このスレッドに「取り消し 1」のように番号を返信してください',
    ].join('\n'),
  )
  assert.equal(
    texts[1],
    [
      '🧠 判定の学び（acme/app）',
      '1. 規則1（根拠が増えました）',
      '   根拠: #9',
      '取り消すときは、このスレッドに「取り消し 1」のように番号を返信してください',
    ].join('\n'),
  )
  assert.equal(texts[2], '🧠 判定の学び（acme/app）\n1. 規則1（取り下げました）')
  assert.equal(texts[3], '🧠 判定の学び（acme/app）\n1. 規則1（様子見を終えました）')
  assert.equal(
    texts[4],
    '🧠 判定の学び（acme/app）\n1. 規則1（全体の改善として Issue を作りました https://github.com/acme/app/issues/9）',
  )
  assert.ok(f.learnPosts().every((r) => r.params.channel === REPORT_CHANNEL && r.params.mrkdwn === 'false'))
  assert.ok(texts.every((s) => !s.includes('other/web')))
  const second = await f.poll('09:10')
  assert.match(second.stdout, /learn=2\/0/, second.stderr)
  assert.deepEqual(
    f
      .learnPosts()
      .slice(5)
      .map((r) => r.params.text),
    [
      '🧠 判定の学び（acme/app）\n1. 規則1（改善の PR ができました https://github.com/acme/app/pull/10）',
      '🧠 判定の学び（acme/app）\n1. 規則1（全体に効きそうな学びです）',
    ],
  )
  const third = await f.poll('09:15')
  assert.match(third.stdout, /learn=0\/0/, third.stderr)
  assert.equal(f.learnPosts().length, 7)
})

test('LE2 スレッドの「取り消し 1」で learn-cancels.json に依頼を 1 回だけ書き、受け付けの返信をする。番号の無い項目・関係ない返信は無視する', async (t) => {
  const f = await fixture(t)
  f.writeNotices([firstNotice(), notice(2, 'acme/app', [item(1, 'withdrawn')])])
  await f.poll('09:05')
  assert.equal(f.learnPosts().length, 2)
  const [ts1 = '', ts2 = ''] = f.learnPosts().map(f.tsOf)
  f.threads[ts1] = [
    parent(ts1),
    reply('70.1', '取り消し 1'),
    reply('70.2', ' 取り消し　１ '),
    reply('70.3', '取り消し 3'),
    reply('70.4', 'ありがとう'),
    { ts: '70.5', text: '取り消し 2', user: BOT_USER, bot_id: BOT_ID },
  ]
  f.threads[ts2] = [parent(ts2), reply('71.1', '取り消し 1')]
  const second = await f.poll('09:10')
  assert.match(second.stdout, /errors=0 .*learn=0\/1/, second.stderr)
  assert.deepEqual(f.cancels(), {
    version: 1,
    cancels: [{ noticeId: 1, n: 1, ruleId: 'r1', at: '2026-11-13T09:10:00.000Z', action: 'cancel' }],
  })
  assert.deepEqual(
    f.threadPosts().map((r) => [r.params.channel, r.params.thread_ts, r.params.text]),
    [[REPORT_CHANNEL, ts1, ACK]],
  )
  f.threads[ts1]?.push(reply('70.6', '取り消し 2'), reply('70.7', '取り消し 1'))
  const third = await f.poll('09:15')
  assert.match(third.stdout, /learn=0\/1/, third.stderr)
  assert.deepEqual(
    (f.cancels().cancels as JsonObject[]).map((c) => [c.noticeId, c.n, c.ruleId]),
    [
      [1, 1, 'r1'],
      [1, 2, 'r2'],
    ],
  )
  assert.equal(f.threadPosts().length, 2)
  const fourth = await f.poll('09:20')
  assert.match(fourth.stdout, /learn=0\/0/, fourth.stderr)
  assert.equal(f.threadPosts().length, 2)
  // 消された投稿のスレッドは諦め、次の回から読まない（errors に出し続けない）
  f.gone.add(ts2)
  assert.match((await f.poll('09:25')).stdout, /errors=0 .*learn=0\/0/)
  const read = f.repliesOf(ts2).length
  assert.match((await f.poll('09:30')).stdout, /errors=0 .*learn=0\/0/)
  assert.equal(f.repliesOf(ts2).length, read)
  assert.ok(f.repliesOf(ts1).length > 4)
})

test('LE3 規則の文と根拠は Slack の記法を無効にして出す（<!channel> や *太字* がそのまま効かない）', async (t) => {
  const f = await fixture(t)
  f.writeNotices([
    notice(1, 'acme/app', [
      item(1, 'new', { text: '<!channel> *太字* & <@U1>', evidence: ['<!here>', 'acme/app#5@2', 'x y'] }),
      item(2, 'global-issue', { url: 'https://evil.example/x' }),
      item(3, 'global-pr', { url: 'https://github.com/acme/app/pull/3 <!channel>' }),
    ]),
  ])
  const r = await f.poll('09:05')
  assert.match(r.stdout, /learn=1\/0/, r.stderr)
  const post = f.learnPosts()[0]
  const text = post?.params.text ?? ''
  assert.equal(post?.params.mrkdwn, 'false')
  assert.ok(text.includes('1. &lt;!channel&gt; *太字* &amp; &lt;@U1&gt;（'), text)
  assert.ok(text.includes('   根拠: &lt;!here&gt; #5 x y'), text)
  assert.ok(text.includes('2. 規則2（全体の改善として Issue を作りました）'), text)
  assert.ok(text.includes('https://github.com/acme/app/pull/3 &lt;!channel&gt;'), text)
  assert.ok(!text.includes('evil.example'), text)
  assert.ok(!/<[!@]/.test(text), text)
})

test('LE4 report.source が無い・notices.json が無いときは何もしない。壊れた notices.json は errors に 1 行', async (t) => {
  const off = await fixture(t, false)
  off.writeNotices([firstNotice()])
  const a = await off.poll('09:05')
  assert.match(a.stdout, /errors=0 .*report=off learn=0\/0/, a.stderr)
  assert.equal(off.learnPosts().length, 0)

  const f = await fixture(t)
  const b = await f.poll('09:05')
  assert.match(b.stdout, /errors=0 .*learn=0\/0/, b.stderr)
  assert.equal(f.learnPosts().length, 0)
  for (const broken of ['{', JSON.stringify({ version: 1, notices: [{ id: 'x' }] })]) {
    writeFileSync(f.noticesFile, broken)
    const c = await f.poll('09:10')
    assert.match(c.stdout, /errors=1 .*learn=0\/0/, c.stderr)
    assert.match(c.stderr, /学びの知らせを読めません/)
  }
  assert.equal(f.learnPosts().length, 0)
  assert.equal(existsSync(f.cancelsFile), false)
})

test('LE5 受け付けの返信に失敗したら、その返信を次の poll で読み直して受け付けを返す。依頼は 1 回だけ', async (t) => {
  const f = await fixture(t)
  f.writeNotices([firstNotice()])
  await f.poll('09:05')
  const [ts1 = ''] = f.learnPosts().map(f.tsOf)
  f.threads[ts1] = [parent(ts1), reply('70.1', '取り消し 1'), reply('70.2', '取り消し 2')]
  f.control.failAcks = 1
  const second = await f.poll('09:10')
  assert.match(second.stdout, /errors=1 .*learn=0\/1/, second.stderr)
  assert.match(second.stderr, /internal_error/)
  // 失敗した返信の手前で止めるので、同じスレッドの後ろの返信はまだ読まない
  assert.equal((f.cancels().cancels as JsonObject[]).length, 1)
  const third = await f.poll('09:15')
  assert.match(third.stdout, /errors=0 .*learn=0\/1/, third.stderr)
  assert.deepEqual(
    (f.cancels().cancels as JsonObject[]).map((c) => [c.noticeId, c.n, c.ruleId]),
    [
      [1, 1, 'r1'],
      [1, 2, 'r2'],
    ],
  )
  // 失敗 1 回のあと、項目 1 と 2 に 1 回ずつ
  assert.deepEqual(
    f.threadPosts().map((r) => r.params.text),
    [ACK, ACK, ACK],
  )
  f.threads[ts1]?.push(reply('70.3', '取り消し 1'))
  const fourth = await f.poll('09:20')
  assert.match(fourth.stdout, /errors=0 .*learn=0\/0/, fourth.stderr)
  assert.equal(f.threadPosts().length, 3)
})

test('LE6 残りが取り込みの分を切ったら学びの投稿とスレッドの読み取りを errors に出さずにやめる。古い知らせのスレッドは読まない', async (t) => {
  const f = await fixture(t)
  f.writeNotices([
    notice(1, 'acme/app', [item(1, 'new')]),
    notice(2, 'acme/app', [item(1, 'new')]),
    { ...notice(3, 'acme/app', [item(1, 'new')]), at: '2026-10-01T00:00:00Z' },
  ])
  f.control.learnDelayMs = 2500
  // 予算 14 秒: 1 件目の投稿のあとは 10 秒以上残り、2 件目のあとは残らない
  const first = await f.poll('09:05', ['--deadline-ms', '14000'])
  assert.match(first.stdout, /errors=0 partial=false .*learn=2\/0/, first.stderr)
  assert.equal(f.learnPosts().length, 2)
  assert.equal(f.repliesOf('66.2').length + f.repliesOf('66.3').length, 0)
  f.control.learnDelayMs = 0
  const second = await f.poll('09:10')
  assert.match(second.stdout, /errors=0 .*learn=1\/0/, second.stderr)
  const [ts1 = '', ts2 = '', ts3 = ''] = f.learnPosts().map(f.tsOf)
  assert.ok(f.repliesOf(ts1).length > 0)
  assert.ok(f.repliesOf(ts2).length > 0)
  // 3 番目の知らせは at が 14 日より前なので、取り消しを読まない
  assert.equal(f.repliesOf(ts3).length, 0)
})

test('LE7 global-draft の知らせは題と本文と公開の案内を出し、「公開 1」で action publish の依頼を 1 回だけ書いて受け付けを返す', async (t) => {
  const f = await fixture(t)
  f.writeNotices([
    notice(1, 'acme/app', [
      item(1, 'global-draft', { text: DRAFT_TITLE, body: 'First <!channel> & *more*.\n2. Second line.\u001b' }),
    ]),
  ])
  const first = await f.poll('09:05')
  assert.match(first.stdout, /errors=0 .*learn=1\/0/, first.stderr)
  const post = f.learnPosts()[0]
  assert.equal(post?.params.mrkdwn, 'false')
  // 本文は 1 行ずつ固定の印を付けて出す（本文の行が知らせの行に見えないように）
  assert.equal(
    post?.params.text,
    [
      '🧠 判定の学び（acme/app）',
      `1. ${DRAFT_TITLE}（公開の前の下書きです）`,
      '   │ First &lt;!channel&gt; &amp; *more*.',
      '   │ 2. Second line. ',
      DRAFT_HINT,
    ].join('\n'),
  )
  const [ts = ''] = f.learnPosts().map(f.tsOf)
  f.threads[ts] = [parent(ts), reply('70.1', '公開 1'), reply('70.2', ' 公開　１ '), reply('70.3', '公開 2')]
  const second = await f.poll('09:10')
  assert.match(second.stdout, /errors=0 .*learn=0\/1/, second.stderr)
  assert.deepEqual(f.cancels(), {
    version: 1,
    cancels: [{ noticeId: 1, n: 1, ruleId: 'r1', at: '2026-11-13T09:10:00.000Z', action: 'publish' }],
  })
  assert.deepEqual(
    f.threadPosts().map((r) => [r.params.thread_ts, r.params.text]),
    [[ts, PUBLISH_ACK]],
  )
  // 同じ項目への取り消しは別の依頼として書き、受け付けも別に返す
  f.threads[ts]?.push(reply('70.4', '取り消し 1'), reply('70.5', '公開 1'), reply('70.6', '取り消し 1'))
  const third = await f.poll('09:15')
  assert.match(third.stdout, /errors=0 .*learn=0\/1/, third.stderr)
  assert.deepEqual(
    (f.cancels().cancels as JsonObject[]).map((c) => [c.noticeId, c.n, c.action]),
    [
      [1, 1, 'publish'],
      [1, 1, 'cancel'],
    ],
  )
  assert.deepEqual(
    f.threadPosts().map((r) => r.params.text),
    [PUBLISH_ACK, ACK],
  )
  const fourth = await f.poll('09:20')
  assert.match(fourth.stdout, /errors=0 .*learn=0\/0/, fourth.stderr)
  assert.equal(f.threadPosts().length, 2)
})

test('LE8 global-draft でない項目への「公開 1」は無視し、global-draft への「取り消し 1」は action cancel の依頼を書く。本文を省いた下書きは Slack から公開できない', async (t) => {
  const f = await fixture(t)
  const long = `${'&<'.repeat(700)}\n${'x'.repeat(1500)}TAIL`
  f.writeNotices([
    firstNotice(),
    notice(2, 'acme/app', [item(1, 'global-draft', { text: DRAFT_TITLE, body: 'Body.' })]),
    notice(3, 'acme/app', [item(1, 'global-draft', { text: DRAFT_TITLE, body: long })]),
    notice(4, 'acme/app', [item(1, 'global-draft', { text: DRAFT_TITLE, body: 'Token xoxb-123-abc here.' })]),
  ])
  const first = await f.poll('09:05')
  assert.match(first.stdout, /errors=0 .*learn=4\/0/, first.stderr)
  const texts = f.learnPosts().map((r) => r.params.text ?? '')
  assert.ok(texts[1]?.endsWith(DRAFT_HINT), texts[1])
  // 長い本文は Slack の上限の内に省き、省いたことを見せる。実体参照の途中では切らない。公開の案内は出さない
  const shown = texts[2] ?? ''
  assert.ok(shown.length <= SLACK_TEXT_MAX, String(shown.length))
  assert.ok(shown.includes('（省略）'), shown)
  assert.ok(!shown.includes('TAIL'))
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(shown), shown)
  assert.ok(!shown.includes(DRAFT_HINT))
  assert.ok(shown.endsWith('出さないなら「取り消し 1」と返信してください'), shown)
  assert.ok(shown.includes('learn-publish'), shown)
  // 秘密の形の文字列を伏せた下書きも、出した文と公開する文が違うので Slack からは公開させない
  const masked = texts[3] ?? ''
  assert.ok(!masked.includes('xoxb-123-abc'), masked)
  assert.ok(!masked.includes(DRAFT_HINT), masked)
  assert.ok(masked.endsWith('出さないなら「取り消し 1」と返信してください'), masked)
  const [ts1 = '', ts2 = '', ts3 = '', ts4 = ''] = f.learnPosts().map(f.tsOf)
  f.threads[ts4] = [parent(ts4), reply('73.1', '公開 1')]
  f.threads[ts1] = [parent(ts1), reply('70.1', '公開 1')]
  f.threads[ts2] = [parent(ts2), reply('71.1', '取り消し 1')]
  f.threads[ts3] = [parent(ts3), reply('72.1', '公開 1'), reply('72.2', '取り消し 1')]
  const second = await f.poll('09:10')
  assert.match(second.stdout, /errors=0 .*learn=0\/2/, second.stderr)
  // スレッドは新しい知らせから読む
  assert.deepEqual(
    (f.cancels().cancels as JsonObject[]).map((c) => [c.noticeId, c.n, c.ruleId, c.action]),
    [
      [3, 1, 'r1', 'cancel'],
      [2, 1, 'r1', 'cancel'],
    ],
  )
  assert.deepEqual(
    f.threadPosts().map((r) => [r.params.thread_ts, r.params.text]),
    [
      [ts3, ACK],
      [ts2, ACK],
    ],
  )
})
