import { listReadyManaged, type ReadyIssue, readyAtOf, viewIssue } from './auto-github.ts'
import { autoNow, canAutoCall } from './auto-paths.ts'
import { FEATURE_LABEL, PRIORITY_LABELS, STATUS } from './status.ts'

import type { AutoState, IssueState, Priority } from './auto-state.ts'

export const AUTO_TOMBSTONE_CHECK_HOURS = 24
const priorities: Priority[] = ['critical', 'high', 'middle', 'low']
export const priorityOf = (labels: string[]): Priority =>
  priorities.find((p) => labels.includes(PRIORITY_LABELS[p])) ?? 'middle'
export const orderQueue = (items: IssueState[]): IssueState[] =>
  [...items].sort(
    (a, b) =>
      priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
      a.readyAt.localeCompare(b.readyAt) ||
      a.key.localeCompare(b.key),
  )
const categoryOf = (labels: string[]): string =>
  labels.includes(FEATURE_LABEL) ? FEATURE_LABEL : (labels.find((l) => ['bug', 'improvement'].includes(l)) ?? '')
const makeIssue = (repo: string, row: ReadyIssue, pick: string): IssueState => ({
  key: `${repo}#${row.number}`,
  repo,
  number: row.number,
  title: row.title,
  generation: 1,
  phase: 'judging',
  priority: priorityOf(row.labels),
  category: categoryOf(row.labels),
  readyAt: readyAtOf(repo, row.number, pick, row.updatedAt),
  targets: [],
  limitMinutes: 0,
  reason: '',
  slug: '',
  statusDir: '',
  branch: '',
  coordinator: null,
  worktrees: 0,
  startedAt: null,
  stalledNotified: false,
  startFailures: 0,
  startAttempt: null,
  prs: [],
  decisions: [],
  finishingSince: null,
  cleanupPending: false,
  returnedFromEng: false,
  endedAt: null,
  checkedAt: null,
  prevBranch: null,
  prevPrs: [],
  pendingLabel: null,
  failReason: null,
  updatedAt: autoNow(),
})
export const syncIssues = (
  state: AutoState,
  sources: Array<{ repo: string; pick: string }>,
): { added: string[]; dropped: string[]; humanChanged: string[]; unreadable: string[] } => {
  const result = {
    added: [] as string[],
    dropped: [] as string[],
    humanChanged: [] as string[],
    unreadable: [] as string[],
  }
  const existing = new Set(Object.keys(state.issues))
  const failed = new Set<string>()
  const candidates = new Map<string, ReadyIssue>()
  const now = autoNow()
  for (const source of sources) {
    if (!canAutoCall('同期')) {
      result.unreadable.push(...Object.keys(state.issues))
      return result
    }
    const rows = listReadyManaged(source.repo, source.pick)
    if (!rows) {
      failed.add(source.repo)
      continue
    }
    for (const row of rows) {
      const key = `${source.repo}#${row.number}`
      candidates.set(key, row)
      const issue = state.issues[key]
      if (!issue) {
        state.issues[key] = makeIssue(source.repo, row, source.pick)
        result.added.push(key)
      } else if (
        !issue.cleanupPending &&
        !issue.pendingLabel &&
        ['failed', 'stopped', 'eng', 'review'].includes(issue.phase)
      ) {
        const from = issue.phase
        Object.assign(issue, {
          prevBranch: issue.branch || issue.prevBranch,
          prevPrs: issue.prs.length ? issue.prs : issue.prevPrs,
          generation: issue.generation + 1,
          phase: 'judging',
          title: row.title,
          priority: priorityOf(row.labels),
          category: categoryOf(row.labels),
          readyAt: readyAtOf(source.repo, row.number, source.pick, row.updatedAt),
          branch: '',
          prs: [],
          decisions: [],
          stalledNotified: false,
          startFailures: 0,
          startedAt: null,
          finishingSince: null,
          returnedFromEng: from === 'eng',
          coordinator: null,
          startAttempt: null,
          failReason: null,
          updatedAt: now,
        })
      }
    }
  }
  for (const key of existing) {
    if (!canAutoCall('同期')) {
      result.unreadable.push(...Object.keys(state.issues))
      return result
    }
    const issue = state.issues[key]
    if (!issue || issue.pendingLabel) continue
    if (failed.has(issue.repo)) {
      result.unreadable.push(key)
      continue
    }
    const pick = sources.find((s) => s.repo === issue.repo)?.pick ?? STATUS.ready
    const tombstone = ['done', 'failed', 'stopped', 'eng'].includes(issue.phase)
    if (
      tombstone &&
      (issue.cleanupPending ||
        Date.parse(now) - Date.parse(issue.checkedAt ?? issue.endedAt ?? issue.updatedAt) <
          AUTO_TOMBSTONE_CHECK_HOURS * 3600000)
    )
      continue
    if (!tombstone && !['judging', 'queued', 'running', 'dispatching', 'finishing'].includes(issue.phase)) continue
    const view = viewIssue(issue.repo, issue.number)
    if (!view) {
      result.unreadable.push(key)
      continue
    }
    if (tombstone) {
      issue.checkedAt = now
      if (view.state === 'CLOSED' && !issue.cleanupPending) {
        delete state.issues[key]
        result.dropped.push(key)
      }
    } else if (issue.phase === 'judging' || issue.phase === 'queued') {
      if (view.state === 'CLOSED') {
        delete state.issues[key]
        result.dropped.push(key)
      } else if (!view.labels.includes(pick)) {
        issue.phase = 'stopped'
        issue.updatedAt = now
      } else {
        const row = candidates.get(key)
        if (row) {
          issue.title = row.title
          issue.priority = priorityOf(row.labels)
          issue.category = categoryOf(row.labels)
        }
      }
    } else if (
      view.state === 'CLOSED' ||
      (issue.phase === 'dispatching'
        ? !view.labels.includes(pick) && !view.labels.includes(STATUS.inProgress)
        : !view.labels.includes(STATUS.inProgress))
    )
      result.humanChanged.push(key)
  }
  return result
}
