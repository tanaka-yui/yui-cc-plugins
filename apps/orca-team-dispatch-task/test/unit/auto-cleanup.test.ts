import { autoCleanup, confirmStopped, pushBranches } from '../../lib/auto-cleanup.ts'
import { autoDir } from '../../lib/auto-paths.ts'
import { prevBranchesOf } from '../../lib/auto-tick.ts'
import { readJson } from '../../lib/fs.ts'
import { asObject, get } from '../../lib/json.ts'
import { runtimeFixture } from '../lib/auto-runtime-fixture.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const row = (releaseState: string, ownershipState = 'agent_owned') => ({
  dispatchId: 'ctx_design',
  resource: { releaseState, ownershipState },
})
const setup = () => {
  const f = runtimeFixture()
  const issue = f.track('running')
  const archive = join(autoDir('main'), 'archive')
  f.respond(
    'worktree_list',
    {
      ok: true,
      result: { worktrees: [{ displayName: issue.slug, path: join(f.children, 'worktree') }], truncated: false },
    },
    f.orca,
  )
  return {
    ...f,
    issue,
    archive,
    clean: (merged = false) => autoCleanup(issue.statusDir, archive, 1, merged ? [''] : []),
  }
}
for (const field of ['follow_ups', 'superseded'])
  for (const state of ['released', 'active', 'succeeded', 'start_unknown'])
    test(`C1-2 ${field} dispatch ${state} is stopped and released before deleting its worktree`, () => {
      const f = setup()
      try {
        const file = join(f.issue.statusDir, 'workers.json')
        const w = JSON.parse(readFileSync(file, 'utf8'))
        w.roles.design[field] = ['ctx_followup']
        f.put(file, w)
        const released = [row('released'), { dispatchId: 'ctx_followup', resource: { releaseState: 'released' } }]
        f.respond(
          'orchestration_worker-list',
          {
            ok: true,
            result: {
              workers: [
                row('released'),
                {
                  dispatchId: 'ctx_followup',
                  resource: { releaseState: state === 'released' ? 'released' : 'retained' },
                },
              ],
            },
          },
          f.orca,
        )
        f.respond('orchestration_worker-show', { ok: true, result: { worker: { state } } }, f.orca)
        for (const verb of ['worker-stop', 'worker-release'])
          f.hook(
            `orchestration_${verb}`,
            `printf '%s' '${JSON.stringify({ ok: true, result: { workers: released } })}' > '${f.orca}/orchestration_worker-list'`,
            f.orca,
          )
        assert.equal(f.clean().ok, true)
        const calls = f.calls(f.orca)
        const verb = state === 'succeeded' ? 'worker-release' : 'worker-stop'
        assert.equal(calls.includes(`${verb} --dispatch ctx_followup`), state !== 'released')
        if (state !== 'released')
          assert.ok(calls.indexOf(`${verb} --dispatch ctx_followup`) < calls.indexOf('worktree rm'))
      } finally {
        f.cleanup()
      }
    })
for (const lineage of ['known', 'unrelated', 'cycle'])
  test(`C1-2 unrecorded follow-up lineage ${lineage} is ${lineage === 'known' ? 'adopted' : 'held'}`, () => {
    const f = setup()
    try {
      const rows = [row('released'), { dispatchId: 'ctx_followup', resource: { releaseState: 'retained' } }]
      f.respond('orchestration_worker-list', { ok: true, result: { workers: rows } }, f.orca)
      const parent = lineage === 'known' ? 'ctx_design' : lineage === 'cycle' ? 'ctx_followup' : 'ctx_unrelated'
      f.hook(
        'orchestration_worker-show',
        `case "$4" in
ctx_followup) printf '%s' '{"ok":true,"result":{"dispatch":{"followUpOf":"ctx_middle"},"worker":{"state":"active"}}}' ;;
ctx_middle) printf '%s' '{"ok":true,"result":{"dispatch":{"followUpOf":"${parent}"}}}' ;;
*) printf '%s' '{"ok":true,"result":{}}' ;;
esac > '${f.orca}/orchestration_worker-show'`,
        f.orca,
      )
      f.hook(
        'orchestration_worker-stop',
        `printf '%s' '${JSON.stringify({ ok: true, result: { workers: rows.map((w) => ({ ...w, resource: { releaseState: 'released' } })) } })}' > '${f.orca}/orchestration_worker-list'`,
        f.orca,
      )
      const r = f.clean()
      assert.equal(r.ok, lineage === 'known', r.reasons.join('\n'))
      const calls = f.calls(f.orca)
      assert.equal(calls.includes('worker-stop --dispatch ctx_followup'), lineage === 'known')
      assert.equal(calls.includes('worktree rm'), lineage === 'known')
      assert.equal(existsSync(f.issue.statusDir), lineage !== 'known')
      const archived = join(f.archive, `${f.issue.slug}-g1`, 'workers.json')
      if (lineage === 'known')
        assert.deepEqual(JSON.parse(readFileSync(archived, 'utf8')).roles.design.follow_ups, ['ctx_followup'])
    } finally {
      f.cleanup()
    }
  })
for (const state of ['active', 'succeeded', 'stopped'])
  test(`C1-2 user-owned follow-up ${state} retains the shared worktree`, () => {
    const f = setup()
    try {
      const file = join(f.issue.statusDir, 'workers.json')
      const w = JSON.parse(readFileSync(file, 'utf8'))
      w.roles.design.follow_ups = ['ctx_followup']
      f.put(file, w)
      f.respond(
        'orchestration_worker-list',
        {
          ok: true,
          result: {
            workers: [
              row('released'),
              {
                dispatchId: 'ctx_followup',
                resource: { releaseState: 'retained', ownershipState: 'user_owned' },
              },
            ],
          },
        },
        f.orca,
      )
      f.respond(
        'orchestration_worker-show',
        { ok: true, result: { worker: { state }, dispatch: { status: 'terminated' } } },
        f.orca,
      )
      assert.equal(f.clean().ok, state === 'succeeded')
      const calls = f.calls(f.orca)
      assert.ok(!calls.includes('worker-stop'))
      assert.ok(!calls.includes('worker-release'))
      assert.ok(!calls.includes('worktree rm'))
      assert.ok(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch))
    } finally {
      f.cleanup()
    }
  })
test('C1-2 a follow-up discovered after release prevents deletion until it too is released', () => {
  const f = setup()
  try {
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('retained')] } }, f.orca)
    f.hook(
      'orchestration_worker-show',
      `case "$4" in
ctx_design) printf '%s' '{"ok":true,"result":{"worker":{"state":"succeeded"}}}' ;;
*) printf '%s' '{"ok":true,"result":{"dispatch":{"followUpOf":"ctx_design"},"worker":{"state":"active"}}}' ;;
esac > '${f.orca}/orchestration_worker-show'`,
      f.orca,
    )
    f.hook(
      'orchestration_worker-release',
      `printf '%s' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_design","resource":{"releaseState":"released"}},{"dispatchId":"ctx_followup","resource":{"releaseState":"retained"}}]}}' > '${f.orca}/orchestration_worker-list'`,
      f.orca,
    )
    assert.equal(f.clean().ok, false)
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    f.hook(
      'orchestration_worker-stop',
      `printf '%s' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_design","resource":{"releaseState":"released"}},{"dispatchId":"ctx_followup","resource":{"releaseState":"released"}}]}}' > '${f.orca}/orchestration_worker-list'`,
      f.orca,
    )
    assert.equal(f.clean().ok, true)
    assert.ok(f.calls(f.orca).indexOf('worker-stop --dispatch ctx_followup') < f.calls(f.orca).indexOf('worktree rm'))
  } finally {
    f.cleanup()
  }
})
test('AU58/AU58b push after release proof, force-remove, delete only saved branch, then archive', () => {
  const f = setup()
  try {
    f.git('-C', f.checkout, 'checkout', f.issue.branch)
    writeFileSync(join(f.checkout, 'change'), 'x')
    f.git('-C', f.checkout, 'add', 'change')
    f.git('-C', f.checkout, 'commit', '-m', 'change')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('retained')] } }, f.orca)
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'succeeded' } } }, f.orca)
    f.hook(
      'orchestration_worker-release',
      `printf '%s' '${JSON.stringify({ ok: true, result: { workers: [row('released')] } })}' > '${f.orca}/orchestration_worker-list'`,
      f.orca,
    )
    f.hook(
      'worktree_rm',
      `git --git-dir='${f.dir}/origin.git' show-ref --verify 'refs/heads/${f.issue.branch}' > '${f.dir}/remote-proof'`,
      f.orca,
    )
    const r = f.clean()
    assert.equal(r.ok, true, r.reasons.join('\n'))
    assert.ok(readFileSync(join(f.dir, 'remote-proof'), 'utf8').includes(f.issue.branch))
    assert.ok(!existsSync(f.issue.statusDir))
    assert.ok(f.calls(f.orca).includes('--force --delete-branch'))
    assert.equal(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch), '')
  } finally {
    f.cleanup()
  }
})
for (const mode of ['stop fails', 'release stays retained', 'unreadable list'])
  test(`AU58d ${mode} never deletes or archives`, () => {
    const f = setup()
    try {
      f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('retained')] } }, f.orca)
      f.respond(
        'orchestration_worker-show',
        { ok: true, result: { worker: { state: mode === 'stop fails' ? 'active' : 'succeeded' } } },
        f.orca,
      )
      if (mode === 'stop fails') {
        f.put(join(f.orca, 'orchestration_worker-stop.rc'), 1)
        f.put(join(f.issue.statusDir, 'stopped.json'), { status: 'stopped' })
      }
      if (mode === 'unreadable list') f.put(join(f.orca, 'orchestration_worker-list.rc'), 1)
      assert.equal(f.clean().ok, false)
      assert.ok(!f.calls(f.orca).includes('worktree rm'))
      assert.ok(existsSync(f.issue.statusDir))
      rmSync(join(f.orca, 'orchestration_worker-list.rc'), { force: true })
      f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('released')] } }, f.orca)
      assert.equal(f.clean().ok, true)
    } finally {
      f.cleanup()
    }
  })
test('AU58e user-owned settled resources are retained, live user-owned workers block all deletion', () => {
  for (const state of ['active', 'succeeded']) {
    const f = setup()
    try {
      f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('retained', 'user_owned')] } }, f.orca)
      f.respond('orchestration_worker-show', { ok: true, result: { worker: { state } } }, f.orca)
      const r = f.clean()
      assert.equal(r.ok, state === 'succeeded')
      assert.ok(!f.calls(f.orca).includes('worktree rm'))
      assert.ok(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch))
      if (state === 'active') assert.ok(existsSync(f.issue.statusDir))
    } finally {
      f.cleanup()
    }
  }
})
test('AU58c merged integration branch is not pushed back to a deleted remote branch', () => {
  const f = setup()
  try {
    f.git('-C', f.checkout, 'checkout', f.issue.branch)
    writeFileSync(join(f.checkout, 'merged'), 'x')
    f.git('-C', f.checkout, 'add', 'merged')
    f.git('-C', f.checkout, 'commit', '-m', 'merged')
    f.git('-C', f.checkout, 'checkout', 'main')
    assert.equal(f.clean(true).ok, true)
    const remote = f.git('--git-dir', join(f.dir, 'origin.git'), 'branch', '--list', f.issue.branch)
    assert.equal(remote, '')
  } finally {
    f.cleanup()
  }
})
test('AU58e3 no branch is pushed until stop/release is proven', () => {
  const f = setup()
  try {
    f.git('-C', f.checkout, 'checkout', f.issue.branch)
    writeFileSync(join(f.checkout, 'last'), 'x')
    f.git('-C', f.checkout, 'add', 'last')
    f.git('-C', f.checkout, 'commit', '-m', 'last')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [row('retained')] } }, f.orca)
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
    assert.equal(confirmStopped(f.issue.statusDir).stopped, false)
    assert.equal(f.clean().ok, false)
    assert.equal(f.git('--git-dir', join(f.dir, 'origin.git'), 'branch', '--list', f.issue.branch), '')
  } finally {
    f.cleanup()
  }
})
test('AU58f push failure on a nonintegration role prevents all resource deletion even after merge', () => {
  const f = setup()
  try {
    const other = 'user/reviewer'
    f.git('-C', f.checkout, 'checkout', '-b', other)
    writeFileSync(join(f.checkout, 'review'), 'x')
    f.git('-C', f.checkout, 'add', 'review')
    f.git('-C', f.checkout, 'commit', '-m', 'review')
    f.git('-C', f.checkout, 'checkout', 'main')
    const file = join(f.issue.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.roles.design_review = { dispatch: 'ctx_review', branch: other, worktree_path: join(f.children, 'review') }
    f.put(file, w)
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: { workers: [row('released'), { dispatchId: 'ctx_review', resource: { releaseState: 'released' } }] },
      },
      f.orca,
    )
    f.git('-C', f.checkout, 'remote', 'set-url', '--push', 'origin', join(f.dir, 'missing'))
    const r = f.clean(true)
    assert.equal(r.ok, false)
    assert.equal(r.pushed, false)
    assert.ok(existsSync(f.issue.statusDir))
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    f.git('-C', f.checkout, 'remote', 'set-url', '--push', 'origin', join(f.dir, 'origin.git'))
    assert.equal(f.clean(true).ok, true)
    assert.ok(f.git('--git-dir', join(f.dir, 'origin.git'), 'branch', '--list', other))
  } finally {
    f.cleanup()
  }
})
test('AU58b unequal remote-tracking SHA retains a locally unique branch after worktree removal', () => {
  const f = setup()
  try {
    f.git('-C', f.checkout, 'checkout', f.issue.branch)
    writeFileSync(join(f.checkout, 'unique'), 'x')
    f.git('-C', f.checkout, 'add', 'unique')
    f.git('-C', f.checkout, 'commit', '-m', 'unique')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.hook(
      'worktree_rm',
      `git -C '${f.checkout}' update-ref 'refs/remotes/origin/${f.issue.branch}' origin/main`,
      f.orca,
    )
    const result = f.clean()
    assert.equal(result.ok, true)
    assert.ok(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch))
    assert.ok(result.reasons.length > 0)
  } finally {
    f.cleanup()
  }
})

test('AU58e settled user-owned role is kept while other released roles are removed', () => {
  const f = setup()
  try {
    const file = join(f.issue.statusDir, 'workers.json')
    const w = JSON.parse(readFileSync(file, 'utf8'))
    w.roles.exec = { dispatch: 'ctx_other', branch: 'user/other', worktree_path: join(f.children, 'other') }
    f.put(file, w)
    f.git('-C', f.checkout, 'branch', 'user/other')
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [row('retained', 'user_owned'), { dispatchId: 'ctx_other', resource: { releaseState: 'released' } }],
        },
      },
      f.orca,
    )
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'succeeded' } } }, f.orca)
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: {
          worktrees: [{ path: join(f.children, 'worktree') }, { path: join(f.children, 'other') }],
          truncated: false,
        },
      },
      f.orca,
    )
    assert.equal(f.clean().ok, true)
    assert.ok(!f.calls(f.orca).includes(`path:${join(f.children, 'worktree')}`))
    assert.ok(f.calls(f.orca).includes(`path:${join(f.children, 'other')}`))
    assert.ok(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch))
  } finally {
    f.cleanup()
  }
})

const remoteSetup = (role = 'design') => {
  const f = setup()
  mkdirSync(join(f.issue.statusDir, 'roles', role), { recursive: true })
  const roles = {
    [role]: {
      dispatch: 'ctx_design',
      environment: 'env-1',
      branch: f.issue.branch,
      worktree_path: join(f.children, 'worktree'),
    },
  }
  f.put(join(f.issue.statusDir, 'workers.json'), {
    transport: 'mail',
    integration_branch: 'main',
    integration_role: 'design',
    roles,
  })
  const base = f.git('-C', f.checkout, 'rev-parse', 'main')
  f.respond(
    'orchestration_worker-list',
    {
      ok: true,
      result: {
        workers: [
          {
            dispatchId: 'ctx_design',
            resource: null,
            terminalState: 'retained',
            projection: { liveness: { verdict: 'exited' } },
          },
        ],
      },
    },
    f.orca,
  )
  const remoteRow = (head: string | null) =>
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: {
          worktrees: [
            { displayName: f.issue.slug, path: join(f.children, 'worktree'), ...(head === null ? {} : { head }) },
          ],
          truncated: false,
        },
      },
      f.orca,
    )
  remoteRow(base)
  const uniqueCommit = () => {
    f.git('-C', f.checkout, 'checkout', '-b', 'scratch')
    writeFileSync(join(f.checkout, 'unique'), 'unique')
    f.git('-C', f.checkout, 'add', 'unique')
    f.git('-C', f.checkout, 'commit', '-m', 'unique')
    const sha = f.git('-C', f.checkout, 'rev-parse', 'HEAD')
    f.git('-C', f.checkout, 'checkout', 'main')
    return sha
  }
  return { ...f, base, remoteRow, uniqueCommit }
}
test('AU88/88b/88c absent remote integration branch is a failure, local and review roles retain legacy behavior', () => {
  for (const role of ['design', 'design_review', 'local']) {
    const f = remoteSetup(role === 'local' ? 'design' : role)
    try {
      f.git('-C', f.checkout, 'branch', '-D', f.issue.branch)
      if (role === 'local')
        f.put(join(f.issue.statusDir, 'workers.json'), {
          integration_branch: 'main',
          integration_role: 'design',
          roles: { design: { branch: f.issue.branch } },
        })
      const result = pushBranches(f.issue.statusDir, [])
      assert.equal(result.pushed, role !== 'design')
      if (role === 'design') assert.ok(result.reasons.join().includes('origin にもこの Mac にもありません'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU90/91 remote worktree deletion is scoped to its environment, including identical local paths', () => {
  for (const present of [true, false]) {
    const f = remoteSetup()
    try {
      f.git('-C', f.checkout, 'push', 'origin', f.issue.branch)
      if (!present)
        f.hook(
          'worktree_list',
          `case " $* " in *" --environment env-1 "*) printf '%s' '{"ok":true,"result":{"worktrees":[],"truncated":false}}' > '${f.orca}/worktree_list';; esac`,
          f.orca,
        )
      const result = f.clean()
      assert.equal(result.ok, true, result.reasons.join())
      const calls = f.calls(f.orca)
      assert.ok(calls.includes('worktree list --environment env-1'))
      assert.equal(calls.includes('worktree rm --environment env-1'), present)
      if (!present) assert.ok(result.reasons.join().includes('遠くの worktree はもうありません'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU92/92b/92d remote HEAD must be saved, including failure without acceptance and headless inventory fallback', () => {
  for (const mode of ['unsaved', 'saved', 'headless']) {
    const f = remoteSetup()
    try {
      const sha = f.uniqueCommit()
      if (mode !== 'unsaved') f.git('-C', f.checkout, 'push', 'origin', `scratch:refs/heads/${f.issue.branch}`)
      else f.git('-C', f.checkout, 'push', 'origin', f.issue.branch)
      f.remoteRow(mode === 'headless' ? null : sha)
      if (mode === 'headless') f.put(join(f.issue.statusDir, 'roles/design/completion.json'), { head: sha })
      const result = f.clean()
      assert.equal(result.ok, mode !== 'unsaved', result.reasons.join())
      assert.equal(f.calls(f.orca).includes('worktree rm'), mode !== 'unsaved')
      if (mode === 'unsaved') assert.ok(result.reasons.join().includes('保存を証明できない'))
    } finally {
      f.cleanup()
    }
  }
})
test('AU92c already removed remote worktrees do not block retry after their branches disappear', () => {
  const f = remoteSetup()
  try {
    f.git('-C', f.checkout, 'branch', '-D', f.issue.branch)
    f.respond('worktree_list', { ok: true, result: { worktrees: [], truncated: false } }, f.orca)
    const result = f.clean()
    assert.equal(result.ok, true, result.reasons.join())
    assert.ok(!existsSync(f.issue.statusDir))
  } finally {
    f.cleanup()
  }
})
test('AU92e reviewer roles may be deleted only when their HEAD is saved', () => {
  for (const saved of [true, false]) {
    const f = remoteSetup('design_review')
    try {
      f.remoteRow(saved ? f.base : f.uniqueCommit())
      const result = f.clean()
      assert.equal(result.ok, saved, result.reasons.join())
      assert.equal(f.calls(f.orca).includes('worktree rm'), saved)
    } finally {
      f.cleanup()
    }
  }
})
test('AU92f merged integration worktrees retain commits made after the accepted HEAD', () => {
  for (const same of [true, false]) {
    const f = remoteSetup()
    try {
      const sha = f.uniqueCommit()
      f.remoteRow(sha)
      f.put(join(f.issue.statusDir, 'roles/design/completion.json'), { head: same ? sha : f.base })
      const result = f.clean(true)
      assert.equal(result.ok, same, result.reasons.join())
      assert.equal(f.calls(f.orca).includes('worktree rm'), same)
    } finally {
      f.cleanup()
    }
  }
})
test('AU92g/92h previous-generation origin branch is evidence for a reset role without new commits', () => {
  for (const role of ['design', 'design_review'])
    for (const previous of [true, false]) {
      const f = remoteSetup(role)
      try {
        const sha = f.uniqueCommit()
        f.git('-C', f.checkout, 'push', 'origin', 'scratch:previous')
        f.git('-C', f.checkout, 'branch', '-D', f.issue.branch)
        f.remoteRow(sha)
        const result = autoCleanup(f.issue.statusDir, f.archive, 2, [], previous ? { '': 'previous' } : {})
        assert.equal(result.ok, previous, result.reasons.join())
        assert.equal(f.calls(f.orca).includes('worktree rm'), previous)
      } finally {
        f.cleanup()
      }
    }
})
test('AU93 remote stop evidence uses exited liveness and rejects partial host errors', () => {
  for (const verdict of ['exited', 'live', 'unverifiable', 'partial']) {
    const f = remoteSetup()
    try {
      const row = {
        dispatchId: 'ctx_design',
        resource: null,
        terminalState: 'retained',
        projection: { liveness: { verdict } },
      }
      f.respond(
        'orchestration_worker-list',
        {
          ok: true,
          result: {
            workers: [row],
            ...(verdict === 'partial' ? { partialHostErrors: [{ environmentId: 'env-1' }] } : {}),
          },
        },
        f.orca,
      )
      f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
      if (verdict === 'live')
        f.hook(
          'orchestration_worker-stop',
          `printf '%s' '${JSON.stringify({ ok: true, result: { workers: [{ ...row, projection: { liveness: { verdict: 'exited' } } }] } })}' > '${f.orca}/orchestration_worker-list'`,
          f.orca,
        )
      const result = confirmStopped(f.issue.statusDir)
      assert.equal(result.stopped, verdict === 'exited' || verdict === 'live', result.reasons.join())
      assert.ok(f.calls(f.orca).includes('--include-remote'))
      if (verdict === 'partial' || verdict === 'exited') assert.ok(!f.calls(f.orca).includes('worker-stop'))
      if (verdict === 'live') assert.ok(f.calls(f.orca).includes('worker-stop'))
    } finally {
      f.cleanup()
    }
  }
})

// 2026-11-16 の実機: worker が受理の返事を --peek で読んだまま worker_done を送り、Orca が followUp を作った。
// followUp を解放すると、元の dispatch の release は ownership_transferred で retained を返し続け、行は資源 absent のまま
for (const followUp of ['released', 'retained'])
  test(`AU102 settled dispatch without a bound resource is stopped once its follow-up is ${followUp}`, () => {
    const f = setup()
    try {
      const file = join(f.issue.statusDir, 'workers.json')
      const w = JSON.parse(readFileSync(file, 'utf8'))
      w.roles.design.follow_ups = ['ctx_followup']
      f.put(file, w)
      const original = {
        dispatchId: 'ctx_design',
        workerState: 'succeeded',
        dispatchStatus: 'completed',
        terminalState: null,
        resource: null,
        projection: { resource: { state: 'absent', reason: 'not_materialized' } },
      }
      f.respond(
        'orchestration_worker-list',
        {
          ok: true,
          result: { workers: [original, { dispatchId: 'ctx_followup', resource: { releaseState: followUp } }] },
        },
        f.orca,
      )
      f.respond(
        'orchestration_worker-show',
        { ok: true, result: { worker: { state: 'succeeded' }, dispatch: { status: 'completed' } } },
        f.orca,
      )
      f.respond(
        'orchestration_worker-release',
        { ok: true, result: { dispatchId: 'ctx_design', state: 'retained', reason: 'ownership_transferred' } },
        f.orca,
      )
      assert.equal(f.clean().ok, followUp === 'released')
      assert.equal(f.calls(f.orca).includes('worktree rm'), followUp === 'released')
    } finally {
      f.cleanup()
    }
  })
test('AU102b an unsettled dispatch without a bound resource is not proof of stopping', () => {
  const f = setup()
  try {
    f.respond(
      'orchestration_worker-list',
      {
        ok: true,
        result: {
          workers: [
            {
              dispatchId: 'ctx_design',
              dispatchStatus: 'dispatched',
              resource: null,
              projection: { resource: { state: 'absent' } },
            },
          ],
        },
      },
      f.orca,
    )
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
    assert.equal(f.clean().ok, false)
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
  } finally {
    f.cleanup()
  }
})

const multiCleanup = (remote = false) => {
  const f = runtimeFixture()
  const issue = f.trackMulti('running')
  const archive = join(autoDir('main'), 'archive')
  const workers = asObject(readJson(join(issue.statusDir, 'workers.json')))
  const role = asObject(get(workers, 'roles', 'design'))
  assert.ok(workers && role)
  if (remote) {
    role.environment = 'env-1'
    f.put(join(issue.statusDir, 'workers.json'), workers)
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
  }
  const inventory = (heads: Record<string, string> = {}) =>
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: {
          worktrees: [
            {
              displayName: issue.slug,
              path: join(f.children, 'worktree'),
              head: heads['other/api'] ?? f.git('-C', f.second(), 'rev-parse', 'main'),
            },
            {
              displayName: `${issue.slug}-extra`,
              path: join(f.children, 'worktree2'),
              head: heads['acme/app'] ?? f.git('-C', f.checkout, 'rev-parse', 'main'),
            },
          ],
          truncated: false,
        },
      },
      f.orca,
    )
  inventory()
  const commit = (checkout: string, branch: string): string => {
    f.git('-C', checkout, 'checkout', branch)
    writeFileSync(join(checkout, 'unique'), `unique ${checkout}`)
    f.git('-C', checkout, 'add', 'unique')
    f.git('-C', checkout, 'commit', '-m', 'unique')
    const head = f.git('-C', checkout, 'rev-parse', 'HEAD')
    f.git('-C', checkout, 'checkout', 'main')
    return head
  }
  const clean = (merged: string[] = []) => autoCleanup(issue.statusDir, archive, 1, merged)
  return { ...f, issue, archive, workers, role, inventory, commit, clean }
}

test('AU118 identical branch names in different repositories are both pushed from their own checkouts', () => {
  const f = multiCleanup()
  try {
    const branch = f.issue.branch
    f.git('-C', f.checkout, 'branch', '-m', f.issue.branches['acme/app'] ?? '', branch)
    const extra = asObject(get(f.role, 'extra', 'acme/app'))
    assert.ok(extra)
    extra.branch = branch
    f.put(join(f.issue.statusDir, 'workers.json'), f.workers)
    const primary = f.commit(f.second(), branch)
    const secondary = f.commit(f.checkout, branch)
    assert.equal(pushBranches(f.issue.statusDir, []).pushed, true)
    assert.ok(f.git('-C', f.second(), 'ls-remote', '--heads', 'origin', branch).startsWith(primary))
    assert.ok(f.git('-C', f.checkout, 'ls-remote', '--heads', 'origin', branch).startsWith(secondary))
  } finally {
    f.cleanup()
  }
})

test('AU118b malformed repository records block push and deletion', () => {
  const f = multiCleanup()
  try {
    f.workers.repos = []
    f.put(join(f.issue.statusDir, 'workers.json'), f.workers)
    assert.deepEqual(pushBranches(f.issue.statusDir, []), { pushed: false, reasons: ['worker の記録を読めません'] })
    assert.deepEqual(f.clean(), { ok: false, pushed: false, reasons: ['worker の記録を読めません'] })
    assert.ok(!f.calls(f.orca).includes('worktree rm'))
    assert.ok(existsSync(f.issue.statusDir))
  } finally {
    f.cleanup()
  }
})

test('AU119 remote preservation uses each repository checkout and accepted head, without a secondary legacy fallback', () => {
  const f = multiCleanup(true)
  try {
    const branch = f.issue.branches['acme/app'] ?? ''
    const head = f.commit(f.checkout, branch)
    f.git('-C', f.checkout, 'push', 'origin', branch)
    f.inventory({ 'acme/app': head })
    assert.equal(f.clean().ok, true)
    assert.equal((f.calls(f.orca).match(/worktree rm --environment env-1/g) ?? []).length, 2)
  } finally {
    f.cleanup()
  }
  for (const accepted of [true, false]) {
    const f = multiCleanup(true)
    try {
      f.git('-C', f.second(), 'branch', 'scratch-primary')
      f.git('-C', f.checkout, 'branch', 'scratch-secondary')
      const primary = f.commit(f.second(), 'scratch-primary')
      let secondary = f.commit(f.checkout, 'scratch-secondary')
      if (!accepted) {
        f.git('-C', f.checkout, 'fetch', f.second(), 'scratch-primary')
        secondary = primary
      }
      f.inventory({ 'other/api': primary, 'acme/app': secondary })
      mkdirSync(join(f.issue.statusDir, 'roles/design'), { recursive: true })
      f.put(join(f.issue.statusDir, 'roles/design/completion.json'), {
        head: primary,
        heads: { 'other/api': primary, ...(accepted ? { 'acme/app': secondary } : {}) },
      })
      const result = f.clean(['other/api', 'acme/app'])
      assert.equal(result.ok, accepted, result.reasons.join())
      assert.equal(existsSync(f.issue.statusDir), !accepted)
      assert.equal(f.calls(f.orca).includes(`path:${join(f.children, 'worktree2')}`), accepted)
      if (!accepted)
        assert.ok(result.reasons.some((r) => r.includes('保存を証明できないため遠くの worktree を残しました')))
    } finally {
      f.cleanup()
    }
  }
})

test('AU120 partial merge deletes only the merged integration branch without recreating it on origin', () => {
  for (const diverged of [false, true]) {
    const f = multiCleanup()
    try {
      f.commit(f.second(), f.issue.branch)
      const extra = f.issue.branches['acme/app'] ?? ''
      f.commit(f.checkout, extra)
      if (diverged)
        f.hook('worktree_rm', `git -C '${f.checkout}' update-ref 'refs/remotes/origin/${extra}' origin/main`, f.orca)
      const result = f.clean(['other/api'])
      assert.equal(result.ok, true, result.reasons.join())
      assert.equal(f.git('-C', f.second(), 'branch', '--list', f.issue.branch), '')
      assert.equal(f.git('-C', f.second(), 'ls-remote', '--heads', 'origin', f.issue.branch), '')
      assert.equal(Boolean(f.git('-C', f.checkout, 'branch', '--list', extra)), diverged)
      assert.equal(
        result.reasons.some((r) => r.includes('保存を証明できないためブランチを残しました')),
        diverged,
      )
    } finally {
      f.cleanup()
    }
  }
})

test('AU121 every role worktree is removed on its host while a human-owned role keeps both repositories', () => {
  for (const mode of ['local', 'remote', 'human']) {
    const f = multiCleanup(mode === 'remote')
    try {
      const roles = asObject(f.workers.roles)
      assert.ok(roles)
      roles.exec_review = {
        dispatch: 'ctx_review',
        branch: 'review',
        worktree_path: '/review-primary',
        ...(mode === 'remote' ? { environment: 'env-1' } : {}),
        extra: { 'acme/app': { worktree_path: '/review-extra', branch: 'review' } },
      }
      f.put(join(f.issue.statusDir, 'workers.json'), f.workers)
      for (const checkout of [f.second(), f.checkout]) f.git('-C', checkout, 'branch', 'review')
      f.respond(
        'orchestration_worker-list',
        {
          ok: true,
          result: {
            workers:
              mode === 'remote'
                ? [
                    { dispatchId: 'ctx_design', resource: null, projection: { liveness: { verdict: 'exited' } } },
                    { dispatchId: 'ctx_review', resource: null, projection: { liveness: { verdict: 'exited' } } },
                  ]
                : [
                    row(mode === 'human' ? 'retained' : 'released', mode === 'human' ? 'user_owned' : 'agent_owned'),
                    { dispatchId: 'ctx_review', resource: { releaseState: 'released' } },
                  ],
          },
        },
        f.orca,
      )
      f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'succeeded' } } }, f.orca)
      f.respond(
        'worktree_list',
        {
          ok: true,
          result: {
            worktrees: [
              { path: join(f.children, 'worktree'), head: f.git('-C', f.second(), 'rev-parse', 'main') },
              { path: join(f.children, 'worktree2'), head: f.git('-C', f.checkout, 'rev-parse', 'main') },
              { path: '/review-primary', head: f.git('-C', f.second(), 'rev-parse', 'main') },
              { path: '/review-extra', head: f.git('-C', f.checkout, 'rev-parse', 'main') },
            ],
            truncated: false,
          },
        },
        f.orca,
      )
      const result = f.clean()
      assert.equal(result.ok, true, result.reasons.join())
      const calls = f.calls(f.orca)
      assert.equal((calls.match(/worktree rm /g) ?? []).length, mode === 'human' ? 2 : 4)
      if (mode === 'remote') assert.equal((calls.match(/worktree rm --environment env-1 /g) ?? []).length, 4)
      if (mode === 'human') {
        assert.ok(!calls.includes(`path:${join(f.children, 'worktree')}`))
        assert.ok(!calls.includes(`path:${join(f.children, 'worktree2')}`))
      }
      assert.ok(!existsSync(f.issue.statusDir))
    } finally {
      f.cleanup()
    }
  }
})

test('AU121b an extra-only remote start never removes the identically named local path', () => {
  const f = multiCleanup(true)
  try {
    const roles = asObject(f.workers.roles)
    assert.ok(roles)
    roles.design = {
      environment: 'env-1',
      extra: { 'acme/app': { worktree_path: '/same', branch: f.issue.branches['acme/app'] ?? '' } },
    }
    f.put(join(f.issue.statusDir, 'workers.json'), f.workers)
    f.respond('orchestration_worker-list', { ok: true, result: { workers: [] } }, f.orca)
    f.respond(
      'worktree_list',
      {
        ok: true,
        result: {
          worktrees: [{ path: '/same', head: f.git('-C', f.checkout, 'rev-parse', 'main') }],
          truncated: false,
        },
      },
      f.orca,
    )
    const result = f.clean()
    assert.equal(result.ok, true, result.reasons.join())
    assert.ok(f.calls(f.orca).includes('worktree rm --environment env-1 --worktree path:/same'))
    assert.ok(!f.calls(f.orca).includes('worktree rm --worktree path:/same'))
  } finally {
    f.cleanup()
  }
})

test('AU122 legacy PR metadata never changes the unnamed repository used to skip merged branch pushes', () => {
  const f = setup()
  try {
    f.git('-C', f.checkout, 'checkout', f.issue.branch)
    writeFileSync(join(f.checkout, 'unique'), 'unique')
    f.git('-C', f.checkout, 'add', 'unique')
    f.git('-C', f.checkout, 'commit', '-m', 'unique')
    f.git('-C', f.checkout, 'checkout', 'main')
    f.put(join(f.issue.statusDir, 'integration-result.json'), {
      repo: 'acme/app',
      pr_url: 'https://github.com/acme/app/pull/1',
    })
    assert.equal(f.clean(true).ok, true)
    assert.equal(f.git('-C', f.checkout, 'ls-remote', '--heads', 'origin', f.issue.branch), '')
    assert.equal(f.git('-C', f.checkout, 'branch', '--list', f.issue.branch), '')
  } finally {
    f.cleanup()
  }
})

test('AU122b cleanup continuation evidence preserves repository identity across target changes', () => {
  const f = runtimeFixture()
  try {
    const issue = f.track()
    const cases = [
      { targets: ['acme/app'], prevTargets: [], prevBranches: {}, multi: false, want: { '': 'user/legacy' } },
      {
        targets: ['acme/app'],
        prevTargets: ['other/api'],
        prevBranches: { 'other/api': 'user/a' },
        multi: false,
        want: { '': 'user/legacy' },
      },
      {
        targets: ['acme/app'],
        prevTargets: ['other/api', 'acme/app'],
        prevBranches: { 'other/api': 'user/a', 'acme/app': 'user/b' },
        multi: false,
        want: { '': 'user/b' },
      },
      {
        targets: ['acme/app'],
        prevTargets: ['other/api', 'acme/app'],
        prevBranches: { 'other/api': 'user/a' },
        multi: false,
        want: {},
      },
      {
        targets: ['other/api', 'acme/app'],
        prevTargets: ['acme/app'],
        prevBranches: { 'acme/app': 'user/b' },
        multi: true,
        want: { 'acme/app': 'user/b' },
      },
      { targets: ['other/api', 'acme/app'], prevTargets: [], prevBranches: {}, multi: true, want: {} },
      {
        targets: ['other/api', 'acme/app'],
        prevTargets: ['other/api', 'third/web'],
        prevBranches: { 'other/api': 'user/a', 'third/web': 'user/c' },
        multi: true,
        want: { 'other/api': 'user/a' },
      },
    ]
    for (const c of cases) {
      Object.assign(issue, c, { prevBranch: 'user/legacy' })
      assert.deepEqual(prevBranchesOf(issue, c.multi), c.want)
    }
  } finally {
    f.cleanup()
  }
})

// 2026-11-17 の実機（Orca 1.4.259、Mac M2max）: 親の `worker-list --include-remote` の遠隔の行は `server` の要約だけで、
// 動作中も解放後も projection を持たない。遠隔の解放は `worker-show --dispatch <id> --environment <env>` の
// projection.liveness でしか読めない（遠隔の側では dispatch は別の Run に載るので `--run` では引けない）
for (const remote of ['exited', 'live', 'unreachable'])
  test(`AU124 a remote row without projection is stopped only when the remote worker-show says exited (${remote})`, () => {
    const f = remoteSetup()
    try {
      const summary = {
        dispatchId: 'ctx_design',
        workerState: 'succeeded',
        dispatchStatus: 'completed',
        agentTerminalHandle: null,
        terminalState: null,
        resource: null,
        server: { environmentId: 'env-1', name: 'Remote', asOf: '2026-11-16T23:30:13Z' },
      }
      f.respond('orchestration_worker-list', { ok: true, result: { workers: [summary] } }, f.orca)
      const shown = (verdict: string | null) =>
        JSON.stringify(
          verdict === null
            ? { ok: false, error: { code: 'environment_unreachable' } }
            : {
                ok: true,
                result: {
                  worker: { state: 'succeeded', stage: 'settled' },
                  dispatch: { status: 'completed' },
                  projection: { liveness: { verdict } },
                },
              },
        )
      const summaryShow = JSON.stringify({
        ok: true,
        result: {
          worker: { state: 'succeeded', stage: 'server_record' },
          dispatch: { status: 'completed' },
          projection: null,
        },
      })
      f.hook(
        'orchestration_worker-show',
        `case "$*" in
*--environment\\ env-1*) printf '%s' '${shown(remote === 'unreachable' ? null : remote)}' ;;
*) printf '%s' '${summaryShow}' ;;
esac > '${f.orca}/orchestration_worker-show'`,
        f.orca,
      )
      const result = confirmStopped(f.issue.statusDir)
      assert.equal(result.stopped, remote === 'exited', result.reasons.join())
      assert.match(f.calls(f.orca), /worker-show --dispatch ctx_design --environment env-1 /)
    } finally {
      f.cleanup()
    }
  })
