import { autoDir } from '../../lib/auto-paths.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState, releaseLock, takeLock, writeState } from '../../lib/auto-state.ts'
import { resumeTransition } from '../../lib/auto-transition.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { IssueState } from '../../lib/auto-state.ts'

const setup = () => {
  const f = fixture()
  f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
  const s = readState('main')
  syncIssues(s, f.config().sources)
  writeState('main', s)
  const decision = (extra: object = {}) => [
    {
      key: 'acme/app#7',
      generation: 1,
      route: 'auto',
      targets: ['acme/app'],
      limitMinutes: 60,
      reason: '明確な修正です',
      ...extra,
    },
  ]
  const apply = (value = decision()) => {
    const file = join(f.dir, 'decisions.json')
    f.put(file, value)
    return f.cli('judge-apply', '--file', file)
  }
  return { ...f, decision, apply }
}
test('AU23 judge-list leases and publishes pending with exact decisions path', () => {
  const f = setup()
  try {
    const result = f.cli('judge-list')
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.equal(out.issues.length, 2)
    assert.equal(out.checkouts['acme/app'], f.raw.repos['acme/app'].checkout)
    assert.equal(out.decisionsFile, join(autoDir('main'), 'judge/decisions.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(autoDir('main'), 'judge/pending.json'), 'utf8')), out)
    assert.ok(readState('main').judgingSince)
  } finally {
    f.cleanup()
  }
})
test('AU24 auto queues without comments or labels; AU27 invalid rows are rejected', () => {
  const f = setup()
  try {
    for (const extra of [
      { generation: 0 },
      { limitMinutes: 241 },
      { targets: ['bad/repo'] },
      { route: 'wrong' },
      { reason: '' },
    ]) {
      const r = f.apply(f.decision(extra))
      assert.equal(r.status, 1, r.stderr)
      assert.equal(readState('main').issues['acme/app#7']?.phase, 'judging')
    }
    const result = f.apply()
    assert.equal(result.status, 0, result.stderr)
    const state = readState('main')
    assert.equal(state.issues['acme/app#7']?.phase, 'queued')
    assert.equal(state.judgingSince, null)
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})
test('AU25/AU26 two target repositories queue without engineering comments or labels', () => {
  const f = setup()
  try {
    const r = f.apply(f.decision({ targets: ['acme/app', 'other/api'] }))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'queued')
    assert.ok(!f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
  } finally {
    f.cleanup()
  }
})

test('AU103 three targets go to engineering with a comment before labeling', () => {
  const f = setup()
  try {
    const raw = {
      ...f.raw,
      repos: { ...f.raw.repos, 'third/web': { ...f.raw.repos['other/api'], checkout: join(f.dir, 'checkout3') } },
      sources: f.raw.sources.map((s, i) => (i === 0 ? { ...s, related: [...s.related, 'third/web'] } : s)),
    }
    f.put(f.configFile, raw)
    const r = f.apply(f.decision({ targets: ['acme/app', 'other/api', 'third/web'] }))
    assert.equal(r.status, 0, r.stderr)
    const calls = f.calls()
    assert.ok(calls.indexOf('issue comment') < calls.indexOf('issue edit'))
    assert.ok(calls.includes('orca-auto:ready-eng:1:judged'))
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'eng')
    assert.ok(readState('main').issues['acme/app#7']?.reason.includes('3 つ以上のリポジトリ'))
    assert.ok(calls.includes('Ready_Eng'))
  } finally {
    f.cleanup()
  }
})

test('AU103b targets deduplicate in first occurrence order before routing', () => {
  const f = setup()
  try {
    assert.equal(f.apply(f.decision({ targets: ['acme/app', 'acme/app'] })).status, 0)
    const issue = readState('main').issues['acme/app#7']
    assert.deepEqual(issue?.targets, ['acme/app'])
    assert.equal(issue?.phase, 'queued')
  } finally {
    f.cleanup()
  }
})
test('AU28 comment failure persists transition and never labels', () => {
  const f = setup()
  try {
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.apply(f.decision({ route: 'eng' }))
    assert.ok(!f.calls().includes('issue edit'))
    assert.equal(readState('main').issues['acme/app#7']?.pendingLabel?.commented, false)
  } finally {
    f.cleanup()
  }
})
test('AU29 returned feature can queue; AU29b human status prevents engineering comment', () => {
  const f = setup()
  try {
    const s = readState('main')
    const i = s.issues['acme/app#7']
    assert.ok(i)
    i.category = 'feature'
    i.returnedFromEng = true
    writeState('main', s)
    assert.equal(f.apply().status, 0)
    assert.equal(readState('main').issues[i.key]?.phase, 'queued')
    i.phase = 'judging'
    writeState('main', s)
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    f.apply(f.decision({ route: 'eng' }))
    assert.equal(readState('main').issues[i.key]?.phase, 'stopped')
    assert.ok(!f.calls().includes('issue comment'))
  } finally {
    f.cleanup()
  }
})
test('AU29c lock contention returns 3; AU29e effort is configurable', () => {
  const f = setup()
  try {
    assert.equal(takeLock('main', 10000), true)
    process.env.ORCA_AUTO_LOCK_WAIT_MS = '0'
    assert.equal(f.cli('judge-list').status, 3)
    releaseLock('main')
    assert.equal(f.cli('judge-effort').stdout.trim(), 'high')
    f.put(f.configFile, { ...f.raw, judge: { model: 'custom', effort: 'low' } })
    assert.equal(f.cli('judge-effort').stdout.trim(), 'low')
  } finally {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_LOCK_WAIT_MS')
    releaseLock('main')
    f.cleanup()
  }
})
test('AU29d stale generation decisions cannot resurrect a manually stopped issue', () => {
  const f = setup()
  try {
    const state = readState('main')
    f.respond('issue_list', [])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Pending' }] })
    syncIssues(state, f.config().sources)
    assert.equal(state.issues['acme/app#7']?.phase, 'stopped')
    f.respond('issue_list', [{ number: 7, title: '題', labels: [], updatedAt: '2026-01-01' }])
    f.respond('issue_view', { state: 'OPEN', title: '題', labels: [{ name: 'Ready' }] })
    syncIssues(state, f.config().sources)
    writeState('main', state)
    assert.equal(state.issues['acme/app#7']?.generation, 2)
    assert.equal(f.apply().status, 1)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'judging')
  } finally {
    f.cleanup()
  }
})
test('clear-start explicitly clears a persisted uncertain start and prints the old record', () => {
  const f = setup()
  try {
    const s = readState('main')
    const issue = s.issues['acme/app#7']
    assert.ok(issue)
    issue.phase = 'dispatching'
    issue.startAttempt = { at: '2026-11-13T05:00:00Z', pid: 123, host: 'host' }
    writeState('main', s)
    const result = f.cli('clear-start', '--key', issue.key)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).pid, 123)
    assert.equal(readState('main').issues[issue.key]?.startAttempt, null)
    assert.equal(f.cli('clear-start', '--key', issue.key).status, 1)
  } finally {
    f.cleanup()
  }
})

test('a non-closing pending label transition yields to a person closing the issue', () => {
  const f = setup()
  try {
    f.put(join(f.gh, 'issue_comment.rc'), 1)
    f.apply(f.decision({ route: 'eng' }))
    const state = readState('main')
    const issue = state.issues['acme/app#7']
    assert.ok(issue?.pendingLabel)
    issue.pendingLabel.commented = true
    f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [{ name: 'Ready_Eng' }] })
    assert.equal(
      resumeTransition(issue, () => writeState('main', state)),
      false,
    )
    assert.equal(issue.phase, 'stopped')
    assert.equal(issue.pendingLabel, null)
  } finally {
    f.cleanup()
  }
})

test('AU29b closed engineering candidates disappear; fresh features are forced to engineering', () => {
  for (const closed of [true, false]) {
    const f = setup()
    try {
      const state = readState('main')
      const issue = state.issues['acme/app#7']
      assert.ok(issue)
      if (!closed) {
        issue.category = 'feature'
        writeState('main', state)
      } else f.respond('issue_view', { state: 'CLOSED', title: '題', labels: [] })
      f.apply(f.decision({ route: closed ? 'eng' : 'auto' }))
      const current = readState('main').issues[issue.key]
      assert.equal(current?.phase, closed ? undefined : 'eng')
      if (!closed) assert.ok(current?.reason.includes('新機能'))
    } finally {
      f.cleanup()
    }
  }
})

test('AU131 judge-apply syncs the Project after applying decisions', () => {
  const f = setup()
  try {
    f.put(f.configFile, {
      ...f.raw,
      sources: f.raw.sources.map((s) => (s.repo === 'acme/app' ? { ...s, project: { owner: 'acme', number: 3 } } : s)),
    })
    const state = readState('main')
    state.projectSync['acme/app#7'] = { status: 'Ready', label: 'Ready' }
    writeState('main', state)
    const response = {
      data: {
        repositoryOwner: {
          projectV2: {
            id: 'PVT_1',
            field: {
              __typename: 'ProjectV2SingleSelectField',
              id: 'PVTSSF_1',
              options: [{ id: 'opt_ready-eng', name: 'Ready_Eng' }],
            },
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PVTI_7',
                  isArchived: false,
                  content: {
                    __typename: 'Issue',
                    number: 7,
                    repository: { nameWithOwner: 'acme/app' },
                    labels: { nodes: [{ name: 'from-slack' }, { name: 'Ready_Eng' }] },
                    timelineItems: { nodes: [] },
                  },
                  status: {
                    __typename: 'ProjectV2ItemFieldSingleSelectValue',
                    name: 'Ready',
                    optionId: 'opt_ready',
                    updatedAt: '2026-11-17T01:55:41Z',
                  },
                },
              ],
            },
          },
        },
      },
    }
    const hook = join(f.dir, 'project-judge.cjs')
    writeFileSync(
      hook,
      `const fs = require('node:fs'); const write = process.argv.some((a) => a.includes('updateProjectV2ItemFieldValue')); fs.writeFileSync(process.env.GH_STUB_DIR + '/api_graphql', JSON.stringify(write ? { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } } } : ${JSON.stringify(response)}));`,
    )
    f.hook('api_graphql', `exec '${process.execPath}' '${hook}' "$@"`)
    const result = f.apply(f.decision({ route: 'eng' }))
    assert.equal(result.status, 0, result.stderr)
    const calls = f.calls().split('\n')
    const read = calls.findIndex((s) => s.startsWith('api graphql'))
    const edit = calls.findIndex((s) => s.startsWith('issue edit'))
    assert.ok(edit >= 0 && read > edit)
    assert.ok(calls.some((s) => s.includes('updateProjectV2ItemFieldValue') && s.includes('option=opt_ready-eng')))
    assert.deepEqual(readState('main').projectSync['acme/app#7'], { status: 'Ready_Eng', label: 'Ready_Eng' })
  } finally {
    f.cleanup()
  }
  const absent = setup()
  try {
    assert.equal(absent.apply(absent.decision({ route: 'eng' })).status, 0)
    assert.ok(!absent.calls().includes('api graphql'))
  } finally {
    absent.cleanup()
  }
})

test('AU141 engineering recommendation adds relay allowance outside the estimate cap', () => {
  for (const review_mode of ['on', 'off'] as const) {
    const f = setup()
    try {
      f.put(f.configFile, { ...f.raw, roles: { review_mode, phase_b: review_mode } })
      const comments = join(f.dir, 'comment.txt')
      const hook = join(f.dir, 'comment-hook.cjs')
      writeFileSync(
        hook,
        "const fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(" +
          JSON.stringify(comments) +
          ",a[a.indexOf('--body')+1])",
      )
      f.hook('issue_comment', `exec '${process.execPath}' '${hook}' "$@"`)
      assert.equal(f.apply(f.decision({ route: 'eng', limitMinutes: 241 })).status, 1)
      const result = f.apply(f.decision({ route: 'eng', limitMinutes: 240 }))
      assert.equal(result.status, 0, result.stderr)
      const body = readFileSync(comments, 'utf8')
      assert.ok(
        body.includes(
          review_mode === 'on'
            ? '推奨の上限時間: 365 分（見積もり 240 分 + 取り次ぎ 125 分）'
            : '推奨の上限時間: 240 分',
        ),
      )
      if (review_mode === 'off') assert.ok(!body.includes('取り次ぎ'))
      assert.equal(readState('main').issues['acme/app#7']?.relayMinutes, 0)
    } finally {
      f.cleanup()
    }
  }
})

// acme/app の向き先を develop（普段）と main の 2 つにする。autoReady は acme/app を auto-ready の拾う元にする
const branched = (f: ReturnType<typeof setup>, autoReady = false) =>
  f.put(f.configFile, {
    ...f.raw,
    sources: f.raw.sources.map((s, i) => (i === 0 ? { ...s, autoReady } : s)),
    repos: {
      ...f.raw.repos,
      'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop', branches: ['develop', 'main'] },
    },
  })
const view = (f: ReturnType<typeof setup>, labels: string[]) =>
  f.respond('issue_view', { state: 'OPEN', title: '題', body: '本文', labels: labels.map((name) => ({ name })) })
const edit = (apply: (issue: IssueState) => void) => {
  const s = readState('main')
  const issue = s.issues['acme/app#7']
  assert.ok(issue)
  apply(issue)
  writeState('main', s)
}
const commentFile = (f: ReturnType<typeof setup>) => {
  const file = join(f.dir, 'comment.txt')
  const hook = join(f.dir, 'comment-hook.cjs')
  writeFileSync(
    hook,
    "const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(" +
      JSON.stringify(file) +
      ",a[a.indexOf('--body')+1])",
  )
  f.hook('issue_comment', `exec '${process.execPath}' '${hook}' "$@"`)
  return () => (existsSync(file) ? readFileSync(file, 'utf8') : '')
}

test('AU143 the judged base is applied per target; single-candidate targets use the default', () => {
  const f = setup()
  try {
    assert.equal(f.apply().status, 0)
    assert.deepEqual(readState('main').issues['acme/app#7']?.bases, { 'acme/app': null })
  } finally {
    f.cleanup()
  }
  const g = setup()
  try {
    branched(g)
    const result = g.apply(g.decision({ base: 'main', targets: ['acme/app', 'other/api'] }))
    assert.equal(result.status, 0, result.stderr)
    const issue = readState('main').issues['acme/app#7']
    assert.deepEqual(issue?.bases, { 'acme/app': 'main', 'other/api': null })
    assert.equal(issue?.phase, 'queued')
    assert.equal(issue?.baseAsked, false)
    assert.ok(!g.calls().includes('issue comment'))
  } finally {
    g.cleanup()
  }
})

test('AU144 ask (or an unknown base) moves a Ready issue back to Backlog with a needs-base comment', () => {
  for (const base of ['ask', 'release/9']) {
    const f = setup()
    try {
      branched(f)
      const body = commentFile(f)
      const result = f.apply(f.decision({ base }))
      assert.equal(result.status, 0, result.stderr)
      const calls = f.calls()
      assert.ok(calls.indexOf('issue comment') < calls.indexOf('issue edit'))
      assert.match(calls, /--add-label Backlog --remove-label Ready/)
      assert.ok(body().includes('`base:develop` か `base:main`'))
      assert.ok(body().includes('develop で進めます'))
      assert.ok(body().includes('orca-auto:backlog:1:needs-base'))
      const issue = readState('main').issues['acme/app#7']
      assert.equal(issue?.baseAsked, true)
      assert.equal(issue?.phase, 'judging')
      assert.equal(issue?.pendingLabel, null)
      assert.deepEqual(issue?.bases, {})
    } finally {
      f.cleanup()
    }
  }
})

test('AU145 an auto-ready issue is asked in Backlog by comment only; a failed comment asks again later', () => {
  const f = setup()
  try {
    branched(f, true)
    edit((i) => {
      i.autoReady = true
    })
    view(f, ['Backlog'])
    const body = commentFile(f)
    assert.equal(f.apply(f.decision({ base: 'ask' })).status, 0)
    assert.ok(f.calls().includes('issue comment'))
    assert.ok(!f.calls().includes('issue edit'))
    assert.ok(body().includes('orca-auto:backlog:1:needs-base'))
    const issue = readState('main').issues['acme/app#7']
    assert.equal(issue?.baseAsked, true)
    assert.equal(issue?.autoReady, true)
    assert.equal(issue?.phase, 'judging')
  } finally {
    f.cleanup()
  }
  const g = setup()
  try {
    branched(g, true)
    edit((i) => {
      i.autoReady = true
    })
    view(g, ['Backlog'])
    g.put(join(g.gh, 'issue_comment.rc'), 1)
    g.apply(g.decision({ base: 'ask' }))
    assert.equal(readState('main').issues['acme/app#7']?.baseAsked, false)
  } finally {
    g.cleanup()
  }
})

test('AU146 an asked Backlog issue returns to judging only once a base label resolves', () => {
  const f = setup()
  try {
    branched(f, true)
    const listed = () => {
      const r = f.cli('judge-list')
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(r.stdout).issues as Array<{
        key: string
        base: { labels: string[]; candidates: string[]; needed: boolean }
      }>
    }
    const fresh = listed().find((i) => i.key === 'acme/app#7')
    assert.deepEqual(fresh?.base, { labels: [], candidates: ['develop', 'main'], needed: true })
    for (const autoReady of [true, false]) {
      edit((i) => {
        Object.assign(i, { autoReady, baseAsked: true, targets: ['acme/app'], phase: 'judging', pendingLabel: null })
      })
      view(f, ['Backlog'])
      assert.ok(!listed().some((i) => i.key === 'acme/app#7'))
      view(f, ['Backlog', 'base:nope'])
      assert.ok(!listed().some((i) => i.key === 'acme/app#7'))
      view(f, ['Backlog', 'base:develop'])
      assert.deepEqual(listed().find((i) => i.key === 'acme/app#7')?.base, {
        labels: ['develop'],
        candidates: ['develop', 'main'],
        needed: false,
      })
      // 拾い直しは Backlog から Ready へ進め、autoReady は尋ねる前の値のまま
      const result = f.apply()
      assert.equal(result.status, 0, result.stderr)
      const issue = readState('main').issues['acme/app#7']
      assert.deepEqual(issue?.bases, { 'acme/app': 'develop' })
      assert.equal(issue?.phase, 'queued')
      assert.equal(issue?.autoReady, autoReady)
      assert.equal(f.calls().split('--add-label Ready --remove-label Backlog').length - 1, autoReady ? 1 : 2)
    }
  } finally {
    f.cleanup()
  }
  // auto-ready でない拾う元では、ラベルが付いても人が Ready に戻すまで待つ
  const g = setup()
  try {
    branched(g)
    edit((i) => {
      Object.assign(i, { baseAsked: true, targets: ['acme/app'] })
    })
    view(g, ['Backlog', 'base:develop'])
    const r = g.cli('judge-list')
    assert.ok(!JSON.parse(r.stdout).issues.some((i: { key: string }) => i.key === 'acme/app#7'))
  } finally {
    g.cleanup()
  }
})

test('AU167 the Ready comment of a re-picked issue says whether AI may merge it', () => {
  // [人が Ready にした Issue か, 拾う元の autoMerge, コメントが言う内容]
  for (const [autoReady, autoMerge, says] of [
    [false, false, '条件がそろえば AI が merge します。'],
    [true, false, 'PR は人が確認してから merge します。'],
    [true, true, '条件がそろえば AI が merge します。'],
  ] as const) {
    const f = setup()
    try {
      f.put(f.configFile, {
        ...f.raw,
        sources: f.raw.sources.map((s, i) =>
          i === 0 ? { ...s, autoReady: true, ...(autoMerge ? { autoMerge } : {}) } : s,
        ),
        repos: {
          ...f.raw.repos,
          'acme/app': { ...f.raw.repos['acme/app'], baseBranch: 'develop', branches: ['develop', 'main'] },
        },
      })
      edit((i) => {
        Object.assign(i, { autoReady, baseAsked: true, targets: ['acme/app'], phase: 'judging', pendingLabel: null })
      })
      view(f, ['Backlog', 'base:develop'])
      const body = commentFile(f)
      const result = f.apply()
      assert.equal(result.status, 0, result.stderr)
      assert.ok(body().includes('orca-auto:ready:1:auto-ready'), body())
      assert.ok(body().includes(says), body())
    } finally {
      f.cleanup()
    }
  }
})

test('AU148 an asked issue moved back to Ready without a label proceeds on baseBranch without asking again', () => {
  for (const base of ['ask', 'main', undefined]) {
    const f = setup()
    try {
      branched(f)
      edit((i) => {
        Object.assign(i, { baseAsked: true, targets: ['acme/app'] })
      })
      const result = f.apply(f.decision({ base }))
      assert.equal(result.status, 0, result.stderr)
      const issue = readState('main').issues['acme/app#7']
      assert.deepEqual(issue?.bases, { 'acme/app': 'develop' })
      assert.equal(issue?.phase, 'queued')
      assert.ok(!f.calls().includes('issue comment'))
    } finally {
      f.cleanup()
    }
  }
})

test('AU149 engineering decisions need no base and never ask', () => {
  const f = setup()
  try {
    branched(f)
    const result = f.apply(f.decision({ route: 'eng' }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readState('main').issues['acme/app#7']?.phase, 'eng')
    assert.ok(!f.calls().includes('needs-base'))
    assert.equal(readState('main').issues['acme/app#7']?.baseAsked, false)
  } finally {
    f.cleanup()
  }
})

test('AU150 a decision without base is discarded when the base must be judged', () => {
  const f = setup()
  try {
    branched(f)
    for (const extra of [{}, { base: 3 }]) {
      const result = f.apply(f.decision(extra))
      assert.equal(result.status, 1)
      assert.ok(result.stderr.includes('判定を破棄しました: acme/app#7'))
      const issue = readState('main').issues['acme/app#7']
      assert.equal(issue?.phase, 'judging')
      assert.deepEqual(issue?.targets, [])
    }
    // 判定の間に base ラベルが付いたら、base が無くてもラベルの向き先で進める
    view(f, ['Ready', 'base:main'])
    assert.equal(f.apply().status, 0)
    assert.deepEqual(readState('main').issues['acme/app#7']?.bases, { 'acme/app': 'main' })
  } finally {
    f.cleanup()
  }
})

test('AU152 re-applying the same ask decision leaves an asked issue waiting in Backlog', () => {
  for (const autoReady of [true, false]) {
    const f = setup()
    try {
      branched(f, autoReady)
      if (autoReady) {
        edit((i) => {
          i.autoReady = true
        })
        view(f, ['Backlog'])
      }
      const file = join(f.dir, 'decisions.json')
      f.put(file, f.decision({ base: 'ask' }))
      assert.equal(f.cli('judge-apply', '--file', file).status, 0)
      // 尋ねたあとは Backlog に居る（スタブの issue edit はラベルを書き換えないので、ここで合わせる）
      view(f, ['Backlog'])
      const before = f.calls()
      const again = f.cli('judge-apply', '--file', file)
      assert.equal(again.status, 0, again.stderr)
      const after = f.calls().slice(before.length)
      assert.ok(!after.includes('issue comment'))
      assert.ok(!after.includes('issue edit'))
      const issue = readState('main').issues['acme/app#7']
      assert.equal(issue?.phase, 'judging')
      assert.equal(issue?.baseAsked, true)
      assert.deepEqual(issue?.bases, {})
    } finally {
      f.cleanup()
    }
  }
})
