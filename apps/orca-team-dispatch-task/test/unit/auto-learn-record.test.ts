import { LEARN_FILES, learnDir, readHistory, recordOutcome } from '../../lib/auto-learn.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import type { IssueState } from '../../lib/auto-state.ts'

const AT = '2026-11-13T05:30:00Z'
const judged = (aiRoute: 'auto' | 'eng' = 'auto'): NonNullable<IssueState['learn']> => ({
  aiRoute,
  forced: '',
  ruleIds: [],
  recorded: false,
})
// 状態ファイルの Issue に判定の記録を入れる（track は判定の前の Issue を作る）
const learnOn = (key: string, learn: NonNullable<IssueState['learn']>, extra: Partial<IssueState> = {}): void => {
  const state = readState('main')
  const issue = state.issues[key]
  assert.ok(issue)
  Object.assign(issue, { learn, ...extra })
  writeState('main', state)
}
const outcomes = (): string[] => readHistory('main').map((row) => `${row.key}@${row.generation}:${row.outcome}`)

test('LN6 recordOutcome は判定のある世代を 1 回だけ履歴に書く', () => {
  const f = fixture()
  try {
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const state = readState('main')
    syncIssues(state, f.config().sources)
    const issue = state.issues['acme/app#7']
    assert.ok(issue)
    assert.equal(issue.learn, null)
    assert.equal(recordOutcome('main', issue, ['bug'], 'stopped', AT), false)
    assert.deepEqual(readHistory('main'), [])

    const learn = judged()
    Object.assign(issue, { learn, autoReady: true, startedAt: AT, reason: '明確な修正です' })
    assert.equal(recordOutcome('main', issue, ['bug'], 'merged-ai', AT), true)
    assert.equal(learn.recorded, true)
    assert.equal(recordOutcome('main', issue, ['bug'], 'merged-ai', AT), false)
    assert.deepEqual(readHistory('main'), [
      {
        key: 'acme/app#7',
        repo: 'acme/app',
        generation: 1,
        title: '題',
        labels: ['bug'],
        aiRoute: 'auto',
        route: 'auto',
        forced: '',
        reason: '明確な修正です',
        autoReady: true,
        started: true,
        ruleIds: [],
        outcome: 'merged-ai',
        at: AT,
        reflected: false,
      },
    ])

    // エンジニア行きの Issue と eng-* の結果は、実際に効いた向きが eng
    const other = state.issues['other/api#7']
    assert.ok(other)
    other.learn = judged('auto')
    assert.equal(recordOutcome('main', other, [], 'eng-kept', AT), true)
    assert.equal(readHistory('main').at(-1)?.route, 'eng')
    assert.equal(readHistory('main').at(-1)?.started, false)

    // 履歴が壊れていても投げずに 1 行出し、記録済みにしない
    writeFileSync(join(learnDir('main'), LEARN_FILES.history), '{"version":1,"rows":[{}]}')
    const lines: string[] = []
    const log = mock.method(console, 'log', (line: string) => lines.push(line))
    const again = judged()
    try {
      issue.learn = again
      assert.equal(recordOutcome('main', issue, [], 'failed', AT), false)
    } finally {
      log.mock.restore()
    }
    assert.equal(again.recorded, false)
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /acme\/app#7/)
  } finally {
    f.cleanup()
  }
})

test('LN7 judge-apply は AI の向きと強制の理由を残し、失敗は環境が原因かどうかで failed と failed-env に分かれる', () => {
  const decide = (category: string, route: string, targets: string[]) => {
    const f = fixture()
    try {
      f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
      const state = readState('main')
      syncIssues(state, f.config().sources)
      const issue = state.issues['acme/app#7']
      assert.ok(issue)
      issue.category = category
      writeState('main', state)
      const file = join(f.dir, 'decisions.json')
      f.put(file, [{ key: issue.key, generation: 1, route, targets, limitMinutes: 60, reason: '理由です' }])
      const result = f.cli('judge-apply', '--file', file)
      assert.equal(result.status, 0, result.stderr)
      return readState('main').issues[issue.key]?.learn
    } finally {
      f.cleanup()
    }
  }
  assert.deepEqual(decide('feature', 'auto', ['acme/app']), {
    aiRoute: 'auto',
    forced: '新機能',
    ruleIds: [],
    recorded: false,
  })
  assert.deepEqual(decide('bug', 'auto', ['acme/app']), judged('auto'))
  assert.deepEqual(decide('feature', 'eng', ['acme/app']), judged('eng'))

  // worker の起動の失敗は環境が原因
  {
    const f = runtimeFixture()
    try {
      const issue = f.track()
      learnOn(issue.key, judged())
      f.childRc('orca-start', 1)
      for (let n = 0; n < 3; n++) f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'failed')
      assert.deepEqual(outcomes(), ['acme/app#7@1:failed-env'])
      assert.equal(readState('main').issues[issue.key]?.learn?.recorded, true)
    } finally {
      f.cleanup()
    }
  }
  // worker が失敗を報告した。結果の報告に envFailure があれば環境が原因
  for (const envFailure of [null, '道具が足りません']) {
    const f = runtimeFixture()
    try {
      const issue = f.track('running')
      learnOn(issue.key, judged())
      f.result(issue, { envFailure })
      f.childRc('orca-wait', 5)
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'failed')
      assert.deepEqual(outcomes(), [`acme/app#7@1:${envFailure ? 'failed-env' : 'failed'}`])
      assert.equal(readHistory('main')[0]?.started, true)
    } finally {
      f.cleanup()
    }
  }
})

test('LN8 エンジニア行きから拾い直すと eng-returned を、閉じて消えると eng-kept を書く', () => {
  {
    const f = runtimeFixture()
    try {
      const issue = f.track()
      learnOn(issue.key, judged('eng'), { phase: 'eng', endedAt: '2026-11-13T05:00:00Z' })
      f.respond('issue_list', [{ number: 7, title: '題', labels: [{ name: 'bug' }], updatedAt: '2026-11-13' }])
      f.cli('tick')
      const state = readState('main').issues[issue.key]
      assert.equal(state?.generation, 2)
      assert.equal(state?.learn, null)
      assert.equal(state?.failEnv, false)
      assert.deepEqual(outcomes(), ['acme/app#7@1:eng-returned'])
      const row = readHistory('main')[0]
      assert.equal(row?.route, 'eng')
      assert.equal(row?.aiRoute, 'eng')
      assert.ok(row?.labels.includes('bug'))
    } finally {
      f.cleanup()
    }
  }
  {
    const f = runtimeFixture()
    try {
      const issue = f.track()
      learnOn(issue.key, judged('eng'), { phase: 'eng', endedAt: '2026-01-01T00:00:00Z' })
      f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [{ name: 'Ready_Eng' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key], undefined)
      assert.deepEqual(outcomes(), ['acme/app#7@1:eng-kept'])
    } finally {
      f.cleanup()
    }
  }
})

test('LN9 人が merge した Issue は merged-human、AI が merge した Issue は merged-ai、人が止めた Issue は stopped を書く', () => {
  const pr = { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' }
  {
    const f = runtimeFixture()
    try {
      const issue = f.track('review')
      learnOn(issue.key, judged(), { prs: [pr] })
      f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In review' }] })
      f.respond('pr_view', { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'done')
      assert.deepEqual(outcomes(), ['acme/app#7@1:merged-human'])
    } finally {
      f.cleanup()
    }
  }
  {
    const f = runtimeFixture()
    try {
      const issue = f.track('finishing')
      learnOn(issue.key, judged())
      f.result(issue)
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'done')
      assert.deepEqual(outcomes(), ['acme/app#7@1:merged-ai'])
    } finally {
      f.cleanup()
    }
  }
  // 動いている Issue のステータスを人が変えた
  {
    const f = runtimeFixture()
    try {
      const issue = f.track('running')
      learnOn(issue.key, judged())
      f.liveWorker()
      f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'stopped')
      assert.deepEqual(outcomes(), ['acme/app#7@1:stopped'])
      assert.equal(readHistory('main')[0]?.started, true)
    } finally {
      f.cleanup()
    }
  }
  // レビュー中に閉じられた・ステータスを変えられた
  for (const closed of [true, false]) {
    const f = runtimeFixture()
    try {
      const issue = f.track('review')
      learnOn(issue.key, judged())
      f.respond('issue_view', { state: closed ? 'CLOSED' : 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, closed ? undefined : 'stopped')
      assert.deepEqual(outcomes(), ['acme/app#7@1:stopped'])
      assert.deepEqual(readHistory('main')[0]?.labels, ['Pending'])
    } finally {
      f.cleanup()
    }
  }
  // 判定の前に止まった Issue は何も書かない
  {
    const f = runtimeFixture()
    try {
      const issue = f.track('running')
      f.liveWorker()
      f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'stopped')
      assert.deepEqual(outcomes(), [])
    } finally {
      f.cleanup()
    }
  }
  // 遷移の途中で人がステータスを変えた（cancelTransition）
  {
    const f = runtimeFixture()
    try {
      const issue = f.track()
      learnOn(issue.key, judged())
      f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'stopped')
      assert.deepEqual(outcomes(), ['acme/app#7@1:stopped'])
    } finally {
      f.cleanup()
    }
  }
})
