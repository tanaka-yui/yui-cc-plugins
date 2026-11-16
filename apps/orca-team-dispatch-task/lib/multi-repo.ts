import { readJson } from './fs.ts'
import { asArray, asObject, asString, get, type JsonObject } from './json.ts'

import { join } from 'node:path'

export type RepoTarget = {
  repo: string
  checkout: string
  hostRepo: string
  baseBranch: string
  integrationBranch: string
}

export type RoleWorktree = {
  repo: string
  checkout: string
  worktreeId: string
  worktreePath: string
  branch: string
  primary: boolean
}

type ReposFileEntry = { repo: string; checkout: string; host_repo: string; base_branch: string }

export const repoTargets = (workers: JsonObject | null, repoRoot: string): RepoTarget[] => {
  if (!workers || !Object.hasOwn(workers, 'repos')) {
    return [
      {
        repo: '',
        checkout: repoRoot,
        hostRepo: asString(get(workers, 'host_repo')) ?? '',
        baseBranch: asString(get(workers, 'base_branch')) ?? '',
        integrationBranch: asString(get(workers, 'integration_branch')) ?? '',
      },
    ]
  }
  const repos = asArray(workers.repos)
  if (repos?.length !== 2) return []
  const targets: RepoTarget[] = []
  for (const value of repos) {
    const repo = asString(get(value, 'repo'))
    const checkout = asString(get(value, 'checkout'))
    const hostRepo = asString(get(value, 'host_repo'))
    const baseBranch = asString(get(value, 'base_branch'))
    const integrationBranch = asString(get(value, 'integration_branch'))
    if (!repo || !checkout || !hostRepo || !baseBranch || !integrationBranch || targets.some((t) => t.repo === repo))
      return []
    targets.push({ repo, checkout, hostRepo, baseBranch, integrationBranch })
  }
  return targets
}

export const roleWorktrees = (workers: JsonObject | null, repoRoot: string, role: string): RoleWorktree[] => {
  const record = asObject(get(workers, 'roles', role))
  return repoTargets(workers, repoRoot).flatMap((target, index) => {
    const worktree = index === 0 ? record : asObject(get(record, 'extra', target.repo))
    const worktreePath = asString(get(worktree, 'worktree_path')) ?? ''
    const branch = asString(get(worktree, 'branch')) ?? ''
    if (!worktreePath && !branch) return []
    return [
      {
        repo: target.repo,
        checkout: target.checkout,
        worktreeId: asString(get(worktree, 'worktree_id')) ?? '',
        worktreePath,
        branch,
        primary: index === 0,
      },
    ]
  })
}

export const readReposFile = (path: string): ReposFileEntry[] | null => {
  const repos = asArray(readJson(path))
  if (repos?.length !== 2) return null
  const entries: ReposFileEntry[] = []
  for (const value of repos) {
    const repo = asString(get(value, 'repo'))
    const checkout = asString(get(value, 'checkout'))
    const host_repo = asString(get(value, 'host_repo'))
    const base_branch = asString(get(value, 'base_branch'))
    if (!repo || !checkout || !host_repo || !base_branch || entries.some((e) => e.repo === repo)) return null
    entries.push({ repo, checkout, host_repo, base_branch })
  }
  return entries
}

export const resultFileOf = (statusDir: string, repo: string | null): string =>
  join(statusDir, repo ? `integration-result.${repo.replaceAll('/', '--')}.json` : 'integration-result.json')
