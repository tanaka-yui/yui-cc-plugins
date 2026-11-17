import { roleNames } from './config.ts'

import type { AutoConfig } from './auto-config.ts'
import type { HostSpec } from './auto-hosts.ts'

export const SETUP_RESERVE_MEMORY_MB = 8192
export const SETUP_WORKTREE_MEMORY_MB = 4096
export const SETUP_WORKTREE_DISK_MB = 5120
export const recommendLanes = (spec: HostSpec): number =>
  Math.max(
    1,
    Math.min(
      Math.floor((spec.memoryTotalMb - SETUP_RESERVE_MEMORY_MB) / SETUP_WORKTREE_MEMORY_MB),
      Math.floor(spec.diskFreeMb / SETUP_WORKTREE_DISK_MB),
      spec.cpus,
    ),
  )
export const worktreesPerIssue = (roles: AutoConfig['roles'], targets: 1 | 2): number =>
  roleNames(roles.review_mode, roles.phase_b).length * targets
