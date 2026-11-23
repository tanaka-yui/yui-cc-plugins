import {
  activeRules,
  appendNotice,
  type HistoryRow,
  LEARN_FILES,
  LEARN_HISTORY_MAX,
  LEARN_NOTICES_MAX,
  LEARN_TOPIC_MAX,
  learnDir,
  mismatchesOf,
  type NoticeItem,
  readHistory,
  readNotices,
  readStore,
  similarCases,
  topicProblem,
  writeHistory,
  writeStore,
} from '../../lib/auto-learn.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, mock, test } from 'node:test'

import type { Rule } from '../../lib/auto-learn.ts'

const NAME = 'learn-test'
const REPO = 'acme/app'
const OTHER_REPO = 'other/api'
const root = mkdtempSync(join(tmpdir(), 'auto-learn-'))
let sequence = 0
beforeEach(() => {
  sequence += 1
  process.env.ORCA_DISPATCH_CONFIG_HOME = join(root, `home-${sequence}`)
})
after(() => rmSync(root, { recursive: true, force: true }))

const row = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  key: `${REPO}#1`,
  repo: REPO,
  generation: 1,
  title: '題名',
  labels: [],
  aiRoute: 'auto',
  route: 'auto',
  forced: '',
  reason: '理由',
  autoReady: false,
  started: false,
  ruleIds: [],
  outcome: 'merged-ai',
  at: '2026-11-23T00:00:00Z',
  reflected: false,
  ...overrides,
})
const key = (number: number): string => `${REPO}#${number}`

test('LN1 履歴は無ければ空、書いて読み直せ、リポジトリごとに新しい 500 件に切る', () => {
  assert.deepEqual(readHistory(NAME), [])
  const rows = Array.from({ length: LEARN_HISTORY_MAX + 1 }, (_, index) =>
    row({ key: key(index), at: `2026-11-23T00:00:${String(index % 60).padStart(2, '0')}Z` }),
  )
  rows.splice(10, 0, row({ key: 'other/api#1', repo: OTHER_REPO }))
  writeHistory(NAME, rows)
  const read = readHistory(NAME)
  assert.equal(read.filter((item) => item.repo === REPO).length, LEARN_HISTORY_MAX)
  assert.equal(read.filter((item) => item.repo === OTHER_REPO).length, 1)
  assert.equal(
    read.some((item) => item.key === key(0)),
    false,
  )
  assert.equal(
    read.some((item) => item.key === key(LEARN_HISTORY_MAX)),
    true,
  )
  assert.deepEqual(read[0], rows[1])
})

test('LN1b 壊れた履歴・規則・知らせは読むときに日本語で投げる', () => {
  mkdirSync(learnDir(NAME), { recursive: true })
  const cases: Array<[string, () => unknown, string]> = [
    [LEARN_FILES.history, () => readHistory(NAME), '{"version":1,"rows":[{"key":1}]}'],
    [LEARN_FILES.rules, () => readStore(NAME), '{"version":1,"nextRule":"x","nextNotice":1,"rules":[]}'],
    [LEARN_FILES.notices, () => readNotices(NAME), '{"version":2,"notices":[]}'],
    [LEARN_FILES.history, () => readHistory(NAME), 'not json'],
  ]
  for (const [file, read, body] of cases) {
    writeFileSync(join(learnDir(NAME), file), body)
    assert.throws(read, /状態ファイルが壊れています/)
  }
})

test('LN1c 規則の保存と読み直し、有効な規則だけ取り出す', () => {
  assert.deepEqual(readStore(NAME), { rules: [], nextRule: 1, nextNotice: 1 })
  const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({
    id,
    repo: REPO,
    direction: 'auto',
    topic: '文言だけの修正',
    evidence: [key(1), key(2)],
    createdAt: '2026-11-23T00:00:00Z',
    probationLeft: 3,
    status: 'active',
    withdrawnWhy: '',
    global: null,
    ...overrides,
  })
  const store = {
    rules: [
      rule('R1'),
      rule('R2', { status: 'withdrawn', withdrawnWhy: '取り消し' }),
      rule('R3', { repo: OTHER_REPO }),
      rule('R4', { direction: 'eng', global: { issue: 'owner/repo#1', prNotified: false, draft: null } }),
    ],
    nextRule: 5,
    nextNotice: 2,
  }
  writeStore(NAME, store)
  assert.deepEqual(readStore(NAME), store)
  assert.deepEqual(
    activeRules(store, REPO).map((item) => item.id),
    ['R1', 'R4'],
  )
})

test('LN2 mismatchesOf は慎重すぎた・攻めすぎたを返し、強制・環境・振り返り済み・始まる前の人の変更を除く', () => {
  const rows = [
    // 返す: (a) 慎重すぎた
    row({ key: key(1), generation: 1, aiRoute: 'eng', route: 'eng', outcome: 'eng-returned', reason: '重そう' }),
    row({ key: key(1), generation: 2, outcome: 'merged-ai' }),
    // (b) (c) (d) 攻めすぎた
    row({ key: key(2), outcome: 'failed' }),
    row({ key: key(3), outcome: 'stopped', started: true }),
    row({ key: key(4), outcome: 'stopped', autoReady: true }),
    // 返さない
    row({ key: key(5), aiRoute: 'eng', route: 'eng', forced: '新機能', outcome: 'eng-returned' }),
    row({ key: key(5), generation: 2, outcome: 'merged-ai' }),
    row({ key: key(6), aiRoute: 'eng', route: 'eng', outcome: 'eng-returned' }),
    row({ key: key(6), generation: 2, aiRoute: 'eng', route: 'eng', outcome: 'failed' }),
    row({ key: key(7), outcome: 'failed-env' }),
    row({ key: key(8), outcome: 'stopped' }),
    row({ key: key(9), outcome: 'failed', reflected: true }),
    row({ key: key(10), aiRoute: 'eng', route: 'eng', outcome: 'eng-returned', reflected: true }),
    row({ key: key(10), generation: 2, outcome: 'merged-human' }),
    row({ key: key(11), aiRoute: 'eng', route: 'eng', outcome: 'eng-returned' }),
    row({ key: key(12), aiRoute: 'eng', route: 'eng', outcome: 'eng-kept' }),
    row({ key: 'other/api#1', repo: OTHER_REPO, outcome: 'failed' }),
  ]
  const found = mismatchesOf(rows, REPO)
  assert.deepEqual(
    found.map((item) => [item.id, item.kind]),
    [
      [`${key(1)}@1`, 'cautious'],
      [`${key(2)}@1`, 'aggressive'],
      [`${key(3)}@1`, 'aggressive'],
      [`${key(4)}@1`, 'aggressive'],
    ],
  )
  assert.equal(found[0]?.reason, '重そう')
  assert.equal(found[0]?.outcome, 'merged-ai')
  assert.equal(found[1]?.outcome, 'failed')
})

test('LN3 similarCases は語の重なりの多い順に 5 件までで、重なりの無い行と別のリポジトリの行を出さない', () => {
  const rows = [
    row({ title: '設定画面の文言', outcome: 'merged-ai' }),
    row({ title: 'ログイン画面のボタンの文言', outcome: 'failed', route: 'eng' }),
    row({ title: 'クラッシュを直す', labels: ['bug'] }),
    row({ title: 'DB migration' }),
    row({ title: 'ログイン画面の文言', repo: OTHER_REPO }),
  ]
  const found = similarCases(rows, REPO, 'ログイン画面の文言を直す', ['bug'])
  assert.deepEqual(
    found.map((item) => item.title),
    ['ログイン画面のボタンの文言', '設定画面の文言', 'クラッシュを直す'],
  )
  assert.deepEqual(found[0], { title: 'ログイン画面のボタンの文言', route: 'eng', outcome: 'failed' })
  // 件数の上限と、同じ重なりでは新しい順
  // 題名を 1 件ずつ変え（重なりはどれも「login」の 1 語）、入力は古い順に並べて、新しい順に返ることを確かめる
  const many = Array.from({ length: 8 }, (_, index) =>
    row({ title: `login ${String.fromCharCode(97 + index)}`, at: `2026-11-23T00:00:0${index}Z` }),
  )
  const limited = similarCases(many, REPO, 'login', [])
  assert.equal(limited.length, 5)
  assert.deepEqual(
    limited.map((item) => item.title),
    ['login h', 'login g', 'login f', 'login e', 'login d'],
  )
  assert.equal(similarCases(many, REPO, 'login', [], 2).length, 2)
  assert.deepEqual(
    similarCases(many, REPO, 'login', [], 8).map((item) => item.title),
    many.map((item) => item.title).toReversed(),
  )
})

test('LN4 topicProblem は空・81 文字・改行・バッククォート・URL を断り、80 文字の日本語を通す', () => {
  assert.notEqual(topicProblem(''), '')
  assert.notEqual(topicProblem('あ'.repeat(LEARN_TOPIC_MAX + 1)), '')
  assert.notEqual(topicProblem('一行目\n二行目'), '')
  assert.notEqual(topicProblem('`rm -rf`'), '')
  assert.notEqual(topicProblem('詳しくは http://example.com'), '')
  assert.notEqual(topicProblem('詳しくは HTTPS://example.com'), '')
  // 制御文字（タブ・BEL・NEL）と行・段落の区切り文字も、後の判定の材料に入るので断る
  for (const character of ['\t', '\u0007', '\u0085', '\u2028', '\u2029'])
    assert.notEqual(topicProblem(`前${character}後`), '', JSON.stringify(character))
  assert.equal(topicProblem('あ'.repeat(LEARN_TOPIC_MAX)), '')
  assert.equal(topicProblem('文言だけの修正'), '')
})

test('LN5 appendNotice は項目に 1 からの番号を振り、id を進め、新しい 50 件に切る', () => {
  const log = mock.method(console, 'log', () => {})
  try {
    const store = { rules: [], nextRule: 1, nextNotice: 1 }
    const item = (text: string): Omit<NoticeItem, 'n'> => ({
      kind: 'new',
      ruleId: 'R1',
      direction: 'auto',
      text,
      evidence: [key(1)],
      url: '',
      body: '',
    })
    const first = appendNotice(NAME, store, REPO, [item('一つ目'), item('二つ目')], '2026-11-23T00:00:00Z')
    assert.equal(first.id, 1)
    assert.deepEqual(
      first.items.map((entry) => entry.n),
      [1, 2],
    )
    assert.equal(store.nextNotice, 2)
    assert.equal(log.mock.calls.length, 2)
    assert.deepEqual(log.mock.calls[0]?.arguments, ['学び: acme/app [new] 一つ目'])
    assert.deepEqual(readNotices(NAME), [first])
    for (let index = 0; index < LEARN_NOTICES_MAX; index++)
      appendNotice(NAME, store, REPO, [item(`知らせ${index}`)], '2026-11-23T00:00:00Z')
    const notices = readNotices(NAME)
    assert.equal(notices.length, LEARN_NOTICES_MAX)
    assert.equal(notices[0]?.id, 2)
    assert.equal(notices.at(-1)?.id, LEARN_NOTICES_MAX + 1)
    assert.equal(store.nextNotice, LEARN_NOTICES_MAX + 2)
    assert.equal(JSON.parse(readFileSync(join(learnDir(NAME), LEARN_FILES.notices), 'utf8')).version, 1)
  } finally {
    log.mock.restore()
  }
})
