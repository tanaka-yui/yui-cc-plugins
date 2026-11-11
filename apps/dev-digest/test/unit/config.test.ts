import {
  buildSources,
  type Config,
  categoryIds,
  loadRepos,
  parseConfig,
  type RepoConfig,
  removeRepo,
  saveRepo,
  type WatchPackage,
} from '../../lib/config.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dev-digest-config-')))
after(() => rmSync(dir, { recursive: true, force: true }))

const baseConfig: Config = {
  version: 1,
  schedule: { trigger: 'daily', time: '08:00', timezone: 'Asia/Tokyo' },
  jvnMinSeverity: 'high',
  jvnKeywords: ['FortiOS'],
  devtoTags: ['aws'],
  x: { listUrl: null, hashtags: ['#AI'] },
  orca: { workspaceSelector: null, automationId: null },
  pluginRoot: '/plugin',
  disabledSections: [],
  categories: [],
  excludeWords: [],
  categoryExclude: {},
}

const watchOf = (packages: WatchPackage[]): RepoConfig['watch'] => ({
  languages: [],
  packages,
  cloudServices: [],
  keywords: [],
})

const repo = (slug: string, overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  slug,
  displayName: slug,
  path: `/work/${slug}`,
  addedAt: '2026-11-09T00:00:00Z',
  jvnMinSeverity: null,
  devtoTags: [],
  watch: watchOf([]),
  ...overrides,
})

test('CF1 parseConfig は既知の形を通し、jvnMinSeverity の誤りを説明する', () => {
  assert.deepEqual(parseConfig(baseConfig), baseConfig)
  const bad = parseConfig({ ...baseConfig, jvnMinSeverity: 'urgent' })
  assert.equal(typeof bad, 'string')
  assert.ok(String(bad).includes('jvnMinSeverity'))
})

test('CF1b jvnKeywords が無い古い設定は空とみなし、配列でなければ説明する', () => {
  const { jvnKeywords: _omitted, ...legacy } = baseConfig
  assert.deepEqual(parseConfig(legacy), { ...baseConfig, jvnKeywords: [] })
  const bad = parseConfig({ ...baseConfig, jvnKeywords: 'FortiOS' })
  assert.equal(typeof bad, 'string')
  assert.ok(String(bad).includes('jvnKeywords'))
})

test('CF1c カテゴリの欄は無ければ空とみなし、組み込みと重なる id や知らない組み込み名を拒む', () => {
  const { disabledSections: _d, categories: _c, excludeWords: _e, categoryExclude: _x, ...legacy } = baseConfig
  assert.deepEqual(parseConfig(legacy), baseConfig)
  const custom = { id: 'k8s', title: 'Kubernetes', feeds: ['https://kubernetes.io/feed.xml'], keywords: [] }
  const full = { ...baseConfig, disabledSections: ['gcp'], categories: [custom], excludeWords: ['ad'] }
  assert.deepEqual(parseConfig({ ...full, categoryExclude: { k8s: ['old'] } }), {
    ...full,
    categoryExclude: { k8s: ['old'] },
  })
  assert.ok(String(parseConfig({ ...baseConfig, categories: [{ ...custom, id: 'aws' }] })).includes('categories'))
  assert.ok(String(parseConfig({ ...baseConfig, disabledSections: ['releases'] })).includes('disabledSections'))
  assert.ok(String(parseConfig({ ...baseConfig, categoryExclude: { aws: 'x' } })).includes('categoryExclude'))
})

test('CF1d buildSources は止めたカテゴリのフィードを外し、追加カテゴリのフィードを足す。categoryIds はその順', () => {
  const feed = 'https://kubernetes.io/feed.xml'
  const config = {
    ...baseConfig,
    disabledSections: ['gcp' as const, 'devto' as const],
    categories: [{ id: 'k8s', title: 'Kubernetes', feeds: [feed], keywords: [] }],
  }
  const ids = buildSources(config, []).map((source) => source.id)
  assert.ok(!ids.some((id) => id.startsWith('gcp') || id.startsWith('devto')))
  assert.ok(ids.includes(`feed:${feed}`))
  assert.deepEqual(categoryIds(config), ['jvn', 'aws', 'x', 'k8s'])
})

test('CF2 saveRepo / loadRepos / removeRepo の往復', () => {
  const home = join(dir, 'cf2')
  saveRepo(home, repo('owner/repo'))
  assert.ok(existsSync(join(home, 'repos', 'owner__repo.json')))
  assert.equal(loadRepos(home).length, 1)
  assert.equal(removeRepo(home, 'owner/repo'), true)
  assert.equal(loadRepos(home).length, 0)
})

test('CF3 buildSources は同じ URL を 1 つにまとめる', () => {
  const watch = watchOf([{ name: 'kc', ecosystem: 'maven', github: 'keycloak/keycloak' }])
  const sources = buildSources(baseConfig, [repo('a/a', { watch }), repo('b/b', { watch })])
  const found = sources.filter((s) => s.id === 'releases:keycloak/keycloak')
  assert.equal(found.length, 1)
  assert.deepEqual(found[0]?.repoSlugs, ['a/a', 'b/b'])
})

test('CF4 全体タグと同じリポジトリタグは global のまま', () => {
  const sources = buildSources(baseConfig, [repo('a/a', { devtoTags: ['aws'] })])
  const found = sources.filter((s) => s.id === 'devto-tag:aws')
  assert.equal(found.length, 1)
  assert.equal(found[0]?.scope, 'global')
  assert.ok(found[0]?.repoSlugs.includes('a/a'))
})

test('CF5 github が null のパッケージは Releases を作らない', () => {
  const watch = watchOf([{ name: 'x', ecosystem: 'npm', github: null }])
  const sources = buildSources(baseConfig, [repo('a/a', { watch })])
  assert.equal(sources.filter((s) => s.section === 'releases').length, 0)
})
