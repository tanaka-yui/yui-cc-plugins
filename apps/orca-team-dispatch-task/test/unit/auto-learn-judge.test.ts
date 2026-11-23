import {
  activeRules,
  applyLearn,
  type HistoryRow,
  LEARN_CASES_MAX,
  LEARN_RULES_MAX,
  mismatchesOf,
  readHistory,
  readNotices,
  readStore,
  reflectDue,
  writeHistory,
  writeStore,
} from '../../lib/auto-learn.ts'
import { AUTO_FILES, autoDir } from '../../lib/auto-paths.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import {
  applyJudgeRules,
  CLAUDE_HOME_ENV,
  judgeFingerprint,
  judgeRules,
  launcherPaths,
} from '../../lib/setup-automation.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Rule } from '../../lib/auto-learn.ts'
import type { Json } from '../../lib/json.ts'

const AT = '2026-11-23T00:00:00Z'
const APP = 'acme/app'
const API = 'other/api'
const row = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  key: `${APP}#1`,
  repo: APP,
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
  at: AT,
  reflected: false,
  ...overrides,
})
const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({
  id,
  repo: APP,
  direction: 'auto',
  topic: '文言だけの修正',
  evidence: [`${APP}#1@1`, `${APP}#2@1`],
  createdAt: AT,
  probationLeft: 0,
  status: 'active',
  withdrawnWhy: '',
  global: null,
  ...overrides,
})
// 攻めすぎた（auto で失敗した）行。key の番号ごとに 1 件の食い違いになる
const failedRows = (repo: string, numbers: number[]): HistoryRow[] =>
  numbers.map((n) => row({ key: `${repo}#${n}`, repo, title: `失敗した修正 ${n}`, outcome: 'failed' }))

// acme/app#7 と other/api#7 を判定待ちにする（題名と GitHub のラベルは似た事例の材料）
const judging = () => {
  const f = fixture()
  f.respond('issue_list', [{ number: 7, title: 'ログイン画面の文言を直す', labels: [], updatedAt: '2026-01-01' }])
  f.respond('issue_view', { state: 'OPEN', labels: [{ name: 'Ready' }, { name: 'bug' }], title: '題', body: '本文' })
  const state = readState('main')
  syncIssues(state, f.config().sources)
  writeState('main', state)
  const decision = (extra: object = {}) => ({
    key: `${APP}#7`,
    generation: 1,
    route: 'auto',
    targets: [APP],
    limitMinutes: 60,
    reason: '明確な修正です',
    ...extra,
  })
  const apply = (value: Json) => {
    const file = join(f.dir, 'decisions.json')
    f.put(file, value)
    return f.cli('judge-apply', '--file', file)
  }
  return { ...f, decision, apply }
}

test('LN10 judge-list は Issue ごとに有効な規則と似た事例を付け、食い違いが 3 件たまったリポジトリの振り返りの材料を出す', () => {
  const f = judging()
  try {
    writeStore('main', {
      rules: [
        rule('r1', { probationLeft: 3, topic: '画面の文言だけを直す Issue' }),
        rule('r2', { direction: 'eng', topic: 'DB のマイグレーションを含む Issue' }),
        rule('r3', { status: 'withdrawn', withdrawnWhy: '振り返りで取り下げ' }),
        rule('r4', { repo: API, topic: 'API の型だけを直す Issue' }),
      ],
      nextRule: 5,
      nextNotice: 1,
    })
    // 似た事例: ラベル bug が重なる行が 7 件（5 件までに切る）。題名が重なるものほど前
    const similar = Array.from({ length: 7 }, (_, n) =>
      row({ key: `${APP}#${20 + n}`, title: `別の件 ${n}`, labels: ['bug'], at: `2026-11-2${n}T00:00:00Z` }),
    )
    const closest = row({ key: `${APP}#30`, title: 'ログイン画面の文言', labels: ['bug'], outcome: 'merged-human' })
    writeHistory('main', [
      ...failedRows(APP, [1, 2, 3]),
      ...failedRows(API, [1, 2]),
      ...similar,
      closest,
      row({ key: `${API}#40`, repo: API, title: 'ログイン画面の文言', labels: ['bug'] }),
    ])
    const result = f.cli('judge-list')
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    const app = out.issues.find((i: { key: string }) => i.key === `${APP}#7`)
    assert.deepEqual(app.learned.rules, [
      { id: 'r1', direction: 'auto', topic: '画面の文言だけを直す Issue', probation: true },
      { id: 'r2', direction: 'eng', topic: 'DB のマイグレーションを含む Issue', probation: false },
    ])
    assert.equal(app.learned.cases.length, LEARN_CASES_MAX)
    assert.deepEqual(app.learned.cases[0], { title: 'ログイン画面の文言', route: 'auto', outcome: 'merged-human' })
    // 事例は題名・向き・結果だけ
    assert.deepEqual(Object.keys(app.learned.cases[1]).sort(), ['outcome', 'route', 'title'])
    const api = out.issues.find((i: { key: string }) => i.key === `${API}#7`)
    assert.deepEqual(api.learned.rules, [
      { id: 'r4', direction: 'auto', topic: 'API の型だけを直す Issue', probation: false },
    ])
    // 食い違い 2 件の other/api は振り返りに出ない
    assert.deepEqual(out.reflect, [
      {
        repo: APP,
        mismatches: mismatchesOf(readHistory('main'), APP),
        rules: [
          { id: 'r1', direction: 'auto', topic: '画面の文言だけを直す Issue', evidence: rule('r1').evidence },
          { id: 'r2', direction: 'eng', topic: 'DB のマイグレーションを含む Issue', evidence: rule('r2').evidence },
        ],
      },
    ])
    assert.equal(out.reflect[0].mismatches.length, 3)
    assert.deepEqual(JSON.parse(readFileSync(join(autoDir('main'), AUTO_FILES.pending), 'utf8')), out)

    // 学びのデータが無ければ、規則も事例も振り返りも空
    writeHistory('main', [])
    writeStore('main', { rules: [], nextRule: 1, nextNotice: 1 })
    const empty = JSON.parse(f.cli('judge-list').stdout)
    assert.deepEqual(empty.reflect, [])
    assert.deepEqual(empty.issues[0].learned, { rules: [], cases: [] })
  } finally {
    f.cleanup()
  }
})

test('LN10b 壊れた学びのファイルでも judge-list は止まらず、1 行出して学びを空にする', () => {
  const f = judging()
  try {
    writeHistory('main', failedRows(APP, [1, 2, 3]))
    f.put(join(autoDir('main'), 'learn/rules.json'), { version: 1, rules: [{}], nextRule: 1, nextNotice: 1 })
    const result = f.cli('judge-list')
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.deepEqual(out.reflect, [])
    assert.deepEqual(out.issues[0].learned, { rules: [], cases: [] })
    assert.equal(result.stderr.trim().split('\n').length, 1)
    assert.match(result.stderr, /状態ファイルが壊れています/)
  } finally {
    f.cleanup()
  }
})

test('LN11 tick は判定待ちが無くても振り返りが要れば 0 を返し、最後の行に learn= を出す', () => {
  const last = (stdout: string) => stdout.trim().split('\n').at(-1) ?? ''
  {
    const f = runtimeFixture()
    try {
      const r = f.cli('tick')
      assert.equal(r.status, 1, r.stderr)
      assert.match(last(r.stdout), /^auto: judge=0 .* learn=0$/)
      writeHistory('main', [...failedRows(APP, [1, 2]), ...failedRows(API, [1, 2])])
      assert.equal(f.cli('tick').status, 1)
      writeHistory('main', [...failedRows(APP, [1, 2, 3]), ...failedRows(API, [1, 2, 3])])
      const due = f.cli('tick')
      assert.equal(due.status, 0, due.stderr)
      assert.match(last(due.stdout), /^auto: judge=0 .* learn=2$/)
      // 判定のリースの中なら起こさない
      const state = readState('main')
      state.judgingSince = '2026-11-13T05:25:00Z'
      writeState('main', state)
      const leased = f.cli('tick')
      assert.equal(leased.status, 1)
      assert.match(last(leased.stdout), / learn=2$/)
      // 壊れた履歴は 1 行出して数えない（tick は止めない）
      state.judgingSince = null
      writeState('main', state)
      f.put(join(autoDir('main'), 'learn/history.json'), { version: 1, rows: [{}] })
      const broken = f.cli('tick')
      assert.equal(broken.status, 1)
      assert.match(last(broken.stdout), / learn=0$/)
      assert.equal(broken.stdout.split('\n').filter((line) => line.includes('状態ファイルが壊れています')).length, 1)
      // 規則が壊れていれば judge-list も振り返りを出さないので、起こさない
      writeHistory('main', failedRows(APP, [1, 2, 3]))
      f.put(join(autoDir('main'), 'learn/rules.json'), { version: 1, rules: [{}], nextRule: 1, nextNotice: 1 })
      const brokenRules = f.cli('tick')
      assert.equal(brokenRules.status, 1)
      assert.match(last(brokenRules.stdout), / learn=0$/)
    } finally {
      f.cleanup()
    }
  }
})

test('LN12 judge-apply は今までの配列も { decisions, learn } も受け付ける', () => {
  for (const shape of ['array', 'object', 'object-without-learn'] as const) {
    const f = judging()
    try {
      const rows = [f.decision()]
      const value: Json =
        shape === 'array' ? rows : shape === 'object' ? { decisions: rows, learn: [] } : { decisions: rows }
      const result = f.apply(value)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readState('main').issues[`${APP}#7`]?.phase, 'queued')
    } finally {
      f.cleanup()
    }
  }
  const f = judging()
  try {
    for (const bad of [{ learn: [] }, { decisions: {}, learn: [] }, { decisions: [], learn: {} }, 'x'] as Json[]) {
      const result = f.apply(bad)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /判定結果は/)
    }
    assert.equal(readState('main').issues[`${APP}#7`]?.phase, 'judging')
    // 判定待ちが無く振り返りだけのときは decisions が空の形で案を出す
    writeHistory('main', failedRows(APP, [1, 2, 3]))
    assert.equal(f.cli('judge-list').status, 0)
    const ids = mismatchesOf(readHistory('main'), APP).map((m) => m.id)
    const result = f.apply({
      decisions: [],
      learn: [{ repo: APP, kind: 'add', direction: 'eng', topic: '失敗しやすい修正', evidence: ids.slice(0, 2) }],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      activeRules(readStore('main'), APP).map((r) => [r.id, r.direction, r.topic]),
      [['r1', 'eng', '失敗しやすい修正']],
    )
    assert.deepEqual(mismatchesOf(readHistory('main'), APP), [])
    // exit 1 のあとのやり直しで同じファイルをもう一度渡しても（pending.json はそのまま）、同じ案を二度入れない
    const again = f.apply({
      decisions: [],
      learn: [{ repo: APP, kind: 'add', direction: 'eng', topic: '失敗しやすい修正', evidence: ids.slice(0, 2) }],
    })
    assert.equal(again.status, 0, again.stderr)
    assert.equal(activeRules(readStore('main'), APP).length, 1)
  } finally {
    f.cleanup()
  }
})

test('LN12b 配列の判定結果でも、見せた食い違いは振り返り済みになる（案が無くても同じ材料で AI を起こさない）', () => {
  const f = judging()
  try {
    writeHistory('main', failedRows(APP, [1, 2, 3]))
    assert.equal(f.cli('judge-list').status, 0)
    assert.equal(f.apply([f.decision()]).status, 0)
    assert.deepEqual(reflectDue(readHistory('main'), [APP, API]), [])
  } finally {
    f.cleanup()
  }
})

test('LN13 様子見の規則を見せた Issue を auto にして rules が無い行は断り、rules があれば learn.ruleIds に入れる（見せていない id は断る）', () => {
  const f = judging()
  try {
    writeStore('main', {
      rules: [
        rule('r1', { probationLeft: 3 }),
        rule('r2', { direction: 'eng' }),
        rule('r3', { status: 'withdrawn' }),
        rule('r4', { repo: API }),
      ],
      nextRule: 5,
      nextNotice: 1,
    })
    assert.equal(f.cli('judge-list').status, 0)
    for (const extra of [
      {},
      { rules: 'r1' },
      { rules: [1] },
      { rules: ['r9'] },
      { rules: ['r2'] },
      { rules: ['r3'] },
      { rules: ['r4'] },
      { rules: ['r1', 'r9'] },
    ]) {
      const result = f.apply([f.decision(extra)])
      assert.equal(result.status, 1, JSON.stringify(extra))
      assert.match(result.stderr, /判定を破棄しました: acme\/app#7/)
      assert.equal(readState('main').issues[`${APP}#7`]?.phase, 'judging')
    }
    const result = f.apply([f.decision({ rules: ['r1', 'r1'] })])
    assert.equal(result.status, 0, result.stderr)
    const issue = readState('main').issues[`${APP}#7`]
    assert.equal(issue?.phase, 'queued')
    assert.deepEqual(issue?.learn?.ruleIds, ['r1'])
  } finally {
    f.cleanup()
  }
  // eng の行には rules が要らない。様子見の規則が無ければ auto でも rules を省ける
  for (const [probationLeft, extra] of [
    [3, { route: 'eng' }],
    [0, {}],
  ] as const) {
    const g = judging()
    try {
      writeStore('main', { rules: [rule('r1', { probationLeft })], nextRule: 2, nextNotice: 1 })
      assert.equal(g.cli('judge-list').status, 0)
      const result = g.apply([g.decision(extra)])
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(readState('main').issues[`${APP}#7`]?.learn?.ruleIds, [])
    } finally {
      g.cleanup()
    }
  }
  // judge-list を経ていない（pending.json が無い）なら見せた規則は無い
  const h = judging()
  try {
    writeStore('main', { rules: [rule('r1', { probationLeft: 3 })], nextRule: 2, nextNotice: 1 })
    assert.equal(existsSync(join(autoDir('main'), AUTO_FILES.pending)), false)
    assert.equal(h.apply([h.decision({ rules: ['r1'] })]).status, 1)
    assert.equal(h.apply([h.decision({ rules: [] })]).status, 0)
  } finally {
    h.cleanup()
  }
})

test('LN14 applyLearn は add・support・withdraw を保存して知らせを足し、形の合わない案・材料に無い根拠・21 件目を捨て、見せた食い違いを振り返り済みにする', () => {
  const f = fixture()
  try {
    writeHistory('main', [...failedRows(APP, [1, 2, 3, 4]), ...failedRows(API, [1, 2, 3])])
    writeStore('main', {
      rules: [rule('r1', { probationLeft: 3 }), rule('r2', { direction: 'eng' })],
      nextRule: 3,
      nextNotice: 4,
    })
    const shown = [{ repo: APP, mismatches: mismatchesOf(readHistory('main'), APP) }]
    const [m1, m2, m3, m4] = shown[0]?.mismatches.map((m) => m.id) ?? []
    assert.ok(m1 && m2 && m3 && m4)
    const lines: string[] = []
    applyLearn(
      'main',
      [
        { repo: APP, kind: 'add', direction: 'auto', topic: '文言だけの修正', evidence: [m1, m2] },
        { repo: APP, kind: 'add', direction: 'eng', topic: '設定ファイルに触る修正', evidence: [m2, m3, m3] },
        { repo: APP, kind: 'add', direction: 'auto', topic: '改行の\nある文', evidence: [m1, m2] },
        { repo: APP, kind: 'add', direction: 'auto', topic: '根拠が 1 件', evidence: [m1] },
        { repo: APP, kind: 'add', direction: 'auto', topic: '同じ根拠を 2 回', evidence: [m1, m1] },
        { repo: APP, kind: 'add', direction: 'auto', topic: '材料に無い根拠', evidence: [m1, `${APP}#99@1`] },
        { repo: APP, kind: 'add', direction: 'sideways', topic: '向きが無い', evidence: [m1, m2] },
        { repo: API, kind: 'add', direction: 'auto', topic: '見せていないリポジトリ', evidence: [m1, m2] },
        { repo: APP, kind: 'support', ruleId: 'r1', evidence: [m4] },
        { repo: APP, kind: 'support', ruleId: 'r9', evidence: [m4] },
        { repo: APP, kind: 'support', ruleId: 'r2', evidence: [] },
        { repo: APP, kind: 'withdraw', ruleId: 'r2' },
        { repo: APP, kind: 'withdraw', ruleId: 'r2' },
        { repo: APP, kind: 'global', ruleId: 'r1' },
        'add',
      ],
      shown,
      AT,
      (line) => lines.push(line),
    )
    // 捨てた案は 1 件につき 1 行
    assert.equal(lines.length, 11, lines.join('\n'))
    const store = readStore('main')
    assert.equal(store.nextRule, 5)
    assert.equal(store.nextNotice, 5)
    assert.deepEqual(
      store.rules.find((r) => r.id === 'r3'),
      rule('r3', { topic: '文言だけの修正', evidence: [m1, m2], probationLeft: 3 }),
    )
    assert.deepEqual(
      store.rules.find((r) => r.id === 'r4'),
      rule('r4', { direction: 'eng', topic: '設定ファイルに触る修正', evidence: [m2, m3] }),
    )
    assert.deepEqual(store.rules.find((r) => r.id === 'r1')?.evidence, [...rule('r1').evidence, m4])
    assert.deepEqual(
      store.rules.find((r) => r.id === 'r2'),
      {
        ...rule('r2', { direction: 'eng' }),
        status: 'withdrawn',
        withdrawnWhy: '振り返りで取り下げ',
      },
    )
    // 知らせはリポジトリごとに 1 つ。番号は案の順
    assert.deepEqual(readNotices('main'), [
      {
        id: 4,
        repo: APP,
        at: AT,
        items: [
          {
            n: 1,
            kind: 'new',
            ruleId: 'r3',
            direction: 'auto',
            text: '文言だけの修正',
            evidence: [m1, m2],
            url: '',
            body: '',
          },
          {
            n: 2,
            kind: 'new',
            ruleId: 'r4',
            direction: 'eng',
            text: '設定ファイルに触る修正',
            evidence: [m2, m3],
            url: '',
            body: '',
          },
          {
            n: 3,
            kind: 'support',
            ruleId: 'r1',
            direction: 'auto',
            text: '文言だけの修正',
            evidence: [...rule('r1').evidence, m4],
            url: '',
            body: '',
          },
          {
            n: 4,
            kind: 'withdrawn',
            ruleId: 'r2',
            direction: 'eng',
            text: '文言だけの修正',
            evidence: [],
            url: '',
            body: '',
          },
        ],
      },
    ])
    // 見せた食い違いだけ振り返り済み。見せていない other/api はそのまま
    assert.deepEqual(mismatchesOf(readHistory('main'), APP), [])
    assert.equal(mismatchesOf(readHistory('main'), API).length, 3)
    assert.deepEqual(reflectDue(readHistory('main'), [APP, API]), [API])
  } finally {
    f.cleanup()
  }

  // 有効な規則が上限に達していれば add を捨てる（同じ回の中で数え直す）。案が空でも振り返り済みにする
  const g = fixture()
  try {
    writeHistory('main', failedRows(APP, [1, 2, 3]))
    writeStore('main', {
      rules: Array.from({ length: LEARN_RULES_MAX - 1 }, (_, n) => rule(`r${n + 1}`)),
      nextRule: LEARN_RULES_MAX,
      nextNotice: 1,
    })
    const shown = [{ repo: APP, mismatches: mismatchesOf(readHistory('main'), APP) }]
    const evidence = shown[0]?.mismatches.slice(0, 2).map((m) => m.id) ?? []
    const lines: string[] = []
    const add = (topic: string): Json => ({ repo: APP, kind: 'add', direction: 'eng', topic, evidence })
    applyLearn('main', [add('20 件目'), add('21 件目')], shown, AT, (line) => lines.push(line))
    assert.equal(activeRules(readStore('main'), APP).length, LEARN_RULES_MAX)
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /20/)

    writeHistory('main', failedRows(API, [1, 2, 3]))
    const apiShown = [{ repo: API, mismatches: mismatchesOf(readHistory('main'), API) }]
    applyLearn('main', [], apiShown, AT, (line) => lines.push(line))
    assert.equal(lines.length, 1)
    assert.deepEqual(reflectDue(readHistory('main'), [APP, API]), [])
  } finally {
    g.cleanup()
  }
})

test('LN15 judgeRules と judgeFingerprint は変わらない', () => {
  const f = judging()
  process.env[CLAUDE_HOME_ENV] = join(f.dir, 'claude')
  try {
    const config = f.config()
    const launcher = launcherPaths().launcher
    const rules = judgeRules(config, launcher)
    // 判定の AI が叩けるコマンドは今までの 3 つだけ（学びのためのコマンドは足さない）
    assert.deepEqual(
      rules.allow.filter((entry) => entry.startsWith('Bash(')),
      [
        `Bash(${launcher} judge-doc --name main)`,
        `Bash(${launcher} judge-list --name main)`,
        `Bash(${launcher} judge-apply --name main --file ${join(autoDir('main'), AUTO_FILES.decisions)})`,
      ],
    )
    assert.ok(!rules.allow.some((entry) => entry.includes('learn')))
    assert.ok(!rules.allow.some((entry) => entry.startsWith('Write(') && !entry.endsWith(`${AUTO_FILES.decisions})`)))
    assert.equal(applyJudgeRules(rules), true)
    const before = judgeFingerprint(config)
    assert.equal(typeof before, 'string')
    // 学びのデータを作り、判定と振り返りを 1 回通しても権限の指紋は同じ
    writeHistory('main', failedRows(APP, [1, 2, 3]))
    assert.equal(f.cli('judge-list').status, 0)
    const ids = mismatchesOf(readHistory('main'), APP).map((m) => m.id)
    const result = f.apply({
      decisions: [f.decision({ rules: [] })],
      learn: [{ repo: APP, kind: 'add', direction: 'auto', topic: '文言だけの修正', evidence: ids }],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(activeRules(readStore('main'), APP).length, 1)
    assert.deepEqual(judgeRules(config, launcher), rules)
    assert.equal(judgeFingerprint(config), before)
  } finally {
    Reflect.deleteProperty(process.env, CLAUDE_HOME_ENV)
    f.cleanup()
  }
})

test('LN15b status は有効な規則の一覧を出す', () => {
  const f = judging()
  try {
    const plain = f.cli('status')
    assert.equal(plain.status, 0, plain.stderr)
    assert.ok(!plain.stdout.includes('学びの規則'))
    writeStore('main', {
      rules: [
        rule('r1', { probationLeft: 2, topic: '画面の文言だけを直す Issue' }),
        rule('r2', { direction: 'eng', repo: API, topic: 'DB のマイグレーション', evidence: ['a', 'b', 'c'] }),
        rule('r3', { status: 'withdrawn', topic: '取り下げた規則' }),
      ],
      nextRule: 4,
      nextNotice: 1,
    })
    const result = f.cli('status')
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout.split('\n')
    assert.ok(lines.includes(`${APP} r1 auto 様子見の残り 2 根拠 2 件: 画面の文言だけを直す Issue`), result.stdout)
    assert.ok(lines.includes(`${API} r2 eng 様子見の残り 0 根拠 3 件: DB のマイグレーション`), result.stdout)
    assert.ok(!result.stdout.includes('取り下げた規則'))
    // 規則のファイルが壊れていても、今までの出力は出す
    f.put(join(autoDir('main'), 'learn/rules.json'), { version: 1, rules: [{}], nextRule: 1, nextNotice: 1 })
    const broken = f.cli('status')
    assert.equal(broken.status, 0)
    assert.match(broken.stdout, /^main: 2 件/)
    assert.match(broken.stdout, /状態ファイルが壊れています/)
  } finally {
    f.cleanup()
  }
})
