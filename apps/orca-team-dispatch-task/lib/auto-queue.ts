import { type RepoBranches, resolveBases } from './auto-base.ts'
import { github, listReadyManaged, listUnlabeledThread, type ReadyIssue, readyAtOf, viewIssue } from './auto-github.ts'
import { autoNow, canAutoCall } from './auto-paths.ts'
import { FEATURE_LABEL, PRIORITY_LABELS, STATUS, STATUS_LABELS, THREAD_LABEL } from './status.ts'

import type { ProjectRef } from './auto-config.ts'
import type { EndRecorder } from './auto-learn.ts'
import type { ProjectSyncContext } from './auto-project.ts'
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
  relayMinutes: 0,
  reason: '',
  slug: '',
  statusDir: '',
  branch: '',
  branches: {},
  prevBranches: {},
  prevTargets: [],
  host: null,
  hostUnreachableSince: null,
  coordinator: null,
  worktrees: 0,
  startedAt: null,
  stalledNotified: false,
  startFailures: 0,
  startAttempt: null,
  prs: [],
  decisions: [],
  reviewPoints: [],
  finishingSince: null,
  cleanupPending: false,
  returnedFromEng: false,
  autoReady: false,
  bases: {},
  baseAsked: false,
  prevBases: {},
  endedAt: null,
  checkedAt: null,
  prevBranch: null,
  prevPrs: [],
  pendingLabel: null,
  failReason: null,
  failEnv: false,
  learn: null,
  updatedAt: autoNow(),
})
// 向き先を尋ねて Backlog で待っている。auto-ready の拾う元で base ラベルが解けたら判定に戻す。
// judge-list と tick の判定の起動とで同じ見方をする
export const awaitingBase = (
  issue: IssueState,
  labels: string[],
  sourceAutoReady: boolean,
  repos: Record<string, RepoBranches>,
): boolean =>
  issue.baseAsked &&
  issue.phase === 'judging' &&
  labels.includes(STATUS.backlog) &&
  !(sourceAutoReady && resolveBases(labels, issue.targets, repos).kind === 'ok')
// intake の existing が active のリポジトリか。Project の同期と同じく大文字小文字を無視する
const isActive = (active: ReadonlySet<string>, repo: string): boolean =>
  [...active].some((name) => name.toLowerCase() === repo.toLowerCase())
// active の auto-ready の拾う元で、slack-thread が付きステータスラベルの無い Issue に Backlog を付ける。
// Project の上の Status がステータス名の Issue と、同じ tick で同期が触った Issue には付けない（付けると次の同期が
// そのラベルを Status へ書き戻す）。orca がもう追っている Issue（state.issues にある）にも付けない
// （人が外した Backlog を付け直さず、止めた・捨てた Issue に印を残さない）。
// その tick で Project を読めなかった拾う元では 1 つも付けない。
// 付けた Issue は次の tick の Backlog の一覧で拾う（同じ tick では検索の遅れで出ない）
export const markUnlabeledBacklog = (
  sources: Array<{ repo: string; autoReady?: boolean; project: ProjectRef | null }>,
  active: ReadonlySet<string>,
  project: Pick<ProjectSyncContext, 'state' | 'statuses' | 'failed' | 'touched'>,
  log: (line: string) => void,
): string[] => {
  const marked: string[] = []
  for (const source of sources) {
    if (!source.autoReady || !isActive(active, source.repo)) continue
    const projectKey = source.project ? `${source.project.owner}/${source.project.number}` : null
    if (projectKey && project.failed.has(projectKey)) continue
    if (!canAutoCall('auto-ready')) return marked
    const rows = listUnlabeledThread(source.repo, log)
    if (!rows) continue
    for (const row of rows) {
      const key = `${source.repo}#${row.number}`
      if (project.state.issues[key]) continue
      // statuses に無い（Project に載っていない）か ''（Todo や空）なら付けてよい
      const status = project.statuses.get(key)
      if (projectKey && (project.touched.has(key) || (status !== undefined && status !== ''))) continue
      if (!canAutoCall('auto-ready')) return marked
      if (github(['issue', 'edit', String(row.number), '--repo', source.repo, '--add-label', STATUS.backlog]).rc === 0)
        marked.push(key)
      else log(`auto-ready で Backlog を付けられません: ${key}`)
    }
  }
  return marked
}
export const syncIssues = (
  state: AutoState,
  sources: Array<{ repo: string; pick: string; autoReady?: boolean }>,
  active: ReadonlySet<string> = new Set(),
  log?: (line: string) => void,
  // 世代が終わった Issue を履歴に残す口（tick が渡す）
  onEnd?: EndRecorder,
): {
  added: string[]
  dropped: string[]
  humanChanged: string[]
  unreadable: string[]
  // 向き先を尋ねて Backlog に居る Issue の今のラベル（awaitingBase で見る）
  asked: Record<string, string[]>
} => {
  const result = {
    added: [] as string[],
    dropped: [] as string[],
    humanChanged: [] as string[],
    unreadable: [] as string[],
    asked: {} as Record<string, string[]>,
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
    const rows = listReadyManaged(source.repo, source.pick, log)
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
        // 世代を進める前に、エンジニア行きを人が戻したことを残す。レビューからの拾い直しは作業の続きなので書かない
        // （次の世代の結果が数える）
        if (from === 'eng') onEnd?.(issue, 'eng-returned', row.labels)
        const hadBranches = Object.keys(issue.branches).length > 0 || issue.branch !== ''
        Object.assign(issue, {
          prevTargets: hadBranches ? [...issue.targets] : issue.prevTargets,
          prevBranches: hadBranches
            ? Object.keys(issue.branches).length
              ? { ...issue.branches }
              : { [issue.targets[0] ?? '']: issue.branch }
            : issue.prevBranches,
          branches: {},
          prevBases: hadBranches ? { ...issue.bases } : issue.prevBases,
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
          reviewPoints: [],
          relayMinutes: 0,
          stalledNotified: false,
          startFailures: 0,
          startedAt: null,
          finishingSince: null,
          returnedFromEng: from === 'eng',
          autoReady: false,
          bases: {},
          baseAsked: false,
          host: null,
          hostUnreachableSince: null,
          coordinator: null,
          startAttempt: null,
          failReason: null,
          failEnv: false,
          learn: null,
          updatedAt: now,
        })
      }
    }
  }
  // auto-ready: 有効にした時刻より後に作られ、ステータスが Backlog だけの Issue を判定に回す。
  // intake の existing が active のリポジトリでは、slack-thread の付いた Backlog だけの Issue も作られた時期を問わず回す。
  // 状態に記録がある Issue（人が Backlog へ戻したものを含む）は拾い直さない
  state.autoReadySince ??= {}
  const since = state.autoReadySince
  for (const source of sources) {
    if (!source.autoReady) {
      delete since[source.repo]
      continue
    }
    if (!since[source.repo]) {
      since[source.repo] = now
      continue
    }
    if (failed.has(source.repo)) continue
    if (!canAutoCall('同期')) {
      result.unreadable.push(...Object.keys(state.issues))
      return result
    }
    const rows = listReadyManaged(source.repo, STATUS.backlog, log)
    if (!rows) {
      failed.add(source.repo)
      continue
    }
    for (const row of rows) {
      const key = `${source.repo}#${row.number}`
      const statuses = row.labels.filter((l) => STATUS_LABELS.some((s) => s.name === l))
      if (
        state.issues[key] ||
        candidates.has(key) ||
        statuses.length !== 1 ||
        statuses[0] !== STATUS.backlog ||
        !(
          Date.parse(row.createdAt) >= Date.parse(since[source.repo] ?? '') ||
          (isActive(active, source.repo) && row.labels.includes(THREAD_LABEL))
        )
      )
        continue
      candidates.set(key, row)
      state.issues[key] = { ...makeIssue(source.repo, row, STATUS.backlog), autoReady: true }
      result.added.push(key)
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
    const source = sources.find((s) => s.repo === issue.repo)
    const pick = source?.pick ?? STATUS.ready
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
        // ほかの墓標の結果は終わったときに書いてある
        if (issue.phase === 'eng') onEnd?.(issue, 'eng-kept', view.labels)
        delete state.issues[key]
        result.dropped.push(key)
      }
    } else if (issue.phase === 'judging' || issue.phase === 'queued') {
      if (view.state === 'CLOSED') {
        onEnd?.(issue, 'stopped', view.labels)
        delete state.issues[key]
        result.dropped.push(key)
      } else if ((issue.autoReady || issue.baseAsked) && issue.phase === 'judging' && !view.labels.includes(pick)) {
        // 判定待ちの Backlog（auto-ready で拾った Issue と、向き先を尋ねて Backlog へ戻した Issue）。
        // auto-ready を外したら auto-ready で拾った Issue は何もせずに記録から外し、人が別のステータスにしたら止める
        if (issue.autoReady && !source?.autoReady) {
          // 設定の変更で、判定の結果ではないので履歴に書かない
          delete state.issues[key]
          result.dropped.push(key)
        } else if (!view.labels.includes(STATUS.backlog)) {
          issue.phase = 'stopped'
          issue.updatedAt = now
          onEnd?.(issue, 'stopped', view.labels)
        } else if (issue.baseAsked) result.asked[key] = view.labels
      } else if (!view.labels.includes(pick)) {
        issue.phase = 'stopped'
        issue.updatedAt = now
        onEnd?.(issue, 'stopped', view.labels)
      } else {
        // 判定の前に人が Ready にした。人が「やる」と決めたので、通常の Issue として扱う
        if (issue.autoReady && issue.phase === 'judging') issue.autoReady = false
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
