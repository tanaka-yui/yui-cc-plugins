import { roleNames } from './config.ts'

import type { AutoConfig } from './auto-config.ts'
import type { HostSpec, RepoMeasure } from './auto-hosts.ts'

export const SETUP_RESERVE_MEMORY_MB = 8192
export const SETUP_WORKTREE_MEMORY_MB = 4096
export const SETUP_WORKTREE_DISK_MB = 5120
export type WorktreeCost = { memoryMb: number; diskMb: number; source: 'measured' | 'default' }
export const SETUP_MEASURE_MARGIN = 2
export const worktreeCost = (measures: Array<RepoMeasure | null>): WorktreeCost => {
  const values = measures.filter((m): m is RepoMeasure => m !== null)
  if (!values.length) return { memoryMb: SETUP_WORKTREE_MEMORY_MB, diskMb: SETUP_WORKTREE_DISK_MB, source: 'default' }
  return {
    memoryMb: Math.max(
      SETUP_WORKTREE_MEMORY_MB,
      Math.ceil(Math.max(...values.map((m) => m.peakMemoryMb)) * SETUP_MEASURE_MARGIN),
    ),
    diskMb: Math.max(1, Math.ceil(Math.max(...values.map((m) => m.diskGrowthMb)) * SETUP_MEASURE_MARGIN)),
    source: 'measured',
  }
}
export const recommendLanes = (spec: HostSpec, cost = worktreeCost([])): number =>
  Math.max(
    1,
    Math.min(
      Math.floor((spec.memoryTotalMb - SETUP_RESERVE_MEMORY_MB) / cost.memoryMb),
      Math.floor(spec.diskFreeMb / cost.diskMb),
      spec.cpus,
    ),
  )
export const worktreesPerIssue = (roles: AutoConfig['roles'], targets: 1 | 2): number =>
  roleNames(roles.review_mode, roles.phase_b).length * targets
