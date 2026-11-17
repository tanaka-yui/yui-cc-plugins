import { autoCallErrors, beginAutoTick, endAutoTick } from '../../lib/auto-paths.ts'
import {
  AUTO_PROJECT_MAX_PAGES,
  decideProjectSync,
  type ProjectItem,
  type ProjectSyncContext,
  readProject,
  syncProjects,
} from '../../lib/auto-project.ts'
import { syncIssues } from '../../lib/auto-queue.ts'
import { readState } from '../../lib/auto-state.ts'
import { STATUS_LABELS } from '../../lib/status.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'

const snapshot = (overrides: Partial<ProjectItem> = {}): ProjectItem => ({
  itemId: 'PVTI_1',
  key: 'acme/app#1',
  repo: 'acme/app',
  number: 1,
  labels: ['from-slack', 'Backlog'],
  label: 'Backlog',
  labelAt: '2026-11-17T01:55:42Z',
  status: 'Ready',
  statusAt: '2026-11-17T01:55:41Z',
  ...overrides,
})
test('AU127 decideProjectSync follows the table', () => {
  const ready = { status: 'Ready', label: 'Ready' }
  const same = (value: string) => ({ status: value, label: value })
  assert.deepEqual(decideProjectSync(undefined, snapshot()), { action: 'setStatus', pair: same('Backlog') })
  for (const statusAt of ['2026-11-17T01:55:41Z', '2026-11-17T01:55:41.900Z'])
    assert.deepEqual(decideProjectSync(undefined, snapshot({ labelAt: '2026-11-17T01:55:41Z', statusAt })), {
      action: 'setStatus',
      pair: same('Backlog'),
    })
  for (const labelAt of ['', 'invalid'])
    assert.deepEqual(decideProjectSync(undefined, snapshot({ labelAt })), { action: 'setLabel', pair: ready })
  assert.deepEqual(decideProjectSync(undefined, snapshot({ label: 'Ready' })), { action: 'record', pair: ready })
  assert.deepEqual(decideProjectSync(ready, snapshot({ status: 'Pending', label: 'Ready' })), {
    action: 'setLabel',
    pair: same('Pending'),
  })
  assert.deepEqual(decideProjectSync(ready, snapshot({ label: 'In review' })), {
    action: 'setStatus',
    pair: same('In review'),
  })
  assert.deepEqual(decideProjectSync(ready, snapshot({ status: '' })), { action: 'skip' })
  assert.deepEqual(decideProjectSync(ready, snapshot({ label: '' })), {
    action: 'record',
    pair: { status: 'Ready', label: '' },
  })
  assert.deepEqual(decideProjectSync({ status: 'Ready', label: '' }, snapshot({ status: 'Done', label: '' })), {
    action: 'setLabel',
    pair: same('Done'),
  })
  assert.deepEqual(decideProjectSync({ status: 'Ready', label: '' }, snapshot({ label: '' })), {
    action: 'record',
    pair: { status: 'Ready', label: '' },
  })
  assert.deepEqual(decideProjectSync({ status: 'Ready', label: 'Pending' }, snapshot({ label: 'Pending' })), {
    action: 'skip',
  })
})

const ref = { owner: 'acme', number: 3 }
const item = ({
  id = 'PVTI_1',
  number = 1,
  repo = 'acme/app',
  labels = ['from-slack', 'Ready'],
  timeline = [] as Array<{ name: string; at: string; removed?: boolean }>,
  status = 'Ready',
  statusAt = '2026-11-17T01:55:41Z',
  archived = false,
} = {}) => ({
  id,
  isArchived: archived,
  content: {
    __typename: 'Issue',
    number,
    repository: { nameWithOwner: repo },
    labels: { nodes: labels.map((name) => ({ name })) },
    timelineItems: {
      nodes: timeline.map((e) => ({
        __typename: e.removed ? 'UnlabeledEvent' : 'LabeledEvent',
        createdAt: e.at,
        label: { name: e.name },
      })),
    },
  },
  status: status
    ? { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: status, optionId: 'opt_status', updatedAt: statusAt }
    : null,
})
const page = (
  nodes: Json[],
  {
    hasNextPage = false,
    endCursor = null as string | null,
    options = [{ id: 'opt_todo', name: 'Todo' }, ...STATUS_LABELS.map((s) => ({ id: `opt_${s.slug}`, name: s.name }))],
  } = {},
) => ({
  data: {
    repositoryOwner: {
      projectV2: {
        id: 'PVT_1',
        field: { __typename: 'ProjectV2SingleSelectField', id: 'PVTSSF_1', options },
        items: { pageInfo: { hasNextPage, endCursor }, nodes },
      },
    },
  },
})
const strip = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '__typename')
        .map(([key, v]) => [key, strip(v)]),
    )
  return value
}
const projectStub = (
  f: ReturnType<typeof fixture>,
  pages: Json[],
  { writeRc = 0, readDelayMs = 0, writeDelayMs = 0 } = {},
) => {
  const pagesFile = join(f.dir, 'project-pages.json')
  f.put(pagesFile, pages)
  const script = join(f.dir, 'project-stub.cjs')
  writeFileSync(
    script,
    `
const { readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const write = args.some((a) => a.includes('updateProjectV2ItemFieldValue'))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, write ? ${writeDelayMs} : ${readDelayMs})
const target = join(process.env.GH_STUB_DIR, 'api_graphql')
if (write) {
  writeFileSync(target, JSON.stringify({data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:(args.find((a) => a.startsWith('item=')) || '').slice(5)}}}}))
  writeFileSync(target + '.rc', String(${writeRc}))
} else {
  const pages = JSON.parse(readFileSync(${JSON.stringify(pagesFile)}, 'utf8'))
  const after = args.find((a) => a.startsWith('after=c'))
  const index = after ? Number(after.slice(7)) : 0
  writeFileSync(target, JSON.stringify(pages[Math.min(index, pages.length - 1)]))
  rmSync(target + '.rc', { force: true })
}
`,
  )
  f.hook('api_graphql', `exec '${process.execPath}' '${script}' "$@"`)
  return { pagesFile }
}
test('AU128 readProject reads items, labels and times', () => {
  const f = fixture()
  try {
    const first = page(
      [
        item({
          status: 'ready',
          timeline: [
            { name: 'Backlog', at: '2026-11-17T01:00:00Z' },
            { name: 'Backlog', at: '2026-11-17T01:00:05Z', removed: true },
            { name: 'Ready', at: '2026-11-17T01:00:04Z' },
            { name: 'from-slack', at: '2026-11-17T01:10:00Z' },
          ],
        }),
        item({ number: 2, labels: ['Ready'] }),
        item({ number: 3, archived: true }),
        item({ number: 4, repo: 'zzz/other' }),
        { id: 'DRAFT', content: { __typename: 'DraftIssue' }, status: null },
        { id: 'NULL', content: null, status: null },
      ],
      {
        options: [
          { id: 'todo', name: 'Todo' },
          { id: 'progress', name: 'in progress' },
          { id: 'done', name: 'Done' },
          { id: 'duplicate', name: 'DONE' },
        ],
      },
    )
    f.respond('api_graphql', first)
    const result = readProject(ref, ['acme/app'])
    assert.deepEqual(result, {
      projectId: 'PVT_1',
      fieldId: 'PVTSSF_1',
      options: { 'In progress': 'progress', Done: 'done' },
      items: [
        {
          itemId: 'PVTI_1',
          key: 'acme/app#1',
          repo: 'acme/app',
          number: 1,
          labels: ['from-slack', 'Ready'],
          label: 'Ready',
          labelAt: '2026-11-17T01:00:05Z',
          status: 'Ready',
          statusAt: '2026-11-17T01:55:41Z',
        },
      ],
    })
    const call = f.calls().split('\n')[0] ?? ''
    assert.ok(call.startsWith('api graphql --raw-field'))
    for (const word of [
      'owner=acme',
      '--field number=3',
      'isArchived',
      'nameWithOwner',
      'timelineItems',
      'LABELED_EVENT',
      'fieldValueByName',
      'updatedAt',
      'optionId',
      'endCursor',
      'options',
    ])
      assert.ok(call.includes(word), word)
    f.respond('api_graphql', strip(first))
    assert.deepEqual(readProject(ref, ['acme/app']), result)
  } finally {
    f.cleanup()
  }
  const f2 = fixture()
  try {
    projectStub(f2, [page([item()], { hasNextPage: true, endCursor: 'c1' }), page([item({ number: 5 })])])
    const result = readProject(ref, ['acme/app'])
    assert.ok('items' in result)
    assert.deepEqual(
      result.items.map((i) => i.number),
      [1, 5],
    )
    assert.ok(f2.calls().split('\n')[1]?.includes('after=c1'))
  } finally {
    f2.cleanup()
  }
  const f3 = fixture()
  try {
    projectStub(f3, [page([], { hasNextPage: true, endCursor: 'c1' })])
    assert.deepEqual(readProject(ref, ['acme/app']), { error: '項目が 1000 件を超えています', outOfBudget: false })
    assert.equal(f3.calls().trim().split('\n').length, AUTO_PROJECT_MAX_PAGES)
  } finally {
    f3.cleanup()
  }
})
test('AU128b repository names match case-insensitively and keep the configured spelling', () => {
  const f = fixture()
  try {
    f.respond('api_graphql', page([item({ repo: 'Acme/App' })]))
    const result = readProject(ref, ['acme/app'])
    assert.ok('items' in result)
    assert.equal(result.items[0]?.key, 'acme/app#1')
    assert.equal(result.items[0]?.repo, 'acme/app')
  } finally {
    f.cleanup()
  }
})
test('AU128c unreadable projects return an error', () => {
  const cases: Array<{ response: Json; rc?: number; stderr?: string; error: string }> = [
    {
      rc: 1,
      response: {
        errors: [
          {
            type: 'INSUFFICIENT_SCOPES',
            message: 'Your token has not been granted the required scopes to execute this query.',
          },
        ],
      },
      stderr: 'gh: Your token has not been granted the required scopes to execute this query.',
      error: 'gh に project の権限がありません。gh auth refresh -s project を実行してください',
    },
    {
      rc: 1,
      response: {
        data: { repositoryOwner: { projectV2: null } },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repositoryOwner', 'projectV2'],
            message: 'Could not resolve to a ProjectV2 with the number 3.',
          },
        ],
      },
      stderr: 'gh: Could not resolve to a ProjectV2 with the number 3.',
      error: 'Could not resolve to a ProjectV2 with the number 3.',
    },
    { response: { data: { repositoryOwner: null } }, error: 'Project が見つかりません' },
    {
      response: { data: { repositoryOwner: { projectV2: { id: 'PVT_1', field: null } } } },
      error: '単一選択の Status 欄がありません',
    },
    { response: 'not json', error: '応答を読めません' },
    { response: { errors: [{ message: 'GraphQL failure' }] }, error: 'GraphQL failure' },
    { response: { errors: [{}] }, error: 'GraphQL のエラー' },
    { response: page([], { hasNextPage: true }), error: 'ページの続きを読めません' },
  ]
  for (const c of cases) {
    const f = fixture()
    try {
      if (typeof c.response === 'string') writeFileSync(join(f.gh, 'api_graphql'), c.response)
      else f.respond('api_graphql', c.response)
      if (c.rc) f.put(join(f.gh, 'api_graphql.rc'), c.rc)
      if (c.stderr) f.hook('api_graphql', `printf '%s\\n' '${c.stderr}' >&2`)
      assert.deepEqual(readProject(ref, ['acme/app']), { error: c.error, outOfBudget: false })
    } finally {
      f.cleanup()
    }
  }
})
test('AU128d a hanging project read is killed by the tick deadline and not counted', () => {
  const f = fixture()
  const old = process.env.ORCA_AUTO_CALL_CAP_MS
  try {
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    beginAutoTick(3000)
    f.hook('api_graphql', "trap '' TERM\nexec >/dev/null 2>&1\nsleep 10")
    const start = Date.now()
    assert.deepEqual(readProject(ref, ['acme/app']), { error: '期限までに読めませんでした', outOfBudget: false })
    assert.ok(Date.now() - start < 5000)
    assert.equal(autoCallErrors(), 0)
  } finally {
    endAutoTick()
    if (old === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = old
    f.cleanup()
  }
})

const context = (f: ReturnType<typeof fixture>) => {
  const lines: string[] = []
  let saves = 0
  const ctx: ProjectSyncContext = {
    sources: f.config().sources.map((s) => ({ ...s, project: s.repo === 'acme/app' ? ref : null })),
    state: readState('main'),
    save: () => {
      saves++
    },
    log: (line) => lines.push(line),
    failed: new Set(),
    touched: new Set(),
  }
  return { ctx, lines, saves: () => saves }
}
test('AU129 syncProjects writes labels and Status and records pairs', () => {
  const f = fixture()
  try {
    const { ctx, lines, saves } = context(f)
    ctx.state.projectSync['acme/app#1'] = { status: 'In progress', label: 'In progress' }
    f.respond('api_graphql', page([item({ labels: ['from-slack', 'Ready', 'In progress'], status: 'Pending' })]))
    syncProjects(ctx)
    assert.ok(
      f
        .calls()
        .includes('issue edit 1 --repo acme/app --add-label Pending --remove-label Ready --remove-label In\\ progress'),
    )
    assert.deepEqual(ctx.state.projectSync['acme/app#1'], { status: 'Pending', label: 'Pending' })
    assert.equal(saves(), 1)
    syncProjects(ctx)
    assert.equal(
      f
        .calls()
        .split('\n')
        .filter((s) => s.startsWith('issue edit')).length,
      1,
    )
    assert.ok(!f.calls().includes('updateProjectV2ItemFieldValue'))
    assert.deepEqual(lines, [])
  } finally {
    f.cleanup()
  }
  for (const writeRc of [0, 1]) {
    const f = fixture()
    try {
      const { ctx, lines } = context(f)
      const prev = { status: 'Ready', label: 'Ready' }
      ctx.state.projectSync['acme/app#1'] = prev
      projectStub(f, [page([item({ labels: ['from-slack', 'In review'] })])], { writeRc })
      syncProjects(ctx)
      for (const arg of [
        'updateProjectV2ItemFieldValue',
        'project=PVT_1',
        'item=PVTI_1',
        'field=PVTSSF_1',
        'option=opt_in-review',
      ])
        assert.ok(f.calls().includes(arg), arg)
      assert.deepEqual(
        ctx.state.projectSync['acme/app#1'],
        writeRc ? prev : { status: 'In review', label: 'In review' },
      )
      assert.equal(lines.length, writeRc)
      if (writeRc) assert.ok(lines[0]?.includes('acme/app#1 → In review'))
      syncProjects(ctx)
      assert.equal(
        f
          .calls()
          .split('\n')
          .filter((s) => s.includes('updateProjectV2ItemFieldValue')).length,
        1,
      )
      assert.equal(lines.length, writeRc)
      if (writeRc) {
        syncProjects({ ...ctx, failed: new Set(), touched: new Set() })
        assert.equal(
          f
            .calls()
            .split('\n')
            .filter((s) => s.includes('updateProjectV2ItemFieldValue')).length,
          2,
        )
      }
    } finally {
      f.cleanup()
    }
  }
  const recorded = fixture()
  try {
    const { ctx, lines, saves } = context(recorded)
    const { pagesFile } = projectStub(recorded, [page([item()])])
    syncProjects(ctx)
    assert.equal(saves(), 1)
    syncProjects(ctx)
    assert.equal(saves(), 1)
    assert.ok(!recorded.calls().includes('updateProjectV2ItemFieldValue'))
    recorded.put(pagesFile, [page([item({ labels: ['from-slack', 'In progress'] })])])
    syncProjects(ctx)
    assert.ok(recorded.calls().includes('option=opt_in-progress'))
    assert.deepEqual(ctx.state.projectSync['acme/app#1'], { status: 'In progress', label: 'In progress' })
    assert.deepEqual(lines, [])
  } finally {
    recorded.cleanup()
  }
  const missing = fixture()
  try {
    const { ctx, lines } = context(missing)
    const prev = { status: 'Ready', label: 'Ready' }
    ctx.state.projectSync['acme/app#1'] = prev
    missing.respond(
      'api_graphql',
      page([item({ labels: ['from-slack', 'In review'] })], { options: [{ id: 'ready', name: 'Ready' }] }),
    )
    syncProjects(ctx)
    syncProjects(ctx)
    assert.deepEqual(ctx.state.projectSync['acme/app#1'], prev)
    assert.ok(!missing.calls().includes('updateProjectV2ItemFieldValue'))
    assert.ok(!missing.calls().includes('issue edit'))
    assert.deepEqual(lines, ['Project の Status に「In review」の選択肢がありません: acme/app#1'])
  } finally {
    missing.cleanup()
  }
  const pending = fixture()
  try {
    const { ctx } = context(pending)
    pending.respond('issue_list', [{ number: 1, title: '題', labels: [], updatedAt: '2026-01-01' }])
    syncIssues(ctx.state, ctx.sources)
    const issue = ctx.state.issues['acme/app#1']
    assert.ok(issue)
    issue.pendingLabel = {
      event: 'judged',
      from: 'Ready',
      to: 'Ready_Eng',
      close: false,
      body: '',
      commented: false,
      labeled: false,
      // biome-ignore lint/suspicious/noThenProperty: 状態ファイルの遷移先の欄
      then: 'eng',
    }
    pending.respond('api_graphql', page([item({ status: 'Pending' })]))
    syncProjects(ctx)
    assert.ok(!pending.calls().includes('issue edit'))
    assert.ok(!pending.calls().includes('updateProjectV2ItemFieldValue'))
    assert.deepEqual(ctx.state.projectSync, {})
  } finally {
    pending.cleanup()
  }
  const ignored = fixture()
  try {
    const { ctx, saves } = context(ignored)
    ctx.state.projectSync['acme/app#1'] = { status: 'Ready', label: 'Ready' }
    ignored.respond('api_graphql', page([item({ status: 'Todo', labels: ['from-slack', 'Pending'] })]))
    syncProjects(ctx)
    assert.deepEqual(ctx.state.projectSync['acme/app#1'], { status: 'Ready', label: 'Ready' })
    assert.equal(saves(), 0)
    assert.ok(!ignored.calls().includes('issue edit'))
    assert.ok(!ignored.calls().includes('updateProjectV2ItemFieldValue'))
  } finally {
    ignored.cleanup()
  }
  const shared = fixture()
  try {
    const { ctx } = context(shared)
    ctx.sources = ctx.sources.map((s) => ({ ...s, project: ref }))
    shared.respond('api_graphql', page([item(), item({ number: 2, repo: 'other/api' })]))
    syncProjects(ctx)
    assert.equal(shared.calls().trim().split('\n').length, 1)
    assert.deepEqual(ctx.state.projectSync, {
      'acme/app#1': { status: 'Ready', label: 'Ready' },
      'other/api#2': { status: 'Ready', label: 'Ready' },
    })
  } finally {
    shared.cleanup()
  }
  const unreadable = fixture()
  try {
    const { ctx, lines } = context(unreadable)
    ctx.sources = ctx.sources.map((s) => ({ ...s, project: ref }))
    unreadable.respond('api_graphql', {})
    unreadable.put(join(unreadable.gh, 'api_graphql.rc'), 1)
    syncProjects(ctx)
    syncProjects(ctx)
    assert.equal(unreadable.calls().trim().split('\n').length, 1)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]?.startsWith('Project を読めません: acme/3'))
    assert.ok(ctx.failed.has('acme/3'))
  } finally {
    unreadable.cleanup()
  }
  const absent = fixture()
  try {
    const { ctx } = context(absent)
    ctx.sources = absent.config().sources
    syncProjects(ctx)
    assert.equal(absent.calls(), '')
  } finally {
    absent.cleanup()
  }
  for (const malformed of [false, true]) {
    const f = fixture()
    try {
      const { ctx, lines } = context(f)
      const prev = { status: 'Ready', label: 'Ready' }
      ctx.state.projectSync['acme/app#1'] = prev
      if (malformed) {
        f.respond('api_graphql', page([item({ labels: ['from-slack', 'In review'] })]))
      } else {
        f.respond('api_graphql', page([item({ status: 'Pending' })]))
        f.put(join(f.gh, 'issue_edit.rc'), 1)
      }
      syncProjects(ctx)
      syncProjects(ctx)
      assert.deepEqual(ctx.state.projectSync['acme/app#1'], prev)
      assert.equal(lines.length, 1)
      assert.ok(lines[0]?.includes('acme/app#1'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU129b syncProjects stops writing when the budget runs out', () => {
  const f = fixture()
  const old = process.env.ORCA_AUTO_CALL_CAP_MS
  try {
    const { ctx, lines } = context(f)
    process.env.ORCA_AUTO_CALL_CAP_MS = '2000'
    projectStub(f, [page([item({ status: 'Pending' })])], { readDelayMs: 1500 })
    beginAutoTick(3000)
    syncProjects(ctx)
    assert.ok(f.calls().startsWith('api graphql'))
    assert.ok(!f.calls().includes('issue edit'))
    assert.deepEqual(ctx.state.projectSync, {})
    assert.deepEqual(lines, [])
  } finally {
    endAutoTick()
    if (old === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = old
    f.cleanup()
  }
})
test('AU129c a slow Status write is not killed by the read deadline', () => {
  const f = fixture()
  const old = process.env.ORCA_AUTO_CALL_CAP_MS
  try {
    const { ctx, lines } = context(f)
    ctx.state.projectSync['acme/app#1'] = { status: 'Ready', label: 'Ready' }
    process.env.ORCA_AUTO_CALL_CAP_MS = '1000'
    projectStub(f, [page([item({ labels: ['from-slack', 'In review'] })])], { writeDelayMs: 1500 })
    beginAutoTick(10000)
    syncProjects(ctx)
    assert.deepEqual(ctx.state.projectSync['acme/app#1'], { status: 'In review', label: 'In review' })
    assert.deepEqual(lines, [])
  } finally {
    endAutoTick()
    if (old === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = old
    f.cleanup()
  }
})
test('AU129d syncProjects stops before the next page when the budget runs out', () => {
  const f = fixture()
  const old = process.env.ORCA_AUTO_CALL_CAP_MS
  try {
    const { ctx, lines } = context(f)
    process.env.ORCA_AUTO_CALL_CAP_MS = '2000'
    projectStub(f, [page([item({ status: 'Pending' })], { hasNextPage: true, endCursor: 'c1' })], { readDelayMs: 1500 })
    beginAutoTick(3000)
    syncProjects(ctx)
    assert.equal(f.calls().trim().split('\n').length, 1)
    assert.ok(!f.calls().includes('issue edit'))
    assert.ok(!f.calls().includes('updateProjectV2ItemFieldValue'))
    assert.deepEqual(ctx.state.projectSync, {})
    assert.deepEqual(lines, [])
    assert.equal(ctx.failed.size, 0)
    assert.equal(autoCallErrors(), 1)
  } finally {
    endAutoTick()
    if (old === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_CALL_CAP_MS')
    else process.env.ORCA_AUTO_CALL_CAP_MS = old
    f.cleanup()
  }
})
