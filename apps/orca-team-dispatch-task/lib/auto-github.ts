import { asArray, asObject, asString, type Json, parseJson } from './json.ts'
import { MANAGED_LABELS } from './status.ts'
import { run } from './sys.ts'

export const AUTO_TIMELINE_MAX_PAGES = 10
export const AUTO_GITHUB_PAGE_SIZE = 100
export const github = (args: string[]) => run('gh', args)
export const readGithub = (args: string[]): Json | null => {
  const result = github(args)
  return result.rc === 0 ? parseJson(result.stdout) : null
}
export const labelNames = (value: Json | undefined): string[] =>
  asArray(value)?.flatMap((label) => {
    const name = typeof label === 'string' ? label : asString(asObject(label)?.name)
    return name ? [name] : []
  }) ?? []
export type ReadyIssue = { number: number; title: string; labels: string[]; updatedAt: string }
export const listReadyManaged = (repo: string, pick: string): ReadyIssue[] | null => {
  const issues = new Map<number, ReadyIssue>()
  for (const managed of MANAGED_LABELS) {
    const rows = asArray(
      readGithub([
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--label',
        pick,
        '--label',
        managed,
        '--limit',
        String(AUTO_GITHUB_PAGE_SIZE),
        '--json',
        'number,title,labels,updatedAt',
      ]),
    )
    if (!rows) return null
    for (const row of rows) {
      const issue = asObject(row)
      if (
        !issue ||
        typeof issue.number !== 'number' ||
        typeof issue.title !== 'string' ||
        typeof issue.updatedAt !== 'string' ||
        !Array.isArray(issue.labels)
      )
        return null
      issues.set(issue.number, {
        number: issue.number,
        title: issue.title,
        labels: labelNames(issue.labels),
        updatedAt: issue.updatedAt,
      })
    }
  }
  return [...issues.values()]
}
export const viewIssue = (
  repo: string,
  number: number,
): { state: 'OPEN' | 'CLOSED'; labels: string[]; title: string } | null => {
  const row = asObject(readGithub(['issue', 'view', String(number), '--repo', repo, '--json', 'state,labels,title']))
  return row &&
    (row.state === 'OPEN' || row.state === 'CLOSED') &&
    typeof row.title === 'string' &&
    Array.isArray(row.labels)
    ? { state: row.state, labels: labelNames(row.labels), title: row.title }
    : null
}
export const readyAtOf = (repo: string, number: number, pick: string, fallback: string): string => {
  let latest = ''
  for (let page = 1; page <= AUTO_TIMELINE_MAX_PAGES; page++) {
    const rows = asArray(
      readGithub([
        'api',
        '--method',
        'GET',
        `repos/${repo}/issues/${number}/timeline?per_page=${AUTO_GITHUB_PAGE_SIZE}&page=${page}`,
      ]),
    )
    if (!rows) return fallback
    for (const value of rows) {
      const row = asObject(value)
      if (
        row?.event === 'labeled' &&
        asObject(row.label)?.name === pick &&
        typeof row.created_at === 'string' &&
        row.created_at > latest
      )
        latest = row.created_at
    }
    if (rows.length < AUTO_GITHUB_PAGE_SIZE) break
  }
  return latest || fallback
}
