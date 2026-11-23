import { parseAutoConfig } from '../../lib/auto-config.ts'
import {
  globalProblems,
  LEARN_GLOBAL_BODY_MAX,
  LEARN_GLOBAL_ENG_EVIDENCE,
  LEARN_GLOBAL_TITLE_MAX,
  LEARN_LABEL,
  LEARN_PLUGIN_REPO,
  proposeGlobal,
  readNotices,
  readStore,
  writeStore,
} from '../../lib/auto-learn.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { configJsonFromDraft, draftFromConfig } from '../../lib/setup-draft.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import type { AutoConfig } from '../../lib/auto-config.ts'
import type { Rule } from '../../lib/auto-learn.ts'

const AT = '2026-11-23T00:00:00Z'
const APP = 'acme/app'
const API = 'other/api'
const ISSUE_URL = `https://github.com/${LEARN_PLUGIN_REPO}/issues/12`
const GATE_REASON = '判定の基準を変える PR は人が merge します。'
// 設定にあるリポジトリ名（app・api）を部分にも含まない題と本文
const TITLE = 'Treat copy-only fixes as automatic'
const BODY =
  'Two repositories learned that Issues which only change wording merged cleanly (4 cases). In skills/orca-team-dispatch-task/references/auto-judge.md, the second paragraph should list copy-only fixes as bounded work.'
const evidence = (n: number): string[] => Array.from({ length: n }, (_, i) => `${APP}#${i + 1}@1`)
const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({
  id,
  repo: APP,
  direction: 'auto',
  topic: `文言だけの修正 ${id}`,
  evidence: evidence(2),
  createdAt: AT,
  probationLeft: 0,
  status: 'active',
  withdrawnWhy: '',
  global: null,
  ...overrides,
})
const store = (rules: Rule[]) => ({ rules, nextRule: rules.length + 1, nextNotice: 1 })
const ruleOf = (id: string): Rule | undefined => readStore('main').rules.find((entry) => entry.id === id)
const withLearn = (config: AutoConfig, issueRepo: string | null): AutoConfig => ({ ...config, learn: { issueRepo } })
// gh の応答は JSON でなく生の文字列（gh issue create は Issue の URL を 1 行出す）
const respondText = (f: ReturnType<typeof fixture>, key: string, text: string) =>
  writeFileSync(join(f.gh, key), `${text}\n`)
const issueCreates = (f: ReturnType<typeof fixture>): string[] =>
  f
    .calls()
    .split('\n')
    .filter((line) => line.startsWith('issue create'))

test('LN20 設定の learn.issueRepo は無ければ null、owner/name 以外を断る', () => {
  const f = fixture()
  try {
    assert.deepEqual(parseAutoConfig(f.raw, 'main')?.learn, { issueRepo: null })
    assert.deepEqual(parseAutoConfig({ ...f.raw, learn: { issueRepo: null } }, 'main')?.learn, { issueRepo: null })
    assert.deepEqual(parseAutoConfig({ ...f.raw, learn: {} }, 'main')?.learn, { issueRepo: null })
    assert.deepEqual(parseAutoConfig({ ...f.raw, learn: { issueRepo: LEARN_PLUGIN_REPO } }, 'main')?.learn, {
      issueRepo: LEARN_PLUGIN_REPO,
    })
    for (const bad of ['yui-cc-plugins', 'a/b/c', 'a b/c', '', 1, true])
      assert.equal(parseAutoConfig({ ...f.raw, learn: { issueRepo: bad } }, 'main'), null, String(bad))
    assert.equal(parseAutoConfig({ ...f.raw, learn: 'x' }, 'main'), null)
    // 下書きを通しても値は保たれ、null なら書かない（y のあと n にしたら消える）
    const on = parseAutoConfig({ ...f.raw, learn: { issueRepo: LEARN_PLUGIN_REPO } }, 'main')
    assert.ok(on)
    const json = configJsonFromDraft(draftFromConfig(on), null)
    assert.deepEqual(json?.learn, { issueRepo: LEARN_PLUGIN_REPO })
    const offDraft = draftFromConfig(on)
    offDraft.values.learn = { issueRepo: null }
    const off = configJsonFromDraft(offDraft, json)
    assert.ok(off)
    assert.equal(Object.hasOwn(off, 'learn'), false)
  } finally {
    f.cleanup()
  }
})

test('LN22 judge-list の global.candidates は様子見を終えた auto の規則と根拠 5 件以上の eng の規則だけで、既に出した規則を除く', () => {
  const f = runtimeFixture()
  try {
    writeStore(
      'main',
      store([
        rule('r1'),
        rule('r2', { probationLeft: 2 }),
        rule('r3', { direction: 'eng', evidence: evidence(LEARN_GLOBAL_ENG_EVIDENCE), repo: API }),
        rule('r4', { direction: 'eng', evidence: evidence(LEARN_GLOBAL_ENG_EVIDENCE - 1) }),
        rule('r5', { global: { issue: `${LEARN_PLUGIN_REPO}#3`, prNotified: false } }),
        rule('r6', { global: { issue: '', prNotified: true } }),
        rule('r7', { status: 'withdrawn', withdrawnWhy: '振り返りで取り下げ' }),
      ]),
    )
    const list = f.cli('judge-list')
    assert.equal(list.status, 0, list.stderr)
    const out = JSON.parse(list.stdout)
    assert.deepEqual(out.global, {
      enabled: false,
      candidates: [
        { ruleId: 'r1', repo: APP, direction: 'auto', topic: '文言だけの修正 r1', evidenceCount: 2 },
        {
          ruleId: 'r3',
          repo: API,
          direction: 'eng',
          topic: '文言だけの修正 r3',
          evidenceCount: LEARN_GLOBAL_ENG_EVIDENCE,
        },
      ],
    })
    f.put(f.configFile, { ...f.raw, learn: { issueRepo: LEARN_PLUGIN_REPO } })
    assert.equal(JSON.parse(f.cli('judge-list').stdout).global.enabled, true)
    // 候補だけでは AI を起こさない（判定待ちも振り返りも無い）
    const state = readState('main')
    state.judgingSince = null
    writeState('main', state)
    assert.equal(f.cli('tick').status, 1)
  } finally {
    f.cleanup()
  }
})

test('LN23 proposeGlobal は Ready・slack-thread・judge-learning を付けて Issue を作り、規則に Issue の key を残して知らせを足す。issueRepo が null なら Issue を作らず global-hint を足す', () => {
  const f = fixture()
  const lines: string[] = []
  const log = (line: string) => {
    lines.push(line)
  }
  // appendNotice が出す「学び:」の行を test の出力に混ぜない
  const quiet = mock.method(console, 'log', () => {})
  try {
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    writeStore('main', store([rule('r1'), rule('r2', { probationLeft: 1 })]))
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    const calls = f.calls()
    // 足りないラベルは作る（judge-learning・slack-thread・ステータス）
    for (const name of [LEARN_LABEL, 'slack-thread', 'Ready', 'Backlog'])
      assert.ok(calls.includes(`label create ${name} --repo ${LEARN_PLUGIN_REPO}`), name)
    const creates = issueCreates(f)
    assert.equal(creates.length, 1, calls)
    const create = creates[0] ?? ''
    assert.ok(create.includes(`--repo ${LEARN_PLUGIN_REPO}`))
    assert.ok(create.includes('--label Ready --label slack-thread --label judge-learning'), create)
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false })
    const notices = readNotices('main')
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.repo, APP)
    assert.deepEqual(notices[0]?.items, [
      { n: 1, kind: 'global-issue', ruleId: 'r1', direction: 'auto', text: TITLE, evidence: [], url: ISSUE_URL },
    ])
    // 出した規則と様子見の規則は作らない
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    proposeGlobal('main', config, { ruleId: 'r2', title: TITLE, body: BODY }, AT, log)
    proposeGlobal('main', config, { ruleId: 'r9', title: TITLE, body: BODY }, AT, log)
    assert.equal(issueCreates(f).length, 1)
    assert.equal(ruleOf('r2')?.global, null)
    assert.equal(lines.length, 3, lines.join('\n'))

    // 作れなければ 1 行出して規則は変えない（次の振り返りでまた出せる）
    writeStore('main', store([rule('r1')]))
    writeFileSync(join(f.gh, 'issue_create.rc'), '1')
    lines.length = 0
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    assert.equal(ruleOf('r1')?.global, null)
    assert.equal(lines.length, 1)

    // issueRepo が null なら Issue を作らず、全体に効きそうな学びとして知らせるだけ
    writeFileSync(join(f.gh, 'calls.log'), '')
    proposeGlobal('main', withLearn(f.config(), null), { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    assert.equal(f.calls(), '')
    assert.deepEqual(ruleOf('r1')?.global, { issue: '', prNotified: true })
    assert.deepEqual(readNotices('main').at(-1)?.items, [
      { n: 1, kind: 'global-hint', ruleId: 'r1', direction: 'auto', text: TITLE, evidence: [], url: '' },
    ])
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN23b judge-apply は global の案を受け取り、Issue を作る', () => {
  const f = fixture()
  try {
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    f.put(f.configFile, { ...f.raw, learn: { issueRepo: LEARN_PLUGIN_REPO } })
    writeStore('main', store([rule('r1')]))
    const file = join(f.dir, 'decisions.json')
    f.put(file, { decisions: [], learn: [{ kind: 'global', ruleId: 'r1', title: TITLE, body: BODY }] })
    const result = f.cli('judge-apply', '--file', file)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(issueCreates(f).length, 1)
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false })
    // 形の合わない案は 1 行出して捨てる
    f.put(file, { decisions: [], learn: [{ kind: 'global', ruleId: 'r1' }] })
    const bad = f.cli('judge-apply', '--file', file)
    assert.equal(bad.status, 0, bad.stderr)
    assert.match(bad.stderr, /学びの案を捨てました: global/)
    assert.equal(issueCreates(f).length, 1)
  } finally {
    f.cleanup()
  }
})

test('LN24 題か本文にリポジトリ名・#数字・URL があれば Issue を作らず 1 行出し、規則は変えない', () => {
  const f = fixture()
  try {
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    const repos = [APP, API]
    assert.deepEqual(globalProblems(TITLE, BODY, repos), [])
    const cases: Array<[string, string]> = [
      [TITLE, `${BODY} Seen in acme/app.`],
      ['app の修正', BODY],
      [TITLE, `${BODY} See #41.`],
      [TITLE, `${BODY} https://example.com`],
      ['ACME/APP wording', BODY],
      [TITLE, `${BODY} http://example.com`],
      ['', BODY],
      [TITLE, ''],
      ['x'.repeat(LEARN_GLOBAL_TITLE_MAX + 1), BODY],
      [TITLE, 'x'.repeat(LEARN_GLOBAL_BODY_MAX + 1)],
    ]
    for (const [title, body] of cases) {
      assert.ok(globalProblems(title, body, repos).length > 0, `${title} / ${body}`)
      writeStore('main', store([rule('r1')]))
      const lines: string[] = []
      proposeGlobal('main', config, { ruleId: 'r1', title, body }, AT, (line) => {
        lines.push(line)
      })
      assert.equal(issueCreates(f).length, 0, `${title} / ${body}`)
      assert.equal(lines.length, 1, lines.join('\n'))
      assert.equal(ruleOf('r1')?.global, null)
    }
    // 長さちょうどは通る
    assert.deepEqual(globalProblems('x'.repeat(LEARN_GLOBAL_TITLE_MAX), 'x'.repeat(LEARN_GLOBAL_BODY_MAX), repos), [])
  } finally {
    f.cleanup()
  }
})

test('LN25 judge-learning の Issue は条件がそろっても AI が merge せず人の確認に回り、PR ができたら global-pr の知らせを 1 回だけ足す', () => {
  for (const label of [LEARN_LABEL, 'Judge-Learning']) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i)
      f.respond('issue_view', {
        state: 'OPEN',
        title: '題',
        body: '本文',
        labels: [{ name: 'In progress' }, { name: label }],
      })
      writeStore('main', store([rule('r1', { global: { issue: i.key, prNotified: false } })]))
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review', label)
      assert.ok(!f.calls().includes('pr merge'))
      const comments = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string)
        .join('\n')
      assert.ok(comments.includes(GATE_REASON), comments)
      const prUrl = readState('main').issues[i.key]?.prs[0]?.url
      assert.ok(prUrl)
      const notices = () => readNotices('main').flatMap((notice) => notice.items.filter((x) => x.kind === 'global-pr'))
      assert.deepEqual(notices(), [
        { n: 1, kind: 'global-pr', ruleId: 'r1', direction: 'auto', text: '題', evidence: [], url: prUrl },
      ])
      assert.deepEqual(ruleOf('r1')?.global, { issue: i.key, prNotified: true })
      f.cli('tick')
      assert.equal(notices().length, 1)
    } finally {
      f.cleanup()
    }
  }
})
