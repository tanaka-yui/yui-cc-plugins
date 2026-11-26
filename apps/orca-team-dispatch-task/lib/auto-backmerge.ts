import { actualBases, restrictedBase } from './auto-base.ts'
import { github } from './auto-github.ts'
import { canAutoCall } from './auto-paths.ts'
import { asArray, asObject, asString, parseJson } from './json.ts'

import type { CommentInput } from './auto-comment.ts'
import type { AutoConfig } from './auto-config.ts'
import type { IssueState } from './auto-state.ts'

export type BackMerge =
  | { kind: 'opened'; url: string }
  | { kind: 'existing'; url: string }
  | { kind: 'no-diff' }
  | { kind: 'error'; why: string }
  // gh の呼び出しが予算で断られた・時間切れだった。失敗にせず次の tick でやり直す（list が先に開いた PR を見つける）
  | { kind: 'deferred' }

const NO_COMMITS = 'No commits between'
const TIMED_OUT = 'timed out'
const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''

// `<from> → <to>` の PR を 1 つ開く。同じ向きで開いている PR があればそれを使う（merge はしない）。
export const openBackMerge = (repo: string, from: string, to: string, title: string, body: string): BackMerge => {
  const listed = github([
    'pr',
    'list',
    '--repo',
    repo,
    '--base',
    to,
    '--head',
    from,
    '--state',
    'open',
    '--json',
    'url',
  ])
  if (listed.rc !== 0 && listed.stderr.includes(TIMED_OUT)) return { kind: 'deferred' }
  if (listed.rc !== 0) return { kind: 'error', why: firstLine(listed.stderr) || 'PR の一覧を読めません' }
  const existing = asString(asObject(asArray(parseJson(listed.stdout))?.[0])?.url)
  if (existing) return { kind: 'existing', url: existing }
  const created = github([
    'pr',
    'create',
    '--repo',
    repo,
    '--base',
    to,
    '--head',
    from,
    '--title',
    title,
    '--body',
    body,
  ])
  if (created.rc === 0) {
    const url = created.stdout.trim().split('\n').at(-1)?.trim() ?? ''
    return url ? { kind: 'opened', url } : { kind: 'error', why: 'PR の URL を読めません' }
  }
  if (created.stderr.includes(TIMED_OUT)) return { kind: 'deferred' }
  const output = `${created.stderr}\n${created.stdout}`
  return output.includes(NO_COMMITS)
    ? { kind: 'no-diff' }
    : { kind: 'error', why: firstLine(created.stderr) || firstLine(created.stdout) || 'PR を作れません' }
}

// merge を見つけた段で、普段の向き先でない対象ごとに戻しの PR を開き、merge の知らせ（Testing）のコメントの入力にする。
// 呼び出しの予算が尽きたら null（Testing へ進めず次の tick でやり直す）。作れなくても Testing は止めない。
export const backMergeInput = (
  issue: IssueState,
  targets: Array<{ repo: string; baseBranch: string }>,
  repo: string,
  repos: AutoConfig['repos'],
  // PR の実際の向き先（repo → ブランチ）。分かる対象は記録よりこちらを信じる
  prBases: Record<string, string> = {},
): Pick<CommentInput, 'backPrs' | 'backFailures'> | null => {
  const needed = actualBases(issue.bases, targets, repo).flatMap(({ repo: r, base: recorded }) => {
    const base = prBases[r] || recorded
    const to = repos[r]?.baseBranch
    return base && to && restrictedBase(r, base, repos) ? [{ repo: r, from: base, to }] : []
  })
  if (!needed.length) return {}
  if (!canAutoCall('戻しの PR')) return null
  const backPrs: Array<{ repo: string; url: string }> = []
  const backFailures: Array<{ repo: string; why: string }> = []
  for (const { repo: r, from, to } of needed) {
    const prUrl = issue.prs.find((p) => p.repo === r)?.url ?? issue.prs[0]?.url ?? ''
    const result = openBackMerge(
      r,
      from,
      to,
      `${from} を ${to} へ取り込む（${issue.key}）`,
      `${issueUrl(issue)} と ${prUrl} の取り込み。`,
    )
    if (result.kind === 'deferred') return null
    if (result.kind === 'opened' || result.kind === 'existing') backPrs.push({ repo: r, url: result.url })
    else backFailures.push({ repo: r, why: result.kind === 'no-diff' ? '差分がありません' : result.why })
  }
  return { ...(backPrs.length ? { backPrs } : {}), ...(backFailures.length ? { backFailures } : {}) }
}
const issueUrl = (issue: IssueState): string => `https://github.com/${issue.repo}/issues/${issue.number}`
