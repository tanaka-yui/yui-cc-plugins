import { autoCleanup, confirmStopped, pushBranches } from '../../lib/auto-cleanup.ts'
import { autoDir } from '../../lib/auto-paths.ts'
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
    clean: (merged = false) => autoCleanup(issue.statusDir, f.checkout, archive, 1, merged),
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
      const result = pushBranches(f.issue.statusDir, f.checkout, null)
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
        const result = autoCleanup(f.issue.statusDir, f.checkout, f.archive, 2, false, previous ? 'previous' : null)
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
