import { escapeMrkdwn, overrideUrl, renderGlobal, renderRepo, splitMessages } from '../../lib/slack.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Section } from '../../lib/config.ts'
import type { DigestFile } from '../../lib/digest.ts'
import type { PendingEntry, PendingFile } from '../../lib/pending.ts'

const entry = (id: number, section: Section, overrides: Partial<PendingEntry> = {}): PendingEntry => ({
  id,
  revision: 1,
  section,
  sourceId: section,
  title: `title${id}`,
  url: `https://example.com/${id}`,
  summary: '',
  author: null,
  publishedAt: null,
  severity: null,
  products: [],
  updated: false,
  ...overrides,
})
const pendingOf = (items: PendingEntry[], overrides: Partial<PendingFile> = {}): PendingFile => ({
  runId: 1,
  generatedAt: '2026-11-09T00:00:00.000Z',
  previousIncomplete: null,
  items,
  globalIds: items.map((i) => i.id),
  repos: [],
  failures: [],
  ...overrides,
})
const digestOf = (overrides: Partial<DigestFile> = {}): DigestFile => ({
  runId: 1,
  notes: [],
  groups: [],
  repos: [],
  ...overrides,
})

test('SL1 splitMessages は行を割らず、続き番号を付ける', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line${i}-${'x'.repeat(60)}`)
  const messages = splitMessages(lines, 3500)
  assert.ok(messages.length > 1)
  for (const message of messages) assert.ok(message.length <= 3500)
  assert.ok(messages[1]?.startsWith(`（続き 2/${messages.length}）`))
  const rejoined = messages.map((m, i) => (i === 0 ? m : m.split('\n').slice(1).join('\n'))).join('\n')
  assert.equal(rejoined, lines.join('\n'))
})

test('SL1b 1 行が長すぎるときだけ … で切る', () => {
  const messages = splitMessages(['a', 'b'.repeat(5000), 'c'], 3500)
  for (const message of messages) assert.ok(message.length <= 3500)
  assert.ok(messages.some((m) => m.includes('…')))
  assert.deepEqual(splitMessages(['a', 'b'], 3500), ['a\nb'])
})

test('SL2 group は公式ソースのセクションに置かれ、X の言及が 1 行にまとまる', () => {
  const items = [
    entry(1, 'aws'),
    entry(2, 'x', { author: 'a' }),
    entry(3, 'x', { author: 'b' }),
    entry(4, 'x', { author: 'c' }),
  ]
  const digest = digestOf({ groups: [{ key: 'g', titleJa: 'まとめ', summaryJa: '概要', itemIds: [1, 2, 3, 4] }] })
  const text = renderGlobal(pendingOf(items), digest, '11/9').join('\n')
  assert.ok(text.includes('☀️ 11/9 開発速報（全体・4 件）'))
  assert.ok(text.indexOf('まとめ') > text.indexOf('☁️ AWS'))
  assert.ok(!text.includes('🤖 X'))
  assert.equal(text.match(/言及:/g)?.length, 1)
  assert.ok(text.includes('ほか 1 人'))
  assert.ok(!text.includes('title2'))
})

test('SL3 note の無い項目は要約なしで出る', () => {
  const items = [entry(1, 'aws'), entry(2, 'aws', { updated: true }), entry(3, 'jvn', { severity: 'high' })]
  const text = renderGlobal(pendingOf(items), digestOf({ notes: [{ id: 2, summaryJa: '要約', tags: [] }] }), '11/9', {
    jvnMin: 'high',
  }).join('\n')
  assert.ok(text.includes('title1（要約なし）'))
  assert.ok(text.includes('https://example.com/1'))
  assert.ok(text.includes('【追記】<https://example.com/2|title2>'))
  assert.ok(text.includes('JVN high 以上'))
  assert.ok(text.includes('CVSS high'))
})

test('SL4 escapeMrkdwn', () => {
  assert.equal(escapeMrkdwn('a<b>&c'), 'a&lt;b&gt;&amp;c')
})

test('SL5 前回未完了と failures を載せ、日付は設定のタイムゾーンで出す', () => {
  const pending = pendingOf([], {
    previousIncomplete: '2026-11-07T20:00:00.000Z',
    failures: [{ sourceId: 'devto', reason: 'timeout' }],
  })
  const lines = renderGlobal(pending, digestOf(), '11/9', { timeZone: 'Asia/Tokyo' })
  assert.equal(lines[0], '⚠️ 前回（11/8）の実行は完了しませんでした')
  assert.ok(lines.includes('⚠️ 取得できなかったソース: devto（timeout）'))
})

test('SL6 R4: globalIds の外のメンバーは全体に出ず、重複は 1 度だけ', () => {
  const items = [entry(1, 'aws'), entry(2, 'aws'), entry(3, 'x', { author: 'a' })]
  const pending = pendingOf(items, { globalIds: [1, 3, 3] })
  const digest = digestOf({
    groups: [
      { key: 'g', titleJa: 'G', summaryJa: 'S', itemIds: [1, 1, 2] },
      { key: 'h', titleJa: 'H', summaryJa: 'S', itemIds: [2] },
    ],
  })
  const text = renderGlobal(pending, digest, '11/9').join('\n')
  assert.ok(text.includes('全体・2 件'))
  assert.ok(!text.includes('title2'))
  assert.ok(!text.includes('• H'))
  assert.equal(text.match(/title1/g)?.length, 1)
})

test('SL7 renderRepo は選択 ∪ ownIds を出し、0 件は null', () => {
  const items = [entry(1, 'aws'), entry(2, 'aws'), entry(3, 'releases')]
  const pending = pendingOf(items, {
    globalIds: [1, 2],
    repos: [
      {
        slug: 'o/r',
        displayName: 'o/r',
        watch: { languages: [], packages: [], cloudServices: [], keywords: [] },
        candidateIds: [1, 2],
        ownIds: [3],
      },
    ],
  })
  const digest = digestOf({ repos: [{ slug: 'o/r', itemIds: [1, 1] }] })
  const lines = renderRepo(pending, digest, 'o/r', '11/9', false) ?? []
  assert.equal(lines[0], '📦 [o/r] 関連（2 件）')
  const text = lines.join('\n')
  assert.ok(text.includes('title1') && text.includes('title3') && !text.includes('title2'))
  assert.equal(renderRepo(pendingOf([]), digestOf(), 'none', '11/9', true), null)
})

test('SL8 URL に <!channel> や | があっても、メンション・偽リンクにならない', () => {
  const evil = 'https://evil.example/a|b<!channel>?x=<https://e|t>'
  const items = [entry(1, 'aws', { url: evil, title: 'T<!here>' }), entry(2, 'aws', { url: evil })]
  const text = renderGlobal(
    pendingOf(items),
    digestOf({ notes: [{ id: 2, summaryJa: '要約', tags: [] }] }),
    '11/9',
  ).join('\n')
  assert.ok(!text.includes('<!channel>') && !text.includes('<!here>'))
  // リンクの区切りの | は 1 リンクにつき 1 つだけ
  for (const line of text.split('\n').filter((l) => l.includes('<http'))) {
    assert.equal(line.replace(/ — .*/, '').match(/\|/g)?.length, 1)
  }
  assert.ok(!text.includes('<https://e|t>'))
})

test('SL9 http / https 以外の URL はリンクにしない', () => {
  const items = [
    entry(1, 'aws', { url: 'javascript:alert(1)' }),
    entry(2, 'aws', { url: 'not a url' }),
    entry(3, 'aws', { url: 'javascript:alert(2)' }),
  ]
  const digest = digestOf({ notes: [{ id: 3, summaryJa: '要約', tags: [] }] })
  const text = renderGlobal(pendingOf(items), digest, '11/9').join('\n')
  assert.ok(!text.includes('javascript:') && !text.includes('not a url'))
  assert.ok(text.includes('title1（要約なし）') && text.includes('title3'))
})

test('SL10 WEBHOOK_OVERRIDE はループバックのときだけ効く', () => {
  const url = 'https://hooks.slack.com/services/T0/B0/xyz'
  const saved = process.env.DEV_DIGEST_WEBHOOK_OVERRIDE
  try {
    process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = 'http://127.0.0.1:8123'
    assert.equal(overrideUrl(url), 'http://127.0.0.1:8123/services/T0/B0/xyz')
    process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = 'http://[::1]:8123'
    assert.equal(overrideUrl(url), 'http://[::1]:8123/services/T0/B0/xyz')
    process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = 'http://localhost:8123'
    assert.equal(overrideUrl(url), 'http://localhost:8123/services/T0/B0/xyz')
    process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = 'https://attacker.example'
    assert.equal(overrideUrl(url), url)
    process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = 'http://127.0.0.1.attacker.example'
    assert.equal(overrideUrl(url), url)
  } finally {
    if (saved === undefined) delete process.env.DEV_DIGEST_WEBHOOK_OVERRIDE
    else process.env.DEV_DIGEST_WEBHOOK_OVERRIDE = saved
  }
})
