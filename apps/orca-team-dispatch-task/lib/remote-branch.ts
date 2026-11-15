import { autoRun } from './auto-paths.ts'

export const remoteHead = (repoRoot: string, branch: string): string | null => {
  const r = autoRun('git', ['-C', repoRoot, 'ls-remote', 'origin', `refs/heads/${branch}`])
  return r.rc === 0 ? r.stdout.trim().split(/\s+/)[0] || null : null
}
export const fetchBranch = (repoRoot: string, branch: string): boolean =>
  autoRun('git', ['-C', repoRoot, 'fetch', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`]).rc === 0
export const isAncestor = (repoRoot: string, sha: string, branch: string): boolean =>
  autoRun('git', ['-C', repoRoot, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).rc === 0 &&
  autoRun('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', sha, `refs/remotes/origin/${branch}`]).rc === 0
export const savedOnOrigin = (repoRoot: string, sha: string, branches: Array<string | null>): boolean =>
  !!sha && [...new Set(branches.filter((b): b is string => !!b))].some((branch) => isAncestor(repoRoot, sha, branch))
