import {
  applyCancels,
  LEARN_CANCELS_FILE,
  LEARN_FILES,
  learnDir,
  readNotices,
  readStore,
  writeStore,
} from '../../lib/auto-learn.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import type { Rule } from '../../lib/auto-learn.ts'

const NAME = 'cancel-test'
const AT = '2026-11-23T02:00:00Z'
const REPO = 'acme/app'
const FIXTURES = new URL('../fixtures/', import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'auto-learn-cancel-'))
let sequence = 0
let home = ''
beforeEach(() => {
  sequence += 1
  process.env.ORCA_DISPATCH_CONFIG_HOME = join(root, `config-${sequence}`)
  home = join(root, `intake-${sequence}`)
  mkdirSync(home, { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({
  id,
  repo: REPO,
  direction: 'auto',
  topic: `文言だけの修正 ${id}`,
  evidence: [`${REPO}#1@1`, `${REPO}#2@1`],
  createdAt: AT,
  probationLeft: 3,
  status: 'active',
  withdrawnWhy: '',
  global: null,
  ...overrides,
})
const cancel = (ruleId: string) => ({ noticeId: 1, n: 1, ruleId, at: AT })
const writeCancels = (cancels: object[]): void =>
  writeFileSync(join(home, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels }))

test('LN18 applyCancels は有効な規則だけを取り下げて知らせを 1 回足し、同じ依頼を 2 回読んでも 2 回目は何もしない。壊れたファイルは 1 行出して続ける', () => {
  writeStore(NAME, {
    rules: [rule('r1'), rule('r2', { status: 'withdrawn', withdrawnWhy: '振り返りで取り下げ' }), rule('r3')],
    nextRule: 4,
    nextNotice: 1,
  })
  writeCancels([cancel('r1'), cancel('r2'), cancel('unknown')])
  const broken = join(root, `broken-${sequence}`)
  mkdirSync(broken)
  writeFileSync(join(broken, LEARN_CANCELS_FILE), '{')
  const lines: string[] = []

  const withdrawn = applyCancels(NAME, [broken, home, join(root, 'no-such-home')], AT, (line) => lines.push(line))

  assert.equal(withdrawn, 1)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]?.includes(join(broken, LEARN_CANCELS_FILE)))
  const store = readStore(NAME)
  assert.deepEqual(
    store.rules.map((entry) => [entry.id, entry.status, entry.withdrawnWhy]),
    [
      ['r1', 'withdrawn', 'Slack で取り消し'],
      ['r2', 'withdrawn', '振り返りで取り下げ'],
      ['r3', 'active', ''],
    ],
  )
  assert.equal(store.nextNotice, 2)
  const notices = readNotices(NAME)
  assert.equal(notices.length, 1)
  assert.deepEqual(
    notices[0]?.items.map((item) => [item.kind, item.ruleId, item.text]),
    [['withdrawn', 'r1', '文言だけの修正 r1']],
  )
  assert.equal(notices[0]?.repo, REPO)

  assert.equal(
    applyCancels(NAME, [home], AT, (line) => lines.push(line)),
    0,
  )
  assert.equal(readNotices(NAME).length, 1)
  assert.equal(readStore(NAME).nextNotice, 2)
  assert.equal(lines.length, 1)
})

test('LN18b 形の違う依頼のファイルは読めないものとして 1 行出し、何も取り下げない', () => {
  writeStore(NAME, { rules: [rule('r1')], nextRule: 2, nextNotice: 1 })
  writeFileSync(join(home, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels: [{ ruleId: 'r1' }] }))
  const lines: string[] = []
  assert.equal(
    applyCancels(NAME, [home], AT, (line) => lines.push(line)),
    0,
  )
  assert.equal(lines.length, 1)
  assert.equal(readStore(NAME).rules[0]?.status, 'active')
})

test('LN19 fixture の learn-notices.json は readNotices で読め、learn-cancels.json は applyCancels が読める', () => {
  mkdirSync(learnDir(NAME), { recursive: true })
  cpSync(new URL('learn-notices.json', FIXTURES), join(learnDir(NAME), LEARN_FILES.notices))
  const notices = readNotices(NAME)
  assert.equal(notices.length, 1)
  assert.deepEqual(
    notices[0]?.items.map((item) => item.ruleId),
    ['r1', 'r2'],
  )

  cpSync(new URL('learn-cancels.json', FIXTURES), join(home, LEARN_CANCELS_FILE))
  const fixtureCancels = JSON.parse(readFileSync(join(home, LEARN_CANCELS_FILE), 'utf8'))
  writeStore(NAME, { rules: [rule('r1'), rule('r2')], nextRule: 3, nextNotice: 2 })
  assert.equal(
    applyCancels(NAME, [home], AT, () => assert.fail('fixture は読めるはず')),
    fixtureCancels.cancels.length,
  )
  assert.deepEqual(
    readStore(NAME).rules.map((entry) => entry.status),
    ['withdrawn', 'active'],
  )
})

test('LN20 tick は intake の設定の隣の learn-cancels.json を読んで規則を取り下げる。読めない依頼があっても tick は続く', () => {
  const f = runtimeFixture()
  try {
    writeStore('main', { rules: [rule('r1'), rule('r2')], nextRule: 3, nextNotice: 1 })
    // 設定の intakeConfig（intake.json）の親フォルダが intake のホーム
    writeFileSync(join(f.dir, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels: [cancel('r1')] }))
    f.cli('tick')
    assert.deepEqual(
      readStore('main').rules.map((entry) => entry.status),
      ['withdrawn', 'active'],
    )
    assert.deepEqual(
      readNotices('main').flatMap((notice) => notice.items.map((item) => item.kind)),
      ['withdrawn'],
    )
    writeFileSync(join(f.dir, LEARN_CANCELS_FILE), '{')
    f.cli('tick')
    assert.equal(readStore('main').rules[1]?.status, 'active')
  } finally {
    f.cleanup()
  }
})
