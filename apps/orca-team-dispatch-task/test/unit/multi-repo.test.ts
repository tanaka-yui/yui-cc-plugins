import { readReposFile, repoTargets, resultFileOf, roleWorktrees } from '../../lib/multi-repo.ts'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../../lib/json.ts'

const repos = [
  { repo: 'acme/api', checkout: '/api', host_repo: 'id:api', base_branch: 'origin/main', integration_branch: 'main' },
  {
    repo: 'acme/web',
    checkout: '/web',
    host_repo: 'id:web',
    base_branch: 'origin/develop',
    integration_branch: 'develop',
  },
]

test('MR1 legacy records keep an unnamed primary repository', () => {
  assert.deepEqual(
    repoTargets(
      { host_repo: 'id:api', base_branch: 'origin/main', integration_branch: 'main', repo: 'ignored' },
      '/root',
    ),
    [{ repo: '', checkout: '/root', hostRepo: 'id:api', baseBranch: 'origin/main', integrationBranch: 'main' }],
  )
})

test('MR2 repository order and per-repository checkout are preserved', () => {
  assert.deepEqual(repoTargets({ repos }, '/root'), [
    { repo: 'acme/api', checkout: '/api', hostRepo: 'id:api', baseBranch: 'origin/main', integrationBranch: 'main' },
    {
      repo: 'acme/web',
      checkout: '/web',
      hostRepo: 'id:web',
      baseBranch: 'origin/develop',
      integrationBranch: 'develop',
    },
  ])
})

test('MR3 worktrees follow targets and ignore unlisted extras', () => {
  assert.deepEqual(
    roleWorktrees(
      {
        repos,
        roles: {
          design: {
            worktree_id: 'p',
            worktree_path: '/wp',
            branch: 'p',
            extra: {
              'acme/web': { worktree_id: 's', worktree_path: '/ws', branch: 's' },
              stray: { worktree_path: '/stray', branch: 'stray' },
            },
          },
        },
      },
      '/root',
      'design',
    ),
    [
      { repo: 'acme/api', checkout: '/api', worktreeId: 'p', worktreePath: '/wp', branch: 'p', primary: true },
      { repo: 'acme/web', checkout: '/web', worktreeId: 's', worktreePath: '/ws', branch: 's', primary: false },
    ],
  )
})

test('MR4 repos files require two distinct complete entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repos-'))
  const file = join(dir, 'repos.json')
  try {
    writeFileSync(file, JSON.stringify(repos))
    assert.deepEqual(
      readReposFile(file),
      repos.map(({ repo, checkout, host_repo, base_branch }) => ({ repo, checkout, host_repo, base_branch })),
    )
    for (const value of [
      repos.slice(0, 1),
      [...repos, repos[0]],
      [repos[0], repos[0]],
      [repos[0], { ...repos[1], checkout: '' }],
      {},
    ]) {
      writeFileSync(file, JSON.stringify(value))
      assert.equal(readReposFile(file), null)
    }
    writeFileSync(file, '{')
    assert.equal(readReposFile(file), null)
    assert.equal(readReposFile(join(dir, 'missing')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MR5/5b result files separate named repositories and preserve legacy names', () => {
  assert.equal(resultFileOf('/status', null), '/status/integration-result.json')
  assert.equal(resultFileOf('/status', ''), '/status/integration-result.json')
  assert.equal(resultFileOf('/status', 'acme/web'), '/status/integration-result.acme--web.json')
})

test('MR6 corrupt repository lists never fall back to the primary', () => {
  for (const value of [{}, repos.slice(0, 1), [repos[0], { ...repos[1], integration_branch: '' }]]) {
    const workers: JsonObject = { repos: value, roles: { design: { worktree_path: '/p', branch: 'p' } } }
    assert.deepEqual(repoTargets(workers, '/root'), [])
    assert.deepEqual(roleWorktrees(workers, '/root', 'design'), [])
  }
})

test('MR7 branch-only roles remain eligible for push and branch cleanup', () => {
  assert.deepEqual(roleWorktrees({ roles: { design: { branch: 'p' } } }, '/root', 'design'), [
    { repo: '', checkout: '/root', worktreeId: '', worktreePath: '', branch: 'p', primary: true },
  ])
  assert.deepEqual(roleWorktrees({ roles: { design: {} } }, '/root', 'design'), [])
})
