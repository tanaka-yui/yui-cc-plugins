import { type AutoEvent, type CommentInput, renderComment } from './auto-comment.ts'
import { AUTO_GITHUB_PAGE_SIZE, github, readGithub, viewIssue } from './auto-github.ts'
import { autoNow } from './auto-paths.ts'
import { readJson } from './fs.ts'
import { asArray, asObject, asString } from './json.ts'
import { STATUS_LABELS } from './status.ts'

import { join } from 'node:path'

import type { EndRecorder, Outcome } from './auto-learn.ts'
import type { IssueState, Phase } from './auto-state.ts'

// 終わると世代の結果が決まる遷移の結果。ほかの遷移は null
const endingOf = (event: string, issue: IssueState): Outcome | null =>
  event === 'ai-merged'
    ? 'merged-ai'
    : event === 'human-merged'
      ? 'merged-human'
      : event === 'failed'
        ? issue.failEnv
          ? 'failed-env'
          : 'failed'
        : null

export const hasDispatch = (issue: IssueState): boolean =>
  Object.values(asObject(asObject(readJson(join(issue.statusDir, 'workers.json')))?.roles) ?? {}).some((role) =>
    Boolean(asString(asObject(role)?.dispatch)),
  )
// 人がステータスを変えた・閉じたので遷移をやめて止める。onEnd には世代の結果（stopped）を渡す
export const cancelTransition = (
  issue: IssueState,
  save: () => void,
  onEnd?: EndRecorder,
  labels: string[] = [],
): void => {
  issue.pendingLabel = null
  issue.failReason = null
  issue.phase = 'stopped'
  if (hasDispatch(issue)) {
    issue.cleanupPending = true
    issue.endedAt = autoNow()
  }
  issue.updatedAt = autoNow()
  onEnd?.(issue, 'stopped', labels)
  save()
}
export const hasCommentMarker = (issue: IssueState, marker: string): boolean | null => {
  for (let page = 1; ; page++) {
    const comments = asArray(
      readGithub([
        'api',
        '--method',
        'GET',
        `repos/${issue.repo}/issues/${issue.number}/comments?per_page=${AUTO_GITHUB_PAGE_SIZE}&page=${page}`,
      ]),
    )
    if (!comments) return null
    if (comments.some((c) => asString(asObject(c)?.body)?.trimEnd().split('\n').at(-1) === marker)) return true
    if (comments.length < AUTO_GITHUB_PAGE_SIZE) return false
  }
}
export const resumeTransition = (issue: IssueState, save: () => void, fresh = false, onEnd?: EndRecorder): boolean => {
  const pending = issue.pendingLabel
  if (!pending) return false
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return false
  const status = view.labels.filter((l) => STATUS_LABELS.some((s) => s.name === l))
  const only = (label: string) => status.length === 1 && status[0] === label
  const cancel = () => {
    cancelTransition(issue, save, onEnd, view.labels)
    return false
  }
  if (view.state === 'CLOSED' && !pending.close) return cancel()
  if (!pending.commented) {
    if (view.state === 'CLOSED' || !only(pending.from)) return cancel()
    const marker = pending.body.split('\n').at(-1) ?? ''
    const found = fresh ? false : hasCommentMarker(issue, marker)
    if (found === null) return false
    if (
      !found &&
      github(['issue', 'comment', String(issue.number), '--repo', issue.repo, '--body', pending.body]).rc !== 0
    )
      return false
    pending.commented = true
    save()
  }
  if (!pending.labeled) {
    if (only(pending.to) && pending.from !== pending.to) {
      pending.labeled = true
      save()
    } else if (only(pending.from) && view.state === 'OPEN') {
      if (
        github([
          'issue',
          'edit',
          String(issue.number),
          '--repo',
          issue.repo,
          '--add-label',
          pending.to,
          '--remove-label',
          pending.from,
        ]).rc !== 0
      )
        return false
      pending.labeled = true
      save()
    } else return cancel()
  } else if (!only(pending.to) || (view.state === 'CLOSED' && !pending.close)) return cancel()
  if (
    pending.close &&
    view.state !== 'CLOSED' &&
    github(['issue', 'close', String(issue.number), '--repo', issue.repo, '--reason', 'completed']).rc !== 0
  )
    return false
  issue.phase = pending.then
  if (['eng', 'review', 'done', 'failed', 'stopped'].includes(issue.phase)) issue.endedAt = autoNow()
  if (issue.phase === 'failed') issue.failReason = null
  issue.pendingLabel = null
  issue.updatedAt = autoNow()
  const ended = endingOf(pending.event, issue)
  if (ended) onEnd?.(issue, ended, view.labels)
  save()
  return true
}
export const transition = (
  issue: IssueState,
  event: AutoEvent,
  input: Omit<CommentInput, 'event' | 'generation'>,
  from: string,
  to: string,
  close: boolean,
  then: Phase,
  save: () => void,
  onEnd?: EndRecorder,
): boolean => {
  if (issue.pendingLabel) return false
  const view = viewIssue(issue.repo, issue.number)
  if (!view) return false
  const statuses = view.labels.filter((l) => STATUS_LABELS.some((s) => s.name === l))
  if (view.state !== 'OPEN' || statuses.length !== 1 || statuses[0] !== from) {
    cancelTransition(issue, save, onEnd, view.labels)
    return false
  }
  const body = renderComment({ ...input, event, generation: issue.generation }).body
  issue.pendingLabel = { event, from, to, close, body, commented: false, labeled: false, then }
  if (['review', 'done', 'failed', 'stopped'].includes(then)) issue.cleanupPending = true
  save()
  return resumeTransition(issue, save, true, onEnd)
}
// ステータスを変えずに needs-base のコメントだけ書く（Backlog のまま判定した auto-ready の Issue）。
// 判定の CLI は tick の外で動くので、tick の呼び出し予算は見ない。同じ世代のマーカーがあれば書き直さない
export const notifyNeedsBase = (
  issue: IssueState,
  input: Pick<CommentInput, 'candidates' | 'fallback'>,
  save: () => void,
): boolean => {
  const body = renderComment({ ...input, event: 'needs-base', generation: issue.generation }).body
  const found = hasCommentMarker(issue, body.split('\n').at(-1) ?? '')
  if (
    found === null ||
    (found === false &&
      github(['issue', 'comment', String(issue.number), '--repo', issue.repo, '--body', body]).rc !== 0)
  )
    return false
  issue.updatedAt = autoNow()
  save()
  return true
}
