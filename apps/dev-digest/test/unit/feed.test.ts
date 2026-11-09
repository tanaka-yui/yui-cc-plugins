import { EXCERPT_CHARS } from '../../lib/defaults.ts'
import { contentHash, parseFeed } from '../../lib/feed.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { FeedItem } from '../../lib/feed.ts'

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

const sample: FeedItem = {
  guid: 'g',
  url: 'https://example.com/g',
  title: 'title',
  summary: 'summary',
  author: null,
  publishedAt: null,
  updatedAt: '2026-11-09T00:00:00.000Z',
  severity: null,
  products: [],
}

test('FD1 RSS 2.0: guid は <guid>、無ければ <link>。publishedAt は ISO 8601', () => {
  const items = parseFeed(fixture('aws-whats-new.xml'))
  assert.equal(items.length, 3)
  const first = items[0]
  assert.equal(first?.guid, '86b5725a099e9e140e215d5df331c144076d8067')
  assert.equal(first?.title, 'Kimi K3.1 Pro (Highspeed) now available on Amazon Bedrock')
  assert.equal(first?.publishedAt, '2026-11-06T22:47:00.000Z')
  assert.equal(first?.updatedAt, null)
  assert.equal(first?.severity, null)
  assert.ok(first?.url.startsWith('https://aws.amazon.com/'))

  const devto = parseFeed(fixture('devto.xml'))
  assert.equal(devto.length, 3)
  assert.equal(devto[0]?.guid, devto[0]?.url)
  assert.equal(devto[0]?.author, 'EmbedSBC')
  assert.equal(devto[0]?.title, 'LILYGO T-Dongle S3 Plus: ESP32-S3, 8MB PSRAM & Pinout Spec')

  const noGuid = parseFeed(
    '<rss><channel><item><title>t</title><link>https://example.com/a</link></item></channel></rss>',
  )
  assert.equal(noGuid[0]?.guid, 'https://example.com/a')
})

test('FD2 Atom: guid は <id>、url は alternate（rel 無しも alternate）、updatedAt は <updated>', () => {
  const items = parseFeed(fixture('releases.atom'))
  assert.equal(items.length, 3)
  assert.equal(items[0]?.guid, 'tag:github.com,2008:Repository/937253475/v2.1.319')
  assert.equal(items[0]?.url, 'https://github.com/anthropics/claude-code/releases/tag/v2.1.319')
  assert.equal(items[0]?.title, 'v2.1.319')
  assert.equal(items[0]?.updatedAt, '2026-11-06T17:04:01.000Z')
  assert.equal(items[0]?.author, 'claude-code-publisher[bot]')

  const gcp = parseFeed(fixture('gcp-release-notes.xml'))
  assert.equal(gcp.length, 3)
  assert.equal(gcp[0]?.title, 'November 08, 2026')
  assert.equal(gcp[0]?.guid, 'tag:google.com,2016:gcp-release-notes#November_08_2026')
  assert.equal(gcp[0]?.url, 'https://docs.cloud.google.com/release-notes#November_08_2026')
  assert.equal(gcp[0]?.updatedAt, '2026-11-08T08:00:00.000Z')
  assert.ok((gcp[0]?.summary.length ?? 0) > 0)

  const noRel = parseFeed(
    '<feed><entry><id>x</id><title>t</title><link href="https://example.com/n"/><updated>2026-01-01T00:00:00Z</updated></entry></feed>',
  )
  assert.equal(noRel[0]?.url, 'https://example.com/n')
})

test('FD3 RDF と JVN の深刻度', () => {
  const items = parseFeed(fixture('jvndb_new.rdf'))
  assert.equal(items.length, 3)
  const [critical, two, none] = items
  assert.equal(critical?.guid, 'https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-000163.html')
  assert.equal(critical?.url, critical?.guid)
  assert.equal(critical?.severity, 'critical')
  assert.deepEqual(critical?.products, ['WebSAM WinShare'])
  assert.equal(critical?.publishedAt, '2026-11-09T05:24:00.000Z')
  assert.equal(critical?.updatedAt, '2026-11-09T05:24:00.000Z')
  // v2 が Medium、v3 が High。高い方を採る
  assert.equal(two?.severity, 'high')
  assert.deepEqual(two?.products, ['Getscreen Agent'])
  assert.equal(none?.severity, null)
})

test('FD3b sec:cpe の product は重複を除き、複数持てる', () => {
  const xml = `<rdf:RDF><item rdf:about="https://example.com/a"><title>t</title><link>https://example.com/a</link>
<sec:cpe product="SS1">cpe:/a:x:ss1</sec:cpe><sec:cpe product="SS1クラウド">cpe:/a:x:c</sec:cpe>
<sec:cpe product="SS1">cpe:/a:x:ss1b</sec:cpe><sec:cpe product="rocoeyes">cpe:/a:x:r</sec:cpe></item></rdf:RDF>`
  assert.deepEqual(parseFeed(xml)[0]?.products, ['SS1', 'SS1クラウド', 'rocoeyes'])
})

test('FD4 summary はタグを除き実体を戻して EXCERPT_CHARS で切る', () => {
  const items = parseFeed(fixture('jvndb_new.rdf'))
  const summary = items[0]?.summary ?? ''
  assert.ok(!summary.includes('<'))
  assert.ok(!summary.includes('&lt;'))
  assert.ok(!summary.includes('&#13;'))
  assert.ok(!summary.includes('\r'))
  assert.ok(summary.includes('CVE-2026-113362'))
  assert.ok(items.every((item) => item.summary.length <= EXCERPT_CHARS))

  const long = `<rss><item><guid>1</guid><title>t</title><description>${'あ'.repeat(EXCERPT_CHARS * 2)}</description></item></rss>`
  assert.equal(parseFeed(long)[0]?.summary.length, EXCERPT_CHARS)

  const aws = parseFeed(fixture('aws-whats-new.xml'))
  assert.ok(aws.every((item) => !item.summary.includes('<') && item.summary.length <= EXCERPT_CHARS))
  // 段落の境目で語がくっつかない
  assert.ok(!/[a-z]\.[A-Z]/.test(aws[0]?.summary ?? ''))
})

test('FD5 CDATA と二重エスケープ', () => {
  const wrap = (body: string): string =>
    `<rss><channel><item><guid>1</guid><title>t</title><description>${body}</description></item></channel></rss>`
  assert.equal(parseFeed(wrap('<![CDATA[a < b &amp; c]]>'))[0]?.summary, 'a < b & c')
  const double = parseFeed(wrap('&amp;lt;b&amp;gt;'))[0]?.summary
  assert.equal(double, '<b>')
  assert.ok(!double?.includes('&lt;'))
  // 1 段のエスケープ（&lt;b&gt;）はタグとして除かれる
  assert.equal(parseFeed(wrap('x&lt;b&gt;y&lt;/b&gt;'))[0]?.summary, 'xy')
  // CDATA の中の HTML タグも除く
  assert.equal(parseFeed(wrap('<![CDATA[<p>hello <b>world</b></p>]]>'))[0]?.summary, 'hello world')
})

test('FD6 壊れた XML でも投げず、完全な項目だけを返す', () => {
  const items = parseFeed(fixture('broken.xml'))
  assert.deepEqual(
    items.map((item) => item.guid),
    ['b-1', 'b-3'],
  )
  assert.deepEqual(parseFeed(''), [])
  assert.deepEqual(parseFeed('not xml at all <item'), [])
})

test('FD7 contentHash は本文が変われば変わる', () => {
  assert.equal(contentHash(sample), contentHash({ ...sample }))
  assert.match(contentHash(sample), /^[0-9a-f]{64}$/)
  assert.notEqual(contentHash(sample), contentHash({ ...sample, summary: 'changed' }))
  assert.notEqual(contentHash(sample), contentHash({ ...sample, title: 'other' }))
  assert.notEqual(contentHash(sample), contentHash({ ...sample, updatedAt: '2026-11-10T00:00:00.000Z' }))
  assert.equal(contentHash(sample), contentHash({ ...sample, url: 'https://example.com/other' }))
})
