// 成果のブランチを push して pull request を作る。
// Usage: node orca-pr.ts --status-dir <d> --repo <owner/repo> [--issue <N>] [--remote <name>]
// Exit: 0 = PR がある / 1 = 作れなかった / 2 = 使用法エラー
// ★ --repo は呼び出し側が決める。remote を自分で推測すると fork に成果を送る事故になる。
import { die, log } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asString, get, parseJson } from '../lib/json.ts'
import { run, which } from '../lib/sys.ts'

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = 'orca-pr'
const value = (file: string, ...path: string[]): string => asString(get(readJson(file), ...path)) ?? ''
const git = (repo: string, ...args: string[]) => run('git', ['-C', repo, ...args])
const nonempty = (file: string): boolean => {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}
const persist = (
  file: string,
  valueToWrite: {
    merged: boolean
    reason?: string
    integration?: string
    pr_url?: string
    branch?: string
    base?: string
    repo?: string
  },
): boolean => writeAtomic(file, `${JSON.stringify(valueToWrite)}\n`)
const stop = (statusDir: string, reason: string): number => {
  persist(join(statusDir, 'integration-result.json'), { merged: false, reason })
  log(NAME, reason)
  return 1
}
const textFile = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const main = (argv: string[]): number => {
  let statusDir = ''
  let repo = ''
  let issue = ''
  let remote = 'origin'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--status-dir' || arg === '--repo' || arg === '--issue' || arg === '--remote') {
      if (i + 1 >= argv.length) die(NAME, `${arg} requires a value`)
      const next = argv[++i] ?? ''
      if (arg === '--status-dir') statusDir = next
      if (arg === '--repo') repo = next
      if (arg === '--issue') issue = next
      if (arg === '--remote') remote = next
    } else {
      die(NAME, `unknown option: ${arg}`)
    }
  }
  if (statusDir === '') die(NAME, '--status-dir is required')
  if (repo === '') die(NAME, '--repo <owner/repo> is required; this never resolves the remote itself')
  if (!repo.includes('/')) die(NAME, `--repo must be <owner>/<repo>: ${repo}`)
  if (issue !== '' && !/^\d+$/.test(issue)) die(NAME, `--issue must be a number: ${issue}`)
  const workersFile = join(statusDir, 'workers.json')
  const runFile = join(statusDir, 'run.json')
  try {
    readFileSync(workersFile)
    readFileSync(runFile)
  } catch {
    die(NAME, `cannot read the dispatch state in ${statusDir}`)
  }
  if (which('gh') === null) die(NAME, 'gh is not installed')
  const workers = readJson(workersFile)
  // ★ merge と決めた dispatch で PR を作らない。記録を汚さず止める。
  if (get(workers, 'integration') === 'merge') {
    log(NAME, 'this dispatch was started to merge; use orca-merge.ts instead')
    return 1
  }
  const prior = value(join(statusDir, 'integration-result.json'), 'pr_url')
  if (prior !== '') {
    log(NAME, 'a pull request is already recorded for this dispatch')
    process.stdout.write(`${prior}\n`)
    return 0
  }
  const root = value(runFile, 'repo_root')
  if (root === '') return stop(statusDir, 'no repository identity recorded')
  const role = value(workersFile, 'integration_role')
  if (role === '') return stop(statusDir, 'no integration role recorded; refusing to guess')
  const branch = asString(get(workers, 'roles', role, 'branch')) ?? ''
  if (branch === '') return stop(statusDir, `no branch recorded for role '${role}'; refusing to guess`)
  const base = value(workersFile, 'integration_branch')
  if (base === '') return stop(statusDir, 'no base branch recorded; refusing to guess')
  const status = value(join(statusDir, 'roles', role, 'status.json'), 'status')
  if (status !== 'done') return stop(statusDir, `the worker status is '${status || 'missing'}', not done`)
  const resultFile = join(statusDir, 'roles', role, 'result.md')
  if (!nonempty(resultFile)) return stop(statusDir, 'result.md is missing or empty')
  if (git(root, 'show-ref', '--quiet', `refs/heads/${branch}`).rc !== 0)
    return stop(statusDir, `branch ${branch} does not exist`)
  if (git(root, 'rev-parse', '--quiet', '--verify', `refs/heads/${base}`).rc === 0) {
    const count = git(root, 'rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`)
    if (count.rc !== 0 || count.stdout.trim() === '' || count.stdout.trim() === '0') {
      return stop(statusDir, `branch ${branch} has no commits that ${base} does not already have`)
    }
  }
  if (git(root, 'ls-remote', '--exit-code', '--heads', remote, base).rc !== 0) {
    return stop(
      statusDir,
      `the base branch ${base} does not exist on ${remote}; push it first, or dispatch from a branch that is already there`,
    )
  }
  if (git(root, 'push', remote, `refs/heads/${branch}:refs/heads/${branch}`).rc !== 0) {
    return stop(statusDir, `could not push ${branch} to ${remote}; no pull request was created`)
  }

  const firstLine = textFile(join(statusDir, 'request.md')).split('\n')[0] ?? ''
  const title = [...firstLine].slice(0, 72).join('') || branch
  const resultLines = textFile(resultFile).split('\n').slice(0, 200)
  const body = resultLines.join('\n') + (issue === '' ? '' : `\nCloses #${issue}\n`)
  let temporary = ''
  try {
    temporary = mkdtempSync(join(tmpdir(), 'orca-pr-'))
    writeFileSync(join(temporary, 'body.md'), body)
  } catch {
    if (temporary !== '') rmSync(temporary, { recursive: true, force: true })
    return stop(statusDir, 'mktemp failed')
  }
  // ★ gh の stderr は成功時の警告を含む。URL は stdout だけから読み、重複 PR を防ぐ。
  const created = run('gh', [
    'pr',
    'create',
    '--repo',
    repo,
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body-file',
    join(temporary, 'body.md'),
  ])
  rmSync(temporary, { recursive: true, force: true })
  if (created.stderr !== '') log(NAME, `gh: ${created.stderr.replace(/\n/g, ' ')}`)
  let url = [...created.stdout.matchAll(/https:\/\/\S+/g)].at(-1)?.[0] ?? ''
  if (created.rc !== 0 || url === '') {
    const listed = run('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'url'])
    const entries = asArray(listed.rc === 0 ? parseJson(listed.stdout) : null)
    url = asString(get(entries?.[0], 'url')) ?? ''
    if (url === '') {
      log(NAME, created.stdout.trimEnd())
      return stop(statusDir, `gh pr create failed for ${branch}`)
    }
    log(NAME, `a pull request for ${branch} already exists`)
  }
  const result = { merged: false, integration: 'pr', pr_url: url, branch, base, repo }
  if (!persist(join(statusDir, 'integration-result.json'), result)) {
    log(NAME, `the pull request was created at ${url} but the result could not be persisted`)
    return 1
  }
  log(NAME, `opened ${url}`)
  process.stdout.write(`${url}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
