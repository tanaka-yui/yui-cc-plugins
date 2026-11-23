import { parseAutoConfig } from '../../lib/auto-config.ts'
import {
  appendNotice,
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

import type { AutoConfig } from '../../lib/auto-config.ts'
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
// 前の版の依頼（action が無い）。取り消しとして読む
const cancel = (ruleId: string, noticeId = 1) => ({ noticeId, n: 1, ruleId, at: AT })
// 依頼は自分の notices.json にある項目を指すときだけ効くので、規則ごとに new の知らせを足して id を返す
const noticeOf = (ruleId: string): number => {
  const store = readStore(NAME)
  const notice = appendNotice(
    NAME,
    store,
    REPO,
    [{ kind: 'new', ruleId, direction: 'auto', text: `規則 ${ruleId}`, evidence: [], url: '', body: '' }],
    AT,
  )
  writeStore(NAME, store)
  return notice.id
}
// 改善の Issue を出さない設定（公開の依頼が来ても gh を呼ばない）
const parsed = parseAutoConfig(
  {
    version: 1,
    name: NAME,
    intakeConfig: join(root, 'intake.json'),
    sources: [{ repo: REPO, related: [REPO] }],
    repos: { [REPO]: { checkout: join(root, 'checkout'), verify: [], verified: false, ci: false } },
    lanes: 1,
  },
  NAME,
)
if (parsed === null) throw new Error('設定を読めません')
const config: AutoConfig = parsed
const writeCancels = (cancels: object[]): void =>
  writeFileSync(join(home, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels }))

test('LN18 applyCancels は有効な規則だけを取り下げて知らせを 1 回足し、同じ依頼を 2 回読んでも 2 回目は何もしない。壊れたファイルは 1 行出して続ける', () => {
  writeStore(NAME, {
    rules: [rule('r1'), rule('r2', { status: 'withdrawn', withdrawnWhy: '振り返りで取り下げ' }), rule('r3')],
    nextRule: 4,
    nextNotice: 1,
  })
  const [r1 = 0, r2 = 0, unknown = 0] = ['r1', 'r2', 'unknown'].map(noticeOf)
  // r3 への依頼は自分の知らせに無い項目を指すので何もしない（古くて消えた知らせ・別の名前の知らせ）
  writeCancels([cancel('r1', r1), cancel('r2', r2), cancel('unknown', unknown), cancel('r3', 99)])
  const broken = join(root, `broken-${sequence}`)
  mkdirSync(broken)
  writeFileSync(join(broken, LEARN_CANCELS_FILE), '{')
  const lines: string[] = []
  const log = (line: string) => {
    lines.push(line)
  }

  const withdrawn = applyCancels(NAME, config, [broken, home, join(root, 'no-such-home')], AT, log)

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
  assert.equal(store.nextNotice, 5)
  const notices = readNotices(NAME)
  assert.equal(notices.length, 4)
  assert.deepEqual(
    notices[3]?.items.map((item) => [item.kind, item.ruleId, item.text]),
    [['withdrawn', 'r1', '文言だけの修正 r1']],
  )
  assert.equal(notices[3]?.repo, REPO)

  assert.equal(applyCancels(NAME, config, [home], AT, log), 0)
  assert.equal(readNotices(NAME).length, 4)
  assert.equal(readStore(NAME).nextNotice, 5)
  assert.equal(lines.length, 1)
})

test('LN18b 形の違う依頼のファイルは読めないものとして 1 行出し、何も取り下げない', () => {
  writeStore(NAME, { rules: [rule('r1')], nextRule: 2, nextNotice: 1 })
  const id = noticeOf('r1')
  for (const cancels of [[{ ruleId: 'r1' }], [{ ...cancel('r1', id), action: 'delete' }]]) {
    writeFileSync(join(home, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels }))
    const lines: string[] = []
    assert.equal(
      applyCancels(NAME, config, [home], AT, (line) => lines.push(line)),
      0,
    )
    assert.equal(lines.length, 1)
    assert.equal(readStore(NAME).rules[0]?.status, 'active')
  }
})

test('LN19 fixture の learn-notices.json は readNotices で読め、learn-cancels.json は applyCancels が読める', () => {
  mkdirSync(learnDir(NAME), { recursive: true })
  cpSync(new URL('learn-notices.json', FIXTURES), join(learnDir(NAME), LEARN_FILES.notices))
  const notices = readNotices(NAME)
  assert.deepEqual(
    notices.map((notice) => notice.items.map((item) => [item.ruleId, item.kind])),
    [
      [
        ['r1', 'new'],
        ['r2', 'new'],
      ],
      [['r3', 'global-draft']],
    ],
  )
  assert.ok((notices[1]?.items[0]?.body ?? '') !== '')
  assert.ok(notices[0]?.items.every((item) => item.body === ''))

  cpSync(new URL('learn-cancels.json', FIXTURES), join(home, LEARN_CANCELS_FILE))
  const fixtureCancels = JSON.parse(readFileSync(join(home, LEARN_CANCELS_FILE), 'utf8'))
  assert.deepEqual(
    fixtureCancels.cancels.map((entry: { action: string }) => entry.action),
    ['cancel', 'publish'],
  )
  // r3 の下書きの公開の依頼は、この設定（改善の Issue を出さない）では公開せずに下書きを残す
  const draft = { title: notices[1]?.items[0]?.text ?? '', body: notices[1]?.items[0]?.body ?? '' }
  writeStore(NAME, {
    rules: [rule('r1'), rule('r2'), rule('r3', { probationLeft: 0, global: { issue: '', prNotified: false, draft } })],
    nextRule: 4,
    nextNotice: 3,
  })
  const lines: string[] = []
  assert.equal(
    applyCancels(NAME, config, [home], AT, (line) => lines.push(line)),
    1,
  )
  assert.deepEqual(
    readStore(NAME).rules.map((entry) => entry.status),
    ['withdrawn', 'active', 'active'],
  )
  assert.deepEqual(readStore(NAME).rules[2]?.global, { issue: '', prNotified: false, draft })
  assert.equal(lines.length, 1, lines.join('\n'))
})

test('LN20 tick は intake の設定の隣の learn-cancels.json を読んで規則を取り下げる。読めない依頼があっても tick は続く', () => {
  const f = runtimeFixture()
  try {
    writeStore('main', { rules: [rule('r1'), rule('r2')], nextRule: 3, nextNotice: 1 })
    const store = readStore('main')
    const notice = appendNotice(
      'main',
      store,
      REPO,
      [{ kind: 'new', ruleId: 'r1', direction: 'auto', text: 'r1', evidence: [], url: '', body: '' }],
      AT,
    )
    writeStore('main', store)
    // 設定の intakeConfig（intake.json）の親フォルダが intake のホーム
    writeFileSync(join(f.dir, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels: [cancel('r1', notice.id)] }))
    f.cli('tick')
    assert.deepEqual(
      readStore('main').rules.map((entry) => entry.status),
      ['withdrawn', 'active'],
    )
    assert.deepEqual(
      readNotices('main').flatMap((entry) => entry.items.map((item) => item.kind)),
      ['new', 'withdrawn'],
    )
    writeFileSync(join(f.dir, LEARN_CANCELS_FILE), '{')
    f.cli('tick')
    assert.equal(readStore('main').rules[1]?.status, 'active')
  } finally {
    f.cleanup()
  }
})
