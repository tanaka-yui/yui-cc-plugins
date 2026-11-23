import {
  LEARN_FILES,
  learnDir,
  readHistory,
  readNotices,
  readStore,
  recordOutcome,
  writeStore,
} from '../../lib/auto-learn.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import type { Outcome, Rule } from '../../lib/auto-learn.ts'
import type { IssueState } from '../../lib/auto-state.ts'

const AT = '2026-11-23T00:00:00Z'
const APP = 'acme/app'
const PROBATION_REASON = '新しい学びで自動にした Issue なので、merge の前に人が確認します。'
const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({
  id,
  repo: APP,
  direction: 'auto',
  topic: `文言だけの修正 ${id}`,
  evidence: [`${APP}#1@1`, `${APP}#2@1`],
  createdAt: AT,
  probationLeft: 3,
  status: 'active',
  withdrawnWhy: '',
  global: null,
  ...overrides,
})
const store = (rules: Rule[]) => ({ rules, nextRule: rules.length + 1, nextNotice: 1 })
const ruleOf = (id: string): Rule | undefined => readStore('main').rules.find((entry) => entry.id === id)

// 仕上げの段の Issue に、規則 r1 に頼った判定を入れて tick を 1 回回す
const finishWith = (rules: Rule[]) => {
  const f = runtimeFixture()
  const i = f.track('finishing')
  f.result(i)
  const state = readState('main')
  const issue = state.issues[i.key]
  assert.ok(issue)
  issue.learn = { aiRoute: 'auto', forced: '', ruleIds: ['r1'], recorded: false }
  writeState('main', state)
  writeStore('main', store(rules))
  f.cli('tick')
  return { f, i }
}
// tick が書いたコメントの本文（1 行に 1 つの JSON 文字列）
const commentsOf = (f: ReturnType<typeof runtimeFixture>): string =>
  readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string)
    .join('\n')
const breakRules = (): void => writeFileSync(join(learnDir('main'), LEARN_FILES.rules), '{ broken')

test('LN16 様子見の途中・取り下げ済み・もう無い規則に頼った Issue は条件がそろっても AI が merge せず、理由を付けて人の確認に回る。様子見を終えた規則なら merge する', () => {
  {
    const { f, i } = finishWith([rule('r1')])
    try {
      assert.equal(readState('main').issues[i.key]?.phase, 'review')
      assert.ok(!f.calls().includes('pr merge'))
      assert.ok(f.calls().includes('orca-auto:in-review:1:needs-review'))
      assert.ok(commentsOf(f).includes(PROBATION_REASON))
    } finally {
      f.cleanup()
    }
  }
  // 取り下げた規則・もう無い規則も、様子見を終えていないので人の確認に回す
  for (const rules of [[rule('r1', { status: 'withdrawn', withdrawnWhy: '振り返りで取り下げ' })], [rule('r2')]]) {
    const { f, i } = finishWith(rules)
    try {
      assert.equal(readState('main').issues[i.key]?.phase, 'review', JSON.stringify(rules))
      assert.ok(!f.calls().includes('pr merge'))
      assert.ok(commentsOf(f).includes(PROBATION_REASON))
    } finally {
      f.cleanup()
    }
  }
  // 様子見を終えた有効な規則では、ほかの条件がそろえば merge する
  for (const done of [rule('r1', { probationLeft: 0 }), rule('r1', { direction: 'eng', probationLeft: 0 })]) {
    const { f, i } = finishWith([done])
    try {
      assert.equal(readState('main').issues[i.key]?.phase, 'done', JSON.stringify(done))
      assert.ok(f.calls().includes('pr merge 101 --repo acme/app --squash'))
    } finally {
      f.cleanup()
    }
  }
  // 規則のファイルが読めなければ、様子見を終えたと確かめられないので人の確認に回す
  {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i)
      const state = readState('main')
      const issue = state.issues[i.key]
      assert.ok(issue)
      issue.learn = { aiRoute: 'auto', forced: '', ruleIds: ['r1'], recorded: false }
      writeState('main', state)
      writeStore('main', store([rule('r1', { probationLeft: 0 })]))
      breakRules()
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review')
      assert.ok(commentsOf(f).includes(PROBATION_REASON))
    } finally {
      f.cleanup()
    }
  }
})

test('LN16b 同じ様子見の規則に頼った 2 件のうち先の 1 件が失敗して規則を取り下げると、後の 1 件は条件がそろっても人の確認に回る', () => {
  const f = runtimeFixture()
  const log = mock.method(console, 'log', () => {})
  try {
    const i = f.track('finishing')
    f.result(i)
    const state = readState('main')
    const second = state.issues[i.key]
    assert.ok(second)
    second.learn = { aiRoute: 'auto', forced: '', ruleIds: ['r1'], recorded: false }
    writeState('main', state)
    writeStore('main', store([rule('r1')]))
    // 先の 1 件（同じ r1 に頼った別の Issue）が失敗で終わる
    const first: IssueState = {
      ...second,
      key: `${APP}#8`,
      number: 8,
      learn: { aiRoute: 'auto', forced: '', ruleIds: ['r1'], recorded: false },
    }
    assert.equal(recordOutcome('main', first, ['bug'], 'failed', AT), true)
    assert.equal(ruleOf('r1')?.status, 'withdrawn')
    log.mock.restore()
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(!f.calls().includes('pr merge'))
    assert.ok(commentsOf(f).includes(PROBATION_REASON))
  } finally {
    log.mock.restore()
    f.cleanup()
  }
})

test('LN17 人が merge すると残りが 1 減り、3 件目で graduated の知らせが出る。失敗か人が止めると規則を取り下げ、環境が原因の失敗では何も変えない', () => {
  const f = fixture()
  const log = mock.method(console, 'log', () => {})
  try {
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const state = readState('main')
    syncIssues(state, f.config().sources)
    const base = state.issues[`${APP}#7`]
    assert.ok(base)
    let generation = 0
    // 世代ごとに 1 行書く（recordOutcome が 1 世代 1 行を守る）
    const end = (ruleIds: string[], outcome: Outcome, extra: Partial<IssueState> = {}): void => {
      generation++
      const issue: IssueState = {
        ...base,
        generation,
        ...extra,
        learn: { aiRoute: 'auto', forced: '', ruleIds, recorded: false },
      }
      assert.equal(recordOutcome('main', issue, ['bug'], outcome, AT), true)
    }
    const kinds = (): string[] =>
      readNotices('main').flatMap((notice) => notice.items.map((item) => `${item.kind}:${item.ruleId}`))

    writeStore('main', store([rule('r1'), rule('r2'), rule('r3'), rule('r4'), rule('r5'), rule('r6')]))
    end(['r1'], 'merged-human')
    assert.equal(ruleOf('r1')?.probationLeft, 2)
    end(['r1'], 'merged-human')
    assert.equal(ruleOf('r1')?.probationLeft, 1)
    assert.deepEqual(kinds(), [])
    end(['r1'], 'merged-human')
    assert.equal(ruleOf('r1')?.probationLeft, 0)
    assert.equal(ruleOf('r1')?.status, 'active')
    assert.deepEqual(kinds(), ['graduated:r1'])
    // 様子見を終えた規則は、もう数えない・知らせない
    end(['r1'], 'merged-human')
    end(['r1'], 'failed')
    assert.equal(ruleOf('r1')?.status, 'active')
    assert.deepEqual(kinds(), ['graduated:r1'])

    end(['r2'], 'failed')
    assert.equal(ruleOf('r2')?.status, 'withdrawn')
    assert.equal(ruleOf('r2')?.withdrawnWhy, '様子見の Issue が失敗または人が止めた')
    assert.deepEqual(kinds(), ['graduated:r1', 'withdrawn:r2'])
    // 取り下げた規則は二度取り下げない
    end(['r2'], 'failed')
    assert.deepEqual(kinds(), ['graduated:r1', 'withdrawn:r2'])

    end(['r3'], 'stopped', { startedAt: AT })
    assert.equal(ruleOf('r3')?.status, 'withdrawn')
    end(['r4'], 'stopped', { autoReady: true, startedAt: null })
    assert.equal(ruleOf('r4')?.status, 'withdrawn')
    assert.deepEqual(kinds(), ['graduated:r1', 'withdrawn:r2', 'withdrawn:r3', 'withdrawn:r4'])

    // 始まる前に人が止めた（auto-ready でない）・環境が原因の失敗・AI の merge では何も変えない
    end(['r5'], 'stopped', { autoReady: false, startedAt: null })
    end(['r5'], 'failed-env', { startedAt: AT })
    end(['r6'], 'merged-ai')
    assert.deepEqual(
      [ruleOf('r5'), ruleOf('r6')].map((entry) => `${entry?.status}:${entry?.probationLeft}`),
      ['active:3', 'active:3'],
    )
    assert.deepEqual(kinds(), ['graduated:r1', 'withdrawn:r2', 'withdrawn:r3', 'withdrawn:r4'])

    // 規則のファイルが壊れていても、行は 1 回だけ書いて記録済みにし、投げない
    breakRules()
    const issue: IssueState = {
      ...base,
      generation: generation + 1,
      learn: { aiRoute: 'auto', forced: '', ruleIds: ['r5'], recorded: false },
    }
    const rows = readHistory('main').length
    assert.equal(recordOutcome('main', issue, ['bug'], 'merged-human', AT), true)
    assert.equal(issue.learn?.recorded, true)
    assert.equal(recordOutcome('main', issue, ['bug'], 'merged-human', AT), false)
    assert.equal(readHistory('main').length, rows + 1)
  } finally {
    log.mock.restore()
    f.cleanup()
  }
})
