import { categoryResolver, containsAny, isExcluded, normalizeUrl } from '../../lib/category.ts'
import { customFeed } from '../../lib/defaults.ts'
import { writeConfig } from '../helpers.ts'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dev-digest-category-'))
after(() => rmSync(home, { recursive: true, force: true }))

const K8S_FEED = 'https://kubernetes.io/feed.xml'
const config = writeConfig(home, {
  categories: [
    { id: 'ai', title: 'AI', feeds: [], keywords: ['LLM', '生成AI'] },
    { id: 'k8s', title: 'Kubernetes', feeds: [K8S_FEED], keywords: [] },
  ],
  excludeWords: ['beginner'],
  categoryExclude: { devto: ['tutorial'] },
})

test('CT1 normalizeUrl は host の大小・クエリ・# 以降・末尾の / の違いを同じにする', () => {
  const base = normalizeUrl('https://dev.to/a/post-1')
  assert.equal(normalizeUrl('https://DEV.to/a/post-1/'), base)
  assert.equal(normalizeUrl('https://dev.to/a/post-1?utm_source=rss#top'), base)
  assert.notEqual(normalizeUrl('https://dev.to/a/post-2'), base)
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com')
  assert.equal(normalizeUrl(' not a url '), 'not a url')
})

test('CT2 containsAny は大文字小文字を区別しない部分一致で、空の語は合わない', () => {
  assert.ok(containsAny('New LLM release', ['llm']))
  assert.ok(!containsAny('nothing here', ['llm', '']))
  assert.ok(!containsAny('anything', []))
})

test('CT3 カテゴリはキーワード → 追加カテゴリのフィード → 取得元のセクションの順で決まる', () => {
  const resolve = categoryResolver(config)
  const k8s = customFeed(K8S_FEED).storeAs
  assert.equal(resolve({ sourceId: 'aws-news-blog', section: 'aws', title: 'Bedrock の LLM', summary: '' }), 'ai')
  assert.equal(resolve({ sourceId: k8s, section: 'feed', title: 'Kubernetes v1.40', summary: '' }), 'k8s')
  // キーワードはフィードより先に効く
  assert.equal(resolve({ sourceId: k8s, section: 'feed', title: 'k8s で動かす生成AI', summary: '' }), 'ai')
  assert.equal(resolve({ sourceId: 'aws-news-blog', section: 'aws', title: 'S3 の更新', summary: '' }), 'aws')
})

test('CT4 除外ワードは共通とそのカテゴリのものだけが、タイトルか要約に効く', () => {
  assert.ok(isExcluded(config, { title: 'A Beginner guide', summary: '' }, 'aws'))
  assert.ok(isExcluded(config, { title: 'x', summary: 'step by step tutorial' }, 'devto'))
  assert.ok(!isExcluded(config, { title: 'x', summary: 'step by step tutorial' }, 'aws'))
})
