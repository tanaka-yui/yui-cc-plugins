import { parseAutoConfig } from '../../lib/auto-config.ts'
import {
  appendNotice,
  applyCancels,
  globalProblems,
  LEARN_CANCELS_FILE,
  LEARN_FILES,
  LEARN_GLOBAL_BODY_MAX,
  LEARN_GLOBAL_ENG_EVIDENCE,
  LEARN_GLOBAL_TITLE_MAX,
  LEARN_LABEL,
  LEARN_PLUGIN_REPO,
  learnDir,
  proposeGlobal,
  publishGlobal,
  readNotices,
  readStore,
  writeStore,
} from '../../lib/auto-learn.ts'
import { AUTO_FILES, autoDir } from '../../lib/auto-paths.ts'
import { readState, writeState } from '../../lib/auto-state.ts'
import { CLAUDE_HOME_ENV, judgeFingerprint, judgeRules, launcherPaths } from '../../lib/setup-automation.ts'
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
        rule('r5', { global: { issue: `${LEARN_PLUGIN_REPO}#3`, prNotified: false, draft: null } }),
        rule('r6', { global: { issue: '', prNotified: true, draft: null } }),
        rule('r8', { global: { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } } }),
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

test('LN23 公開の依頼で publishGlobal が Ready・slack-thread・judge-learning を付けて Issue を作り、規則に Issue の key を残して知らせを足す。issueRepo が null なら Issue を作らず global-hint を足す', () => {
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
    assert.equal(publishGlobal('main', config, 'r1', AT, log), true)
    const calls = f.calls()
    // 足りないラベルは作る（judge-learning・slack-thread・ステータス）
    for (const name of [LEARN_LABEL, 'slack-thread', 'Ready', 'Backlog'])
      assert.ok(calls.includes(`label create ${name} --repo ${LEARN_PLUGIN_REPO}`), name)
    const creates = issueCreates(f)
    assert.equal(creates.length, 1, calls)
    const create = creates[0] ?? ''
    assert.ok(create.includes(`--repo ${LEARN_PLUGIN_REPO}`))
    assert.ok(create.includes('--label Ready --label slack-thread --label judge-learning'), create)
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false, draft: null })
    const notices = readNotices('main')
    assert.equal(notices.length, 2)
    assert.equal(notices[1]?.repo, APP)
    assert.deepEqual(notices[1]?.items, [
      {
        n: 1,
        kind: 'global-issue',
        ruleId: 'r1',
        direction: 'auto',
        text: TITLE,
        evidence: [],
        url: ISSUE_URL,
        body: '',
      },
    ])
    // 出した規則と様子見の規則は下書きも作らない。公開済み・下書きの無い規則は公開しない
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    proposeGlobal('main', config, { ruleId: 'r2', title: TITLE, body: BODY }, AT, log)
    proposeGlobal('main', config, { ruleId: 'r9', title: TITLE, body: BODY }, AT, log)
    // 公開した 1 行と、捨てた案の 3 行
    assert.equal(lines.length, 4, lines.join('\n'))
    lines.length = 0
    assert.equal(publishGlobal('main', config, 'r1', AT, log), false)
    assert.equal(publishGlobal('main', config, 'r2', AT, log), false)
    assert.equal(publishGlobal('main', config, 'r9', AT, log), false)
    assert.equal(issueCreates(f).length, 1)
    assert.equal(ruleOf('r2')?.global, null)

    // issueRepo が null なら Issue を作らず、全体に効きそうな学びとして知らせるだけ
    writeStore('main', store([rule('r1')]))
    writeFileSync(join(f.gh, 'calls.log'), '')
    proposeGlobal('main', withLearn(f.config(), null), { ruleId: 'r1', title: TITLE, body: BODY }, AT, log)
    assert.equal(f.calls(), '')
    assert.deepEqual(ruleOf('r1')?.global, { issue: '', prNotified: true, draft: null })
    assert.deepEqual(readNotices('main').at(-1)?.items, [
      { n: 1, kind: 'global-hint', ruleId: 'r1', direction: 'auto', text: TITLE, evidence: [], url: '', body: '' },
    ])
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN23b judge-apply は global の案を受け取り、Issue は作らずに下書きを残す', () => {
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
    assert.equal(issueCreates(f).length, 0)
    assert.deepEqual(ruleOf('r1')?.global, { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } })
    // 形の合わない案は 1 行出して捨てる
    f.put(file, { decisions: [], learn: [{ kind: 'global', ruleId: 'r1' }] })
    const bad = f.cli('judge-apply', '--file', file)
    assert.equal(bad.status, 0, bad.stderr)
    assert.match(bad.stderr, /学びの案を捨てました: global/)
    assert.equal(issueCreates(f).length, 0)
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
    assert.deepEqual(globalProblems(TITLE, BODY, repos, LEARN_PLUGIN_REPO), [])
    const cases: Array<[string, string]> = [
      [TITLE, `${BODY} Seen in acme/app.`],
      ['app の修正', BODY],
      [TITLE, `${BODY} See #41.`],
      [TITLE, `${BODY} https://example.com`],
      ['ACME/APP wording', BODY],
      ['ＡＰＰ の修正', BODY],
      [TITLE, `${BODY} See ＃４１.`],
      [TITLE, `${BODY} ｈｔｔｐｓ://example.com`],
      [TITLE, `${BODY} http://example.com`],
      ['', BODY],
      [TITLE, ''],
      ['x'.repeat(LEARN_GLOBAL_TITLE_MAX + 1), BODY],
      [TITLE, 'x'.repeat(LEARN_GLOBAL_BODY_MAX + 1)],
      // 表示では見えない文字（ゼロ幅・タグ文字・向きの制御・制御文字・私用）と題の改行
      [TITLE, `${BODY} a\u200bb`],
      [TITLE, `${BODY} \u{E0041}\u{E0042}`],
      [`${TITLE}\u202e`, BODY],
      [TITLE, `${BODY}\u001b[2J`],
      [TITLE, `${BODY}\t`],
      [TITLE, `${BODY} \ue000`],
      [`${TITLE}\nsecond`, BODY],
      // 題は 1 行。本文の行の区切りは \n だけ
      [`${TITLE}\u2028second`, BODY],
      [`${TITLE}\u2029second`, BODY],
      [TITLE, `${BODY}\r\nSecond.`],
      [TITLE, `${BODY}\u2028Second.`],
      [TITLE, `${BODY}\u2029Second.`],
      [TITLE, `${BODY}\u0085Second.`],
    ]
    for (const [title, body] of cases) {
      assert.ok(globalProblems(title, body, repos, LEARN_PLUGIN_REPO).length > 0, `${title} / ${body}`)
      writeStore('main', store([rule('r1')]))
      const lines: string[] = []
      proposeGlobal('main', config, { ruleId: 'r1', title, body }, AT, (line) => {
        lines.push(line)
      })
      assert.equal(issueCreates(f).length, 0, `${title} / ${body}`)
      assert.equal(lines.length, 1, lines.join('\n'))
      assert.equal(ruleOf('r1')?.global, null)
    }
    // 名前の見方。理由の行は掛かった名前を言う
    const named = (title: string, body: string, names: string[], issueRepo: string | null = null): string[] =>
      globalProblems(title, body, names, issueRepo)
    const hit = (name: string): string[] => [`題か本文に設定にあるリポジトリの名前があります: ${name}`]
    // 4 文字以下で - も _ も無い名前は語として見る（- と _ は境目）
    assert.deepEqual(named(TITLE, `${BODY} Apply the ratio.`, ['acme/app', 'acme/io']), [])
    assert.deepEqual(named(TITLE, `${BODY} Seen in my-app.`, ['acme/app']), hit('app'))
    assert.deepEqual(named('app の修正', BODY, ['acme/app']), hit('app'))
    assert.deepEqual(named('ＡＰＰ の修正', BODY, ['acme/app']), hit('app'))
    assert.deepEqual(named(TITLE, `${BODY} Seen in acme/app.`, ['acme/app']), hit('acme/app app'))
    // 長い名前と - か _ を含む名前は部分一致で断る（漏らさない向き）
    for (const [text, names] of [
      ['my-secret-repo', 'secret-repo'],
      ['secret-repos', 'secret-repo'],
      ['acme/secret-repo-server', 'acme/secret-repo secret-repo'],
    ])
      assert.deepEqual(named(TITLE, `${BODY} ${text}`, ['acme/secret-repo']), hit(names ?? ''), text)
    assert.deepEqual(named(TITLE, `${BODY} billings`, ['acme/billing']), hit('billing'))
    // 本文に書かせる auto-judge.md のパスの中だけなら断らない。パスの外なら断る
    assert.ok(BODY.includes('skills/orca-team-dispatch-task/references/auto-judge.md'))
    for (const repo of ['acme/dispatch', 'acme/task', 'acme/orca', 'acme/auto'])
      assert.deepEqual(named(TITLE, BODY, [repo]), [], repo)
    assert.deepEqual(
      named(TITLE, `${BODY} Also skills/orca-team-dispatch-task/references/auto-judge-ja.md.`, ['acme/dispatch']),
      [],
    )
    assert.deepEqual(named(TITLE, `${BODY} Stop dispatching early.`, ['acme/dispatch']), hit('dispatch'))
    // 決まった文字列にくっつけた非公開の名前は隠れない
    const path = 'skills/orca-team-dispatch-task/references/auto-judge.md'
    for (const [text, repo, issueRepo] of [
      [`private-${path}`, 'acme/private-skills', null],
      [`${path}foo`, 'acme/mdfoo', null],
      [`${path}-notes`, 'acme/md-notes', null],
      ['yui-cc-plugins-fork', 'acme/yui-cc-plugins-fork', LEARN_PLUGIN_REPO],
      ['my-yui-cc-plugins', 'acme/my-yui-cc-plugins', LEARN_PLUGIN_REPO],
    ] as const) {
      const bare = repo.slice(repo.indexOf('/') + 1)
      assert.deepEqual(named(TITLE, `${BODY} ${text}`, [repo, LEARN_PLUGIN_REPO], issueRepo), hit(bare), text)
    }
    // 短い名前を決まった文字列にじかにくっつけても隠れない（決まった文字列の端も語の境目）。apply は今も通す
    const glued = ['acme/app', LEARN_PLUGIN_REPO]
    for (const entry of [
      path,
      'skills/orca-team-dispatch-task/references/auto-judge-ja.md',
      LEARN_PLUGIN_REPO,
      'yui-cc-plugins',
    ]) {
      for (const text of [`${entry}app`, `app${entry}`, `${entry}app${entry}`])
        assert.deepEqual(named(TITLE, `${BODY} ${text}`, glued, LEARN_PLUGIN_REPO), hit('app'), text)
      for (const text of [`${entry}apply`, `apply${entry}`, `${entry} apply`, `apply ${entry}`])
        assert.deepEqual(named(TITLE, `${BODY} ${text}`, glued, LEARN_PLUGIN_REPO), [], text)
    }
    // Issue を出す先は、設定の拾う元にあっても名前を書いてよい
    const withPlugin = [APP, LEARN_PLUGIN_REPO]
    assert.deepEqual(named(TITLE, `${BODY} Change it in yui-cc-plugins.`, withPlugin, LEARN_PLUGIN_REPO), [])
    assert.deepEqual(named(TITLE, `${BODY} Change it in yui-cc-plugins.`, withPlugin, null), hit('yui-cc-plugins'))
    // #数字と URL は全角も断る
    assert.deepEqual(named(TITLE, `${BODY} #41`, []), ['題か本文に # と数字の並びがあります'])
    assert.deepEqual(named(TITLE, `${BODY} ＃４１`, []), ['題か本文に # と数字の並びがあります'])
    assert.deepEqual(named(TITLE, `${BODY} https://example.com`, []), ['題か本文に URL があります'])
    assert.deepEqual(named(TITLE, `${BODY} ｈｔｔｐｓ://example.com`, []), ['題か本文に URL があります'])
    // 設定から外したリポジトリの規則でも、そのリポジトリ名は出さない
    writeStore('main', store([rule('r1', { repo: 'gone/secret-repo' })]))
    const lines: string[] = []
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: `${BODY} Seen in secret-repo.` }, AT, (line) => {
      lines.push(line)
    })
    assert.equal(issueCreates(f).length, 0)
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.equal(ruleOf('r1')?.global, null)
    // 本文の改行は通る
    assert.deepEqual(globalProblems(TITLE, `${BODY}\n\nSecond.\nThird.`, repos, LEARN_PLUGIN_REPO), [])
    // 長さちょうどは通る
    assert.deepEqual(
      globalProblems('x'.repeat(LEARN_GLOBAL_TITLE_MAX), 'x'.repeat(LEARN_GLOBAL_BODY_MAX), repos, LEARN_PLUGIN_REPO),
      [],
    )
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
      writeStore('main', store([rule('r1', { global: { issue: i.key, prNotified: false, draft: null } })]))
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
        { n: 1, kind: 'global-pr', ruleId: 'r1', direction: 'auto', text: '題', evidence: [], url: prUrl, body: '' },
      ])
      assert.deepEqual(ruleOf('r1')?.global, { issue: i.key, prNotified: true, draft: null })
      f.cli('tick')
      assert.equal(notices().length, 1)
    } finally {
      f.cleanup()
    }
  }
})

// 下書きを作り、その global-draft の知らせの id を返す
const draftOf = (config: AutoConfig, ruleId: string): number => {
  proposeGlobal('main', config, { ruleId, title: TITLE, body: BODY }, AT, (line) => assert.fail(line))
  const notice = readNotices('main').at(-1)
  assert.equal(notice?.items[0]?.kind, 'global-draft')
  return notice?.id ?? 0
}
// 規則の new の知らせを足し、その id を返す
const newNoticeOf = (ruleId: string): number => {
  const current = readStore('main')
  const notice = appendNotice(
    'main',
    current,
    APP,
    [{ kind: 'new', ruleId, direction: 'auto', text: `規則 ${ruleId}`, evidence: [], url: '', body: '' }],
    AT,
  )
  writeStore('main', current)
  return notice.id
}
const APPROVER = 'UAPPROVER1'
const request = (noticeId: number, ruleId: string, action?: 'cancel' | 'publish') => ({
  noticeId,
  n: 1,
  ruleId,
  at: AT,
  ...(action === undefined ? {} : { action }),
  ...(action === 'publish' ? { user: APPROVER } : {}),
})
// fixture の intake の設定（intake.json）の親フォルダが intake のホーム
const writeRequests = (f: ReturnType<typeof fixture>, requests: object[]): void =>
  writeFileSync(join(f.dir, LEARN_CANCELS_FILE), JSON.stringify({ version: 1, cancels: requests }))
const kinds = (): string[] => readNotices('main').flatMap((notice) => notice.items.map((item) => item.kind))

test('LN26 proposeGlobal は issueRepo があっても Issue を作らず、下書きと global-draft の知らせ（題と本文）を残す', () => {
  const f = fixture()
  const quiet = mock.method(console, 'log', () => {})
  try {
    writeStore('main', store([rule('r1')]))
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    const lines: string[] = []
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, (line) => {
      lines.push(line)
    })
    // gh を一度も呼ばない（公開リポジトリにラベルも作らない）
    assert.equal(f.calls(), '')
    assert.equal(lines.length, 0)
    assert.deepEqual(ruleOf('r1')?.global, { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } })
    assert.deepEqual(
      readNotices('main').map((notice) => notice.items),
      [
        [
          {
            n: 1,
            kind: 'global-draft',
            ruleId: 'r1',
            direction: 'auto',
            text: TITLE,
            evidence: [],
            url: '',
            body: BODY,
          },
        ],
      ],
    )
    // 下書きのある規則はもう候補でない
    proposeGlobal('main', config, { ruleId: 'r1', title: TITLE, body: BODY }, AT, (line) => {
      lines.push(line)
    })
    assert.equal(lines.length, 1)
    assert.equal(readNotices('main').length, 1)
    // 前の版のファイル（draft の無い global・body の無い知らせ）も読める
    const rulesFile = join(learnDir('main'), LEARN_FILES.rules)
    const noticesFile = join(learnDir('main'), LEARN_FILES.notices)
    const oldRule = { ...rule('r1'), global: { issue: `${LEARN_PLUGIN_REPO}#1`, prNotified: true } }
    writeFileSync(rulesFile, JSON.stringify({ version: 1, nextRule: 2, nextNotice: 2, rules: [oldRule] }))
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#1`, prNotified: true, draft: null })
    const oldItem = { n: 1, kind: 'new', ruleId: 'r1', direction: 'auto', text: 't', evidence: [], url: '' }
    writeFileSync(
      noticesFile,
      JSON.stringify({ version: 1, notices: [{ id: 1, repo: APP, at: AT, items: [oldItem] }] }),
    )
    assert.equal(readNotices('main')[0]?.items[0]?.body, '')
    // あるのに形が違う値は読めない
    const badRule = { ...oldRule, global: { issue: '', prNotified: false, draft: { title: 1, body: 'x' } } }
    writeFileSync(rulesFile, JSON.stringify({ version: 1, nextRule: 2, nextNotice: 2, rules: [badRule] }))
    assert.throws(() => readStore('main'))
    const badItem = { ...oldItem, body: 1 }
    writeFileSync(
      noticesFile,
      JSON.stringify({ version: 1, notices: [{ id: 1, repo: APP, at: AT, items: [badItem] }] }),
    )
    assert.throws(() => readNotices('main'))
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN27 公開の依頼で publishGlobal が Issue を作り、下書きを消して global-issue の知らせを足す。同じ依頼を 2 回読んでも Issue は 1 つ', () => {
  const f = fixture()
  const quiet = mock.method(console, 'log', () => {})
  try {
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    writeStore('main', store([rule('r1'), rule('r2'), rule('r3')]))
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    const draft = draftOf(config, 'r1')
    const r2 = newNoticeOf('r2')
    const r3 = newNoticeOf('r3')
    // 知らせの本文が今の下書きと違う公開の依頼（別の名前の知らせなど）は、gh を呼ばずに無視する
    const stored = readStore('main')
    const target = stored.rules.find((entry) => entry.id === 'r1')
    assert.ok(target?.global)
    target.global.draft = { title: TITLE, body: `${BODY} Changed.` }
    writeStore('main', stored)
    writeRequests(f, [request(draft, 'r1', 'publish')])
    assert.equal(
      applyCancels('main', config, [f.dir], AT, (line) => assert.fail(line)),
      0,
    )
    assert.equal(f.calls(), '')
    target.global.draft = { title: TITLE, body: BODY }
    writeStore('main', stored)
    // r1 の下書きの公開と r2 の取り消し（取り下げ）。下書きでない項目を指す公開（r3）は無視する
    writeRequests(f, [request(draft, 'r1', 'publish'), request(r2, 'r2'), request(r3, 'r3', 'publish')])
    const lines: string[] = []
    const log = (line: string) => {
      lines.push(line)
    }
    assert.equal(applyCancels('main', config, [f.dir], AT, log), 1)
    assert.equal(issueCreates(f).length, 1)
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false, draft: null })
    assert.equal(ruleOf('r2')?.status, 'withdrawn')
    assert.equal(ruleOf('r3')?.status, 'active')
    assert.equal(ruleOf('r3')?.global, null)
    // 取り下げを先に保存してから公開する（公開の保存が取り下げで消されない・知らせの id が重ならない）
    assert.deepEqual(kinds(), ['global-draft', 'new', 'new', 'withdrawn', 'global-issue'])
    const ids = readNotices('main').map((notice) => notice.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(readStore('main').nextNotice, Math.max(...ids) + 1)
    // 公開した行は承認した人の Slack の id を言う。GitHub に送る題と本文には入れない
    assert.deepEqual(lines, [`全体の学びの Issue を作りました: r1 ${LEARN_PLUGIN_REPO}#12（承認: ${APPROVER}）`])
    assert.ok(!f.calls().includes(APPROVER), f.calls())
    // 同じ依頼を読み直しても何もしない
    assert.equal(applyCancels('main', config, [f.dir], AT, log), 0)
    assert.equal(issueCreates(f).length, 1)
    assert.equal(kinds().length, 5)
    assert.equal(lines.length, 1)
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN28 公開のときにもう一度検査を掛け、落ちたら Issue を作らず下書きを捨てる。gh が失敗したら下書きを残す', () => {
  const f = fixture()
  const quiet = mock.method(console, 'log', () => {})
  try {
    writeStore('main', store([rule('r1'), rule('r2'), rule('r3')]))
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    draftOf(config, 'r1')
    draftOf(config, 'r2')
    draftOf(config, 'r3')
    const lines: string[] = []
    const log = (line: string) => {
      lines.push(line)
    }
    // 下書きのあとで設定に増えたリポジトリの名前が題にある
    const checkout = config.repos[APP]
    assert.ok(checkout)
    const grown: AutoConfig = { ...config, repos: { ...config.repos, 'acme/copy-only': checkout } }
    assert.equal(publishGlobal('main', grown, 'r1', AT, log), false)
    assert.equal(f.calls(), '')
    assert.deepEqual(ruleOf('r1')?.global, { issue: '', prNotified: true, draft: null })
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /copy-only/)
    // issueRepo を外した端末では公開せず、下書きを残す
    assert.equal(publishGlobal('main', withLearn(config, null), 'r2', AT, log), false)
    assert.equal(f.calls(), '')
    assert.deepEqual(ruleOf('r2')?.global, { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } })
    assert.equal(lines.length, 2)
    // 取り下げた規則の下書きは公開せずに捨てる
    const withdrawn = readStore('main')
    const target = withdrawn.rules.find((entry) => entry.id === 'r3')
    assert.ok(target)
    target.status = 'withdrawn'
    writeStore('main', withdrawn)
    assert.equal(publishGlobal('main', config, 'r3', AT, log), false)
    assert.equal(f.calls(), '')
    assert.deepEqual(ruleOf('r3')?.global, { issue: '', prNotified: true, draft: null })
    assert.equal(lines.length, 3)
    // gh が失敗したら下書きを残し、次の依頼でやり直せる
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    writeFileSync(join(f.gh, 'issue_create.rc'), '1')
    assert.equal(publishGlobal('main', config, 'r2', AT, log), false)
    assert.deepEqual(ruleOf('r2')?.global, { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } })
    assert.equal(lines.length, 4)
    writeFileSync(join(f.gh, 'issue_create.rc'), '0')
    assert.equal(publishGlobal('main', config, 'r2', AT, log), true)
    assert.deepEqual(ruleOf('r2')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false, draft: null })
    assert.equal(issueCreates(f).length, 2)
    // 作れたのに番号を読めないときは、下書きを捨ててやり直さない（残る公開の依頼で同じ Issue を作り続けない）
    writeStore('main', store([rule('r4')]))
    const draft4 = draftOf(config, 'r4')
    respondText(f, 'issue_create', 'created')
    writeRequests(f, [request(draft4, 'r4', 'publish')])
    lines.length = 0
    for (let round = 0; round < 2; round += 1) applyCancels('main', config, [f.dir], AT, log)
    assert.equal(issueCreates(f).length, 3)
    assert.deepEqual(ruleOf('r4')?.global, { issue: '', prNotified: true, draft: null })
    assert.equal(lines.length, 1, lines.join('\n'))
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN29 下書きへの取り消しは下書きだけを捨て、規則は有効のまま。下書きの無い規則への取り消しは今までどおり取り下げる', () => {
  const f = fixture()
  const quiet = mock.method(console, 'log', () => {})
  try {
    writeStore('main', store([rule('r1'), rule('r2'), rule('r3'), rule('r4')]))
    const config = withLearn(f.config(), LEARN_PLUGIN_REPO)
    const draft1 = draftOf(config, 'r1')
    const r2 = newNoticeOf('r2')
    const draft3 = draftOf(config, 'r3')
    // r3 は公開と取り消しの両方が来たので取り消しを採る。r4 は知らない知らせを指すので何もしない
    writeRequests(f, [
      request(draft1, 'r1', 'cancel'),
      request(r2, 'r2'),
      request(draft3, 'r3', 'publish'),
      request(draft3, 'r3', 'cancel'),
      request(99, 'r4'),
    ])
    const lines: string[] = []
    const log = (line: string) => {
      lines.push(line)
    }
    for (let round = 0; round < 2; round += 1) {
      assert.equal(applyCancels('main', config, [f.dir], AT, log), round === 0 ? 1 : 0)
      assert.equal(f.calls(), '')
      assert.deepEqual(
        readStore('main').rules.map((entry) => [entry.id, entry.status]),
        [
          ['r1', 'active'],
          ['r2', 'withdrawn'],
          ['r3', 'active'],
          ['r4', 'active'],
        ],
        `round ${round}`,
      )
      for (const id of ['r1', 'r3'])
        assert.deepEqual(ruleOf(id)?.global, { issue: '', prNotified: true, draft: null }, id)
      // 下書きを捨てても知らせは足さない
      assert.deepEqual(kinds(), ['global-draft', 'new', 'global-draft', 'withdrawn'])
      assert.deepEqual(lines, [])
    }
  } finally {
    quiet.mock.restore()
    f.cleanup()
  }
})

test('LN30 learn-publish は下書きを公開し、judgeRules と judgeFingerprint は変わらない', () => {
  const f = fixture()
  process.env[CLAUDE_HOME_ENV] = join(f.dir, 'claude')
  try {
    f.respond('label_list', [])
    respondText(f, 'issue_create', ISSUE_URL)
    f.put(f.configFile, { ...f.raw, learn: { issueRepo: LEARN_PLUGIN_REPO } })
    const config = f.config()
    const launcher = launcherPaths().launcher
    const rules = judgeRules(config, launcher)
    const before = judgeFingerprint(config)
    // 人が使うコマンドなので、判定の AI には許さない
    assert.ok(!rules.allow.some((entry) => entry.includes('learn-publish')))
    assert.ok(
      rules.allow.includes(
        `Bash(${launcher} judge-apply --name main --file ${join(autoDir('main'), AUTO_FILES.decisions)})`,
      ),
    )
    const body = `${BODY}\nSecond line.\u001b[2J`
    writeStore('main', store([rule('r1', { global: { issue: '', prNotified: false, draft: { title: TITLE, body } } })]))
    // status は下書きの題と本文を出す（制御文字は効かせない）
    const status = f.cli('status')
    assert.equal(status.status, 0, status.stderr)
    assert.ok(status.stdout.includes(TITLE), status.stdout)
    assert.ok(status.stdout.includes(BODY), status.stdout)
    assert.ok(status.stdout.includes('Second line.'), status.stdout)
    assert.ok(!status.stdout.includes('\u001b'), status.stdout)
    assert.ok(status.stdout.includes('learn-publish --name main --rule r1'), status.stdout)
    // 見えない文字のある下書きは公開のときの検査で捨てられるので、公開は普通の下書きで試す
    writeStore(
      'main',
      store([rule('r1', { global: { issue: '', prNotified: false, draft: { title: TITLE, body: BODY } } })]),
    )
    // --rule は必須
    assert.notEqual(f.cli('learn-publish').status, 0)
    assert.equal(issueCreates(f).length, 0)
    const published = f.cli('learn-publish', '--rule', 'r1')
    assert.equal(published.status, 0, published.stderr)
    assert.equal(issueCreates(f).length, 1)
    assert.deepEqual(ruleOf('r1')?.global, { issue: `${LEARN_PLUGIN_REPO}#12`, prNotified: false, draft: null })
    // 公開済みの規則はもう出さない
    assert.equal(f.cli('learn-publish', '--rule', 'r1').status, 1)
    assert.equal(issueCreates(f).length, 1)
    assert.deepEqual(judgeRules(f.config(), launcher), rules)
    assert.equal(judgeFingerprint(f.config()), before)
  } finally {
    Reflect.deleteProperty(process.env, CLAUDE_HOME_ENV)
    f.cleanup()
  }
})
