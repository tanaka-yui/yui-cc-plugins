import { readState, writeState } from '../../lib/auto-state.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../../lib/json.ts'

const pr = { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' }
const check = (status = 'COMPLETED', conclusion = 'SUCCESS') => ({
  __typename: 'CheckRun',
  name: 'ci',
  status,
  conclusion,
})
test('AU50 auto merges, then comments, labels and closes; PR helper never receives --issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    const r = f.cli('tick')
    assert.equal(r.status, 1, r.stderr)
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    const c = f.calls()
    assert.ok(c.includes('pr merge 101 --repo acme/app --squash'))
    assert.ok(c.indexOf('pr merge') < c.indexOf('issue comment'))
    assert.ok(c.indexOf('issue comment') < c.indexOf('issue edit'))
    assert.ok(c.indexOf('issue edit') < c.indexOf('issue close'))
    assert.ok(f.childCalls().includes('orca-pr.ts'))
    assert.ok(!f.childCalls().includes('"--issue"'))
  } finally {
    f.cleanup()
  }
})
for (const [id, extra, repo, checks] of [
  ['AU51', { decisions: ['422 にした'] }, {}, [check()]],
  ['AU52', {}, {}, [check('COMPLETED', 'FAILURE')]],
  ['AU54', {}, { infra: true }, [check()]],
  ['AU55', null, {}, [check()]],
  ['unverified', {}, { verified: false }, [check()]],
  ['verify failure', { verify: { passed: false, ran: ['node --test'] } }, {}, [check()]],
  ['review findings', { review: { unresolved: ['未解消'], declined: ['不採用'] } }, {}, [check()]],
] as const)
  test(`${id} routes uncertain work to review`, () => {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      if (extra !== null) f.result(i, extra)
      f.put(f.configFile, { ...f.raw, repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], ...repo } } })
      f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [...checks] })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review')
      assert.ok(!f.calls().includes('pr merge'))
      assert.ok(f.calls().includes('orca-auto:in-review:1:needs-review'))
    } finally {
      f.cleanup()
    }
  })
test('AU52/AU53 pending CI and expected but absent CI wait; missing CI eventually requests review', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [check('IN_PROGRESS', '')] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    assert.ok(!f.calls().includes('issue comment'))
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU53 no-CI repository merges; AU56 merge method falls back to merge commit', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.put(f.configFile, { ...f.raw, repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], ci: false } } })
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [] })
    f.respond('repo_view', { squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('--merge'))
  } finally {
    f.cleanup()
  }
})
test('AU50b already merged PR is completed without another merge command', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', { ...pr, state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})
test('AU51b StatusContext pending and failure are recognized; failure outranks pending', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.respond('pr_view', {
      ...pr,
      state: 'OPEN',
      mergedAt: null,
      statusCheckRollup: [{ __typename: 'StatusContext', context: 'build', state: 'PENDING' }],
    })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    f.respond('pr_view', {
      ...pr,
      state: 'OPEN',
      mergedAt: null,
      statusCheckRollup: [
        check('IN_PROGRESS', ''),
        { __typename: 'StatusContext', context: 'build', state: 'FAILURE' },
      ],
    })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU55b PR creation retries, then reports integration-result reason after 30 minutes', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i)
    f.childRc('orca-pr', 1)
    f.put(join(i.statusDir, 'integration-result.json'), { reason: '変更コミットがありません' })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'finishing')
    process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})
test('AU57 human merge of the current generation PR closes the issue', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('review')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.prs = [pr]
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In review' }] })
    f.respond('pr_view', { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('orca-auto:done:1:human-merged'))
  } finally {
    f.cleanup()
  }
})
test('AU57b review respects human close and status changes without comments', () => {
  for (const closed of [true, false]) {
    const f = runtimeFixture()
    try {
      const i = f.track('review')
      f.respond('issue_view', { state: closed ? 'CLOSED' : 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, closed ? undefined : 'stopped')
      assert.ok(!f.calls().includes('issue comment'))
    } finally {
      f.cleanup()
    }
  }
})

test('a human label change immediately after merge never resurrects the merged branch', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track('finishing')
    f.result(issue)
    f.git('-C', f.checkout, 'checkout', issue.branch)
    writeFileSync(join(f.checkout, 'merged-change'), 'x')
    f.git('-C', f.checkout, 'add', 'merged-change')
    f.git('-C', f.checkout, 'commit', '-m', 'merged change')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.hook(
      'pr_merge',
      `printf '%s' '${JSON.stringify({ state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })}' > '${f.gh}/issue_view'\nprintf '%s' '${JSON.stringify({ ...pr, state: 'MERGED', mergedAt: '2026-11-13T05:30:00Z', statusCheckRollup: [] })}' > '${f.gh}/pr_view'`,
    )
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'stopped')
    assert.equal(f.git('--git-dir', join(f.dir, 'origin.git'), 'branch', '--list', issue.branch), '')
  } finally {
    f.cleanup()
  }
})

test('AU86/87/86b fetch only remote integration branches before PR creation, retry missing branches for 30 minutes', () => {
  for (const mode of ['remote', 'missing', 'local']) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i)
      if (mode !== 'local') {
        const s = readState('main')
        const current = s.issues[i.key]
        assert.ok(current)
        current.host = 'env-1'
        writeState('main', s)
        f.put(join(i.statusDir, 'workers.json'), {
          transport: 'mail',
          integration_branch: 'main',
          integration_role: 'design',
          roles: {
            design: {
              dispatch: 'ctx_design',
              branch: i.branch,
              environment: 'env-1',
              worktree_path: '/remote/worktree',
            },
          },
        })
        f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
        if (mode === 'remote') f.git('-C', f.checkout, 'push', 'origin', i.branch)
        f.git('-C', f.checkout, 'branch', '-D', i.branch)
      } else
        f.put(join(i.statusDir, 'workers.json'), {
          transport: 'mail',
          integration_branch: 'main',
          integration_role: 'design',
          roles: { design: { dispatch: 'ctx_design', branch: i.branch } },
        })
      f.cli('tick')
      assert.equal(f.childCalls().includes('orca-pr.ts'), mode !== 'missing')
      if (mode === 'remote')
        assert.equal(f.git('-C', f.checkout, 'rev-parse', i.branch), f.git('-C', f.checkout, 'rev-parse', 'main'))
      if (mode === 'missing') {
        process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
        f.cli('tick')
        assert.equal(readState('main').issues[i.key]?.phase, 'review')
        assert.ok(f.calls().includes('origin'))
        assert.ok(!f.childCalls().includes('orca-pr.ts'))
      }
    } finally {
      f.cleanup()
    }
  }
})
test('AU89 failed remote work without an origin branch never claims a successful push', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('running')
    const s = readState('main')
    const current = s.issues[i.key]
    assert.ok(current)
    current.host = 'env-1'
    current.failReason = '実装が失敗しました'
    writeState('main', s)
    f.put(join(i.statusDir, 'workers.json'), {
      transport: 'mail',
      integration_branch: 'main',
      integration_role: 'design',
      roles: { design: { dispatch: 'ctx_design', branch: i.branch, environment: 'env-1' } },
    })
    f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [{ dispatchId: 'ctx_design', resource: null, projection: { liveness: { verdict: 'exited' } } }],
        },
      },
      f.orca,
    )
    f.cli('tick')
    const comments = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
    assert.ok(!comments.includes('push 済み'))
    assert.equal(readState('main').issues[i.key]?.phase, 'failed')
  } finally {
    f.cleanup()
  }
})
test('AU94-94e planning reviews and structured decisions independently prevent automatic merge', () => {
  for (const mode of ['needs_work', 'missing-review', 'approved', 'declined', 'decision', 'missing-result']) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i)
      mkdirSync(join(i.statusDir, 'review'), { recursive: true })
      f.put(join(i.statusDir, 'workers.json'), {
        transport: 'mail',
        integration_branch: 'main',
        integration_role: 'exec',
        roles: {
          exec: { dispatch: 'ctx_design', branch: i.branch },
          design_review: { dispatch: 'ctx_plan' },
          exec_review: { dispatch: 'ctx_code' },
        },
      })
      writeFileSync(join(i.statusDir, 'review/code-round-1-findings.md'), 'VERDICT: approved\n')
      if (mode !== 'missing-review') {
        writeFileSync(join(i.statusDir, 'review/plan-round-1-findings.md'), 'VERDICT: needs_work\n')
        if (mode !== 'needs_work')
          writeFileSync(join(i.statusDir, 'review/plan-round-2-findings.md'), 'VERDICT: approved\n')
      }
      if (mode !== 'missing-result')
        f.put(join(i.statusDir, 'plan-result.json'), {
          decisions: mode === 'decision' ? ['計画の判断'] : [],
          review: { unresolved: [], declined: mode === 'declined' ? ['採用しない理由'] : [] },
        })
      f.cli('tick')
      const expected = mode === 'approved' ? 'done' : 'review'
      assert.equal(readState('main').issues[i.key]?.phase, expected, mode)
      assert.equal(f.calls().includes('pr merge'), mode === 'approved', mode)
      if (mode !== 'approved') {
        const comments = readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')
        const text =
          mode === 'needs_work'
            ? '計画のレビューが承認で終わっていません'
            : mode === 'missing-review'
              ? '計画のレビューの結果がありません'
              : mode === 'declined'
                ? '計画で採らなかった指摘:'
                : mode === 'decision'
                  ? '計画で決めた点:'
                  : '計画の結果の報告が読めない'
        assert.ok(comments.includes(text), mode)
      }
    } finally {
      f.cleanup()
    }
  }
})

const multiView = (repo: string, number: number, extra: JsonObject = {}): JsonObject => ({
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  state: 'OPEN',
  mergedAt: null,
  statusCheckRollup: [check()],
  mergeable: 'MERGEABLE',
  ...extra,
})
const multiFinish = () => {
  const f = runtimeFixture()
  const issue = f.trackMulti('finishing')
  f.put(f.configFile, {
    ...f.raw,
    lanes: 2,
    repos: { ...f.raw.repos, 'other/api': { ...f.raw.repos['other/api'], verified: true } },
  })
  f.result(issue)
  f.prViews({ 'other/api': multiView('other/api', 201), 'acme/app': multiView('acme/app', 101) })
  return { f, issue }
}
const commentsOf = (f: ReturnType<typeof runtimeFixture>): string => readFileSync(join(f.dir, 'comments.jsonl'), 'utf8')

test('AU111 PR creation retries only the missing repository and saves target order', () => {
  const { f, issue } = multiFinish()
  try {
    writeFileSync(join(f.children, 'orca-pr.ts.sh'), 'case "$*" in *"--repo acme/app"*) exit 1;; esac\n')
    f.cli('tick')
    assert.deepEqual(
      readState('main').issues[issue.key]?.prs.map((p) => p.repo),
      ['other/api'],
    )
    writeFileSync(join(f.children, 'orca-pr.ts.sh'), 'exit 0\n')
    f.cli('tick')
    assert.deepEqual(
      readState('main').issues[issue.key]?.prs.map((p) => p.repo),
      ['other/api', 'acme/app'],
    )
    const calls = f
      .childCalls()
      .split('\n')
      .filter((l) => l.startsWith('orca-pr.ts'))
    assert.equal(calls.filter((l) => l.includes('"--repo","other/api"')).length, 1)
    assert.equal(calls.filter((l) => l.includes('"--repo","acme/app"')).length, 2)
  } finally {
    f.cleanup()
  }
})

test('AU112 CI waits for pending and expected checks, while no-CI repositories may have none', () => {
  for (const mode of ['pending', 'expected', 'no-ci']) {
    const { f, issue } = multiFinish()
    try {
      f.prViews({
        'other/api': multiView('other/api', 201, { statusCheckRollup: [] }),
        'acme/app': multiView('acme/app', 101, {
          statusCheckRollup: mode === 'pending' ? [check('IN_PROGRESS', '')] : mode === 'expected' ? [] : [check()],
        }),
      })
      f.cli('tick')
      if (mode === 'no-ci') assert.equal(readState('main').issues[issue.key]?.phase, 'done')
      else {
        assert.equal(readState('main').issues[issue.key]?.phase, 'finishing')
        assert.ok(!f.calls().includes('pr merge'))
        if (mode === 'expected') {
          process.env.ORCA_AUTO_NOW = '2026-11-13T06:01:00Z'
          f.cli('tick')
          assert.equal(readState('main').issues[issue.key]?.phase, 'review')
          assert.ok(commentsOf(f).includes('CI が始まりません'))
        }
      }
    } finally {
      f.cleanup()
    }
  }
})

test('AU113 both PRs merge in targets order only after every mergeable read', () => {
  const { f, issue } = multiFinish()
  try {
    f.cli('tick')
    const calls = f.calls()
    const a = calls.indexOf('pr merge 201 --repo other/api')
    const b = calls.indexOf('pr merge 101 --repo acme/app')
    assert.ok(a >= 0 && b > a, calls)
    assert.ok(calls.lastIndexOf('--json mergeable') < a, calls)
    assert.ok(calls.match(/pr view.*--repo other\/api.*--json mergeable/))
    assert.ok(calls.match(/pr view.*--repo acme\/app.*--json mergeable/))
    assert.equal(readState('main').issues[issue.key]?.phase, 'done')
    assert.ok(commentsOf(f).includes('ai-merged'))
    assert.ok(commentsOf(f).includes('other/api#201'))
    assert.ok(commentsOf(f).includes('acme/app#101'))
    assert.ok(calls.includes('issue close'))
  } finally {
    f.cleanup()
  }
})

test('AU113b conflicts block every merge and unresolved mergeability waits for another tick', () => {
  for (const mergeable of ['CONFLICTING', 'UNKNOWN', '', 'future']) {
    const { f, issue } = multiFinish()
    try {
      f.prViews({ 'other/api': multiView('other/api', 201), 'acme/app': multiView('acme/app', 101, { mergeable }) })
      f.cli('tick')
      assert.ok(!f.calls().includes('pr merge'))
      assert.equal(readState('main').issues[issue.key]?.phase, mergeable === 'CONFLICTING' ? 'review' : 'finishing')
      if (mergeable === 'CONFLICTING') assert.ok(commentsOf(f).includes('acme/app#101 が衝突しています。'))
    } finally {
      f.cleanup()
    }
  }
})

test('AU114 merge failures distinguish no merge from a partial merge', () => {
  for (const failed of ['other/api', 'acme/app']) {
    const { f, issue } = multiFinish()
    try {
      f.mergeFails([failed])
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'review')
      const body = commentsOf(f)
      if (failed === 'other/api') {
        assert.ok(body.includes('PR を merge できませんでした。'))
        assert.ok(!body.includes('partial-merge'))
        assert.ok(!f.calls().includes('pr merge 101 --repo acme/app'))
      } else {
        assert.ok(body.includes('partial-merge'))
        assert.ok(body.includes('merge 済み: [other/api#201]'))
        assert.ok(body.includes('merge できなかった PR: [acme/app#101]'))
        assert.ok(!f.calls().includes('issue close'))
      }
    } finally {
      f.cleanup()
    }
  }
})

test('AU112b/AU115 already merged PRs do not wait on CI or merge twice', () => {
  const { f, issue } = multiFinish()
  try {
    f.prViews({
      'other/api': multiView('other/api', 201, {
        state: 'MERGED',
        mergedAt: '2026-11-13',
        statusCheckRollup: [check('IN_PROGRESS', '')],
      }),
      'acme/app': multiView('acme/app', 101),
    })
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'done')
    assert.ok(!f.calls().includes('pr merge 201'))
    assert.ok(f.calls().includes('pr merge 101'))
  } finally {
    f.cleanup()
  }
})

test('AU114b a premerged later target appears only in the merged list when the first merge fails', () => {
  const { f, issue } = multiFinish()
  try {
    f.prViews({
      'other/api': multiView('other/api', 201),
      'acme/app': multiView('acme/app', 101, { state: 'MERGED', mergedAt: '2026-11-13' }),
    })
    f.mergeFails(['other/api'])
    f.cli('tick')
    const body = commentsOf(f)
    assert.ok(body.includes('partial-merge'))
    assert.ok(body.includes('merge 済み: [acme/app#101]'))
    assert.ok(body.includes('merge できなかった PR: [other/api#201]'))
    assert.ok(!body.includes('merge できなかった PR: [acme/app#101]'))
    assert.equal(readState('main').issues[issue.key]?.phase, 'review')
  } finally {
    f.cleanup()
  }
})

test('AU115b closed PRs request review immediately even when their checks are pending', () => {
  const { f, issue } = multiFinish()
  try {
    f.prViews({
      'other/api': multiView('other/api', 201, { state: 'CLOSED', statusCheckRollup: [check('IN_PROGRESS', '')] }),
      'acme/app': multiView('acme/app', 101),
    })
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'review')
    assert.ok(commentsOf(f).includes('PR が閉じられています。'))
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})

test('AU116 any target requiring verification or infrastructure review prevents automatic merging', () => {
  for (const mode of ['unverified', 'infra']) {
    const { f, issue } = multiFinish()
    try {
      f.put(f.configFile, {
        ...f.raw,
        lanes: 2,
        repos: {
          ...f.raw.repos,
          'other/api': { ...f.raw.repos['other/api'], verified: true },
          'acme/app': { ...f.raw.repos['acme/app'], verified: mode !== 'unverified', infra: mode === 'infra' },
        },
      })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'review')
      assert.ok(
        commentsOf(f).includes(mode === 'infra' ? 'インフラの変更は確認が必要です。' : '確認できないリポジトリです。'),
      )
      assert.ok(!f.calls().includes('pr merge'))
    } finally {
      f.cleanup()
    }
  }
})

const decodedCommentsOf = (f: ReturnType<typeof runtimeFixture>): string =>
  commentsOf(f)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string)
    .join('\n')

test('AU132 new decisions are recorded after an automatic merge', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i, { decisions: ['テストを test/unit に置いた'], needsReview: [] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes('AI が決めた点:'))
    assert.ok(comments.includes('テストを test/unit に置いた'))
  } finally {
    f.cleanup()
  }
})

test('AU133 explicit review points block merging and keep decisions separate', () => {
  const f = runtimeFixture()
  try {
    const i = f.track('finishing')
    f.result(i, { decisions: ['変数名を変えた'], needsReview: ['エラー時に 422 を返すと読んだ'] })
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(!f.calls().includes('pr merge'))
    const comments = decodedCommentsOf(f)
    for (const text of [
      '人の確認が要る点があります。',
      '確認してほしい点:\n- エラー時に 422 を返すと読んだ',
      'AI が決めた点:\n- 変数名を変えた',
    ])
      assert.ok(comments.includes(text), text)
  } finally {
    f.cleanup()
  }
})

test('AU134 planning decisions are records and planning review points are blockers', () => {
  for (const needsReview of [[], ['計画で読んだ点'], null]) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i, { needsReview: [] })
      mkdirSync(join(i.statusDir, 'review'), { recursive: true })
      f.put(join(i.statusDir, 'workers.json'), {
        transport: 'mail',
        integration_branch: 'main',
        integration_role: 'exec',
        roles: {
          exec: { dispatch: 'ctx_design', branch: i.branch },
          design_review: { dispatch: 'ctx_plan' },
          exec_review: { dispatch: 'ctx_code' },
        },
      })
      for (const kind of ['plan', 'code'])
        writeFileSync(join(i.statusDir, 'review', `${kind}-round-1-findings.md`), 'VERDICT: approved\n')
      f.put(join(i.statusDir, 'plan-result.json'), {
        decisions: ['計画の判断'],
        needsReview,
        review: { unresolved: [], declined: [] },
      })
      f.cli('tick')
      const merge = needsReview !== null && needsReview.length === 0
      assert.equal(readState('main').issues[i.key]?.phase, merge ? 'done' : 'review')
      assert.equal(f.calls().includes('pr merge'), merge)
      assert.ok(
        decodedCommentsOf(f).includes(
          merge
            ? '計画で決めた点: 計画の判断'
            : needsReview === null
              ? '計画の結果の報告が読めない'
              : '計画で確認が要る点: 計画で読んだ点',
        ),
      )
    } finally {
      f.cleanup()
    }
  }
})

test('AU135 unresolved and declined findings block merging in the new format', () => {
  for (const review of [
    { unresolved: ['未解消'], declined: [] },
    { unresolved: [], declined: ['不採用'] },
  ]) {
    const f = runtimeFixture()
    try {
      const i = f.track('finishing')
      f.result(i, { needsReview: [], review })
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review')
      assert.ok(!f.calls().includes('pr merge'))
      assert.ok(
        decodedCommentsOf(f).includes(
          `確認してほしい点:\n- ${review.unresolved.length ? '未解消の指摘: 未解消' : '採らなかった指摘: 不採用'}`,
        ),
      )
    } finally {
      f.cleanup()
    }
  }
})

test('AU136 partial merge comments retain new decisions', () => {
  const { f, issue } = multiFinish()
  try {
    f.result(issue, { decisions: ['記録の判断'], needsReview: [] })
    f.mergeFails(['acme/app'])
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'review')
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes('一部だけ merge しました'))
    assert.ok(comments.includes('AI が決めた点:\n- 記録の判断'))
  } finally {
    f.cleanup()
  }
})

const mergeWithBase = (baseBranch: string | null, bases: Record<string, string | null>, usedBase?: string) => {
  const f = runtimeFixture()
  const i = f.track('finishing')
  f.result(i)
  if (usedBase) {
    const file = join(i.statusDir, 'workers.json')
    f.put(file, { ...JSON.parse(readFileSync(file, 'utf8')), base_branch: usedBase })
  }
  f.put(f.configFile, {
    ...f.raw,
    repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], baseBranch } },
  })
  const s = readState('main')
  const current = s.issues[i.key]
  if (!current) throw new Error('issue')
  current.bases = bases
  writeState('main', s)
  f.cli('tick')
  return { f, i }
}

test('AU155 a base other than the configured usual one goes to review even when everything passes', () => {
  const { f, i } = mergeWithBase('develop', { 'acme/app': 'main' })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(decodedCommentsOf(f).includes('普段の向き先でない（main）への merge は人が確認します。'))
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})

test('AU157 an issue without recorded bases is judged by the base its run actually used', () => {
  const { f, i } = mergeWithBase('develop', {}, 'origin/main')
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(decodedCommentsOf(f).includes('普段の向き先でない（main）への merge は人が確認します。'))
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})

test('AU156 the usual base, a repo without baseBranch and an issue without bases still merge', () => {
  for (const [baseBranch, bases] of [
    ['develop', { 'acme/app': 'develop' }],
    ['develop', {}],
    [null, { 'acme/app': 'main' }],
    [null, {}],
  ] as const) {
    const { f, i } = mergeWithBase(baseBranch, bases)
    try {
      assert.equal(readState('main').issues[i.key]?.phase, 'done', JSON.stringify(bases))
      assert.ok(f.calls().includes('pr merge 101 --repo acme/app --squash'))
    } finally {
      f.cleanup()
    }
  }
})

// AI が Backlog から Ready にした Issue（autoReady）。拾う元の autoMerge と向き先を変えて tick を 1 回回す
const autoReadyFinish = (autoMerge: boolean, bases: Record<string, string | null>) => {
  const f = runtimeFixture()
  const i = f.track('finishing')
  f.result(i)
  f.put(f.configFile, {
    ...f.raw,
    sources: f.raw.sources.map((source, index) =>
      index === 0 ? { ...source, autoReady: true, ...(autoMerge ? { autoMerge } : {}) } : source,
    ),
    repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop' } },
  })
  const s = readState('main')
  const current = s.issues[i.key]
  if (!current) throw new Error('issue')
  current.autoReady = true
  current.bases = bases
  writeState('main', s)
  f.cli('tick')
  return { f, i }
}
const AUTO_READY_REASON = 'AI が Backlog から Ready にした Issue なので、merge の前に人が確認します。'

test('AU164 an auto-ready issue from an autoMerge source is merged by AI when every condition holds', () => {
  const { f, i } = autoReadyFinish(true, { 'acme/app': 'develop' })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('pr merge 101 --repo acme/app --squash'))
    assert.ok(!decodedCommentsOf(f).includes(AUTO_READY_REASON))
  } finally {
    f.cleanup()
  }
})

test('AU165 autoMerge does not merge into a base other than the usual one', () => {
  const { f, i } = autoReadyFinish(true, { 'acme/app': 'main' })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes('普段の向き先でない（main）への merge は人が確認します。'))
    assert.ok(!comments.includes(AUTO_READY_REASON))
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})

test('AU166 without autoMerge an auto-ready issue still stops at review with the auto-ready reason', () => {
  const { f, i } = autoReadyFinish(false, { 'acme/app': 'develop' })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(decodedCommentsOf(f).includes(AUTO_READY_REASON))
    assert.ok(!f.calls().includes('pr merge'))
  } finally {
    f.cleanup()
  }
})

const backUrl = 'https://github.com/acme/app/pull/300'
const humanMergedBackMerge = (
  bases: Record<string, string | null>,
  setup: (f: ReturnType<typeof runtimeFixture>) => void,
) => {
  const f = runtimeFixture()
  const i = f.track('review')
  f.put(f.configFile, {
    ...f.raw,
    repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop' } },
  })
  const s = readState('main')
  const current = s.issues[i.key]
  if (!current) throw new Error('issue')
  current.prs = [pr]
  current.bases = bases
  writeState('main', s)
  f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In review' }] })
  f.respond('pr_view', { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
  setup(f)
  f.cli('tick')
  return { f, i }
}

test('AU158 a human merge into a base other than the usual one opens a back PR and links it in the Done comment', () => {
  const { f, i } = humanMergedBackMerge({ 'acme/app': 'main' }, (x) => {
    x.respond('pr_list', [])
    writeFileSync(join(x.gh, 'pr_create'), `${backUrl}\n`)
  })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    const calls = f.calls()
    assert.ok(calls.includes('pr create --repo acme/app --base develop --head main'))
    assert.ok(!calls.includes('pr merge'))
    assert.ok(calls.indexOf('pr create') < calls.indexOf('issue comment'))
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes('orca-auto:done:1:human-merged'))
    assert.ok(comments.includes(`acme/app へ取り込む PR: ${backUrl}`))
  } finally {
    f.cleanup()
  }
})

test('AU159 a failed back PR still moves the issue to Done and the comment says why', () => {
  const { f, i } = humanMergedBackMerge({ 'acme/app': 'main' }, (x) => {
    x.respond('pr_list', [])
    x.hook('pr_create', "echo 'GraphQL: boom' >&2")
    writeFileSync(join(x.gh, 'pr_create.rc'), '1')
  })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(decodedCommentsOf(f).includes('acme/app へ取り込む PR を作れませんでした: GraphQL: boom'))
  } finally {
    f.cleanup()
  }
})

test('AU160 an issue merged into the usual base never looks up or opens a back PR', () => {
  for (const bases of [{ 'acme/app': 'develop' }, {}] as Array<Record<string, string | null>>) {
    const { f, i } = humanMergedBackMerge(bases, () => undefined)
    try {
      assert.equal(readState('main').issues[i.key]?.phase, 'done', JSON.stringify(bases))
      assert.ok(!f.calls().includes('pr list'))
      assert.ok(!f.calls().includes('pr create'))
      assert.ok(!decodedCommentsOf(f).includes('へ取り込む PR'))
    } finally {
      f.cleanup()
    }
  }
})

test('AU161 a PR already merged while the run was finishing also gets the back PR, reusing an open one', () => {
  const f = runtimeFixture()
  const i = f.track('finishing')
  f.result(i)
  f.put(f.configFile, {
    ...f.raw,
    repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop' } },
  })
  const s = readState('main')
  const current = s.issues[i.key]
  if (!current) throw new Error('issue')
  current.prs = [pr]
  current.bases = { 'acme/app': 'main' }
  writeState('main', s)
  f.respond('pr_view', { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z', statusCheckRollup: [] })
  f.respond('pr_list', [{ url: backUrl }])
  try {
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(!f.calls().includes('pr create'))
    assert.ok(decodedCommentsOf(f).includes(`acme/app へ取り込む PR: ${backUrl}`))
  } finally {
    f.cleanup()
  }
})

test('AU162 a two-repo human merge opens a back PR per repository even after the status directory was archived', () => {
  const f = runtimeFixture()
  const issue = f.trackMulti('review')
  const repos = Object.fromEntries(
    ['acme/app', 'other/api'].map((r) => [
      r,
      { ...f.raw.repos[r as 'acme/app'], verified: true, baseBranch: 'develop' },
    ]),
  )
  f.put(f.configFile, { ...f.raw, lanes: 2, repos })
  const s = readState('main')
  const current = s.issues[issue.key]
  if (!current) throw new Error('issue')
  current.prs = [
    { repo: 'other/api', number: 201, url: 'https://github.com/other/api/pull/201' },
    { repo: 'acme/app', number: 101, url: 'https://github.com/acme/app/pull/101' },
  ]
  current.bases = { 'other/api': 'main', 'acme/app': 'main' }
  writeState('main', s)
  rmSync(issue.statusDir, { recursive: true, force: true })
  f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'In review' }] })
  const merged = (repo: string, number: number) =>
    multiView(repo, number, { state: 'MERGED', mergedAt: '2026-11-13T05:00:00Z' })
  f.prViews({ 'other/api': merged('other/api', 201), 'acme/app': merged('acme/app', 101) })
  f.respond('pr_list', [])
  writeFileSync(join(f.gh, 'pr_create'), `${backUrl}\n`)
  try {
    f.cli('tick')
    assert.equal(readState('main').issues[issue.key]?.phase, 'done')
    const calls = f.calls()
    assert.ok(calls.includes('pr create --repo other/api --base develop --head main'))
    assert.ok(calls.includes('pr create --repo acme/app --base develop --head main'))
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes(`other/api へ取り込む PR: ${backUrl}`))
    assert.ok(comments.includes(`acme/app へ取り込む PR: ${backUrl}`))
  } finally {
    f.cleanup()
  }
})

test('AU163 a back PR call that times out defers Done to the next tick instead of recording a failure', () => {
  const { f, i } = humanMergedBackMerge({ 'acme/app': 'main' }, (x) => {
    x.hook('pr_list', "echo 'timed out' >&2")
    writeFileSync(join(x.gh, 'pr_list.rc'), '1')
  })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'review')
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('pr create'))
    rmSync(join(f.gh, 'pr_list.rc'))
    f.respond('pr_list', [{ url: backUrl }])
    f.cli('tick')
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    const comments = decodedCommentsOf(f)
    assert.ok(comments.includes(`acme/app へ取り込む PR: ${backUrl}`))
    assert.ok(!comments.includes('timed out'))
  } finally {
    f.cleanup()
  }
})

// 仕上げの関門は、記録した向き先ではなく PR の実際の向き先（baseRefName）でも判断する
const RESTRICTED_MAIN = '普段の向き先でない（main）への merge は人が確認します。'
test('AU168 a PR whose real base differs from the recorded base goes to review and is never merged', () => {
  for (const real of ['main', 'release/9']) {
    const f = runtimeFixture()
    const i = f.track('finishing')
    f.result(i)
    f.put(f.configFile, {
      ...f.raw,
      repos: { ...f.raw.repos, 'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop' } },
    })
    const s = readState('main')
    const current = s.issues[i.key]
    if (!current) throw new Error('issue')
    current.bases = { 'acme/app': 'develop' }
    writeState('main', s)
    f.respond('pr_view', { ...pr, state: 'OPEN', mergedAt: null, statusCheckRollup: [check()], baseRefName: real })
    try {
      f.cli('tick')
      assert.equal(readState('main').issues[i.key]?.phase, 'review', real)
      const comments = decodedCommentsOf(f)
      assert.ok(comments.includes(`acme/app の PR の向き先（${real}）が決めた向き先（develop）と違います。`), comments)
      assert.equal(comments.includes(RESTRICTED_MAIN), real === 'main')
      assert.ok(!f.calls().includes('pr merge'))
    } finally {
      f.cleanup()
    }
  }
})

test('AU169 a human merge whose PR really targets a non-usual base opens the back PR from that base', () => {
  const { f, i } = humanMergedBackMerge({ 'acme/app': 'develop' }, (x) => {
    x.respond('pr_view', {
      state: 'MERGED',
      mergedAt: '2026-11-13T05:00:00Z',
      statusCheckRollup: [],
      baseRefName: 'main',
    })
    x.respond('pr_list', [])
    writeFileSync(join(x.gh, 'pr_create'), `${backUrl}\n`)
  })
  try {
    assert.equal(readState('main').issues[i.key]?.phase, 'done')
    assert.ok(f.calls().includes('pr create --repo acme/app --base develop --head main'))
    assert.ok(decodedCommentsOf(f).includes(`acme/app へ取り込む PR: ${backUrl}`))
  } finally {
    f.cleanup()
  }
})

test('AU170 two repositories where only one base is restricted go to review once, without any merge', () => {
  for (const real of [undefined, 'main']) {
    const { f, issue } = multiFinish()
    try {
      const repos = Object.fromEntries(
        ['acme/app', 'other/api'].map((r) => [
          r,
          { ...f.raw.repos[r as 'acme/app'], verified: true, baseBranch: 'develop' },
        ]),
      )
      f.put(f.configFile, { ...f.raw, lanes: 2, repos })
      const s = readState('main')
      const current = s.issues[issue.key]
      if (!current) throw new Error('issue')
      current.bases = { 'other/api': real ? 'develop' : 'main', 'acme/app': 'develop' }
      writeState('main', s)
      f.prViews({
        'other/api': multiView('other/api', 201, real ? { baseRefName: real } : {}),
        'acme/app': multiView('acme/app', 101, real ? { baseRefName: 'develop' } : {}),
      })
      f.cli('tick')
      assert.equal(readState('main').issues[issue.key]?.phase, 'review', String(real))
      const comments = decodedCommentsOf(f)
      assert.equal(comments.split(RESTRICTED_MAIN).length - 1, 1, comments)
      assert.ok(!f.calls().includes('pr merge'))
    } finally {
      f.cleanup()
    }
  }
})
