// claim 済みの issue を 1 件、最後まで運ぶ。
// Usage: node orca-issue.ts --state-file <p> --issue <N> --slug <s> [--phase dispatch|finish|all]
//        [--request-file <f>] [--run <id>] [--repo-root <p>] [--repo <owner/repo>]
//        [--timeout-ms <n>] [--max-waits <n>]
// Exit: 0 done / 1 運べなかった（資源は保持）/ 2 使用法
// ★ dispatch → wait → finish。merge が成功してから cleanup の判断を始める。
import { die, log } from '../lib/cli.ts'
import { readJson } from '../lib/fs.ts'
import { asString, get, parseJson } from '../lib/json.ts'
import { run, runNode, which } from '../lib/sys.ts'

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-issue'
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const SCRIPTS = join(PLUGIN, 'skills', 'orca-team-dispatch-task', 'scripts')
const ISSUE_FETCH = join(SCRIPTS, 'issue-fetch.ts')
const string = (value: ReturnType<typeof get>): string => asString(value) ?? ''
const git = (repo: string, ...args: string[]) => run('git', ['-C', repo, ...args])
const readable = (file: string): boolean => {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
type Options = {
  stateFile: string
  issue: string
  slug: string
  request: string
  runId: string
  repoRoot: string
  timeout: string
  maxWaits: string
  phase: 'dispatch' | 'finish' | 'all'
  repo: string
}
const parse = (argv: string[]): Options => {
  const options: Options = {
    stateFile: '',
    issue: '',
    slug: '',
    request: '',
    runId: '',
    repoRoot: '',
    timeout: '600000',
    maxWaits: '60',
    phase: 'all',
    repo: '',
  }
  const fields: Record<string, keyof Options> = {
    '--state-file': 'stateFile',
    '--issue': 'issue',
    '--slug': 'slug',
    '--request-file': 'request',
    '--run': 'runId',
    '--repo-root': 'repoRoot',
    '--timeout-ms': 'timeout',
    '--max-waits': 'maxWaits',
    '--phase': 'phase',
    '--repo': 'repo',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? ''
    const field = fields[flag]
    if (field === undefined) die(NAME, `unknown option: ${flag}`)
    if (i + 1 >= argv.length) die(NAME, `${flag} requires a value`)
    const value = argv[++i] ?? ''
    if (field === 'phase') {
      if (value !== 'dispatch' && value !== 'finish' && value !== 'all') {
        die(NAME, `--phase must be dispatch, finish or all: ${value}`)
      }
      options.phase = value === 'dispatch' ? 'dispatch' : value === 'finish' ? 'finish' : 'all'
    } else if (field === 'stateFile') options.stateFile = value
    else if (field === 'issue') options.issue = value
    else if (field === 'slug') options.slug = value
    else if (field === 'request') options.request = value
    else if (field === 'runId') options.runId = value
    else if (field === 'repoRoot') options.repoRoot = value
    else if (field === 'timeout') options.timeout = value
    else if (field === 'maxWaits') options.maxWaits = value
    else if (field === 'repo') options.repo = value
  }
  if (options.stateFile === '' || options.issue === '' || options.slug === '')
    die(NAME, '--state-file, --issue and --slug are required')
  if (!/^\d+$/.test(options.issue)) die(NAME, `--issue must be a number: ${options.issue}`)
  if (options.phase !== 'finish') {
    if (options.request === '') die(NAME, `--request-file is required for phase '${options.phase}'`)
    if (!readable(options.request)) die(NAME, `--request-file is not readable: ${options.request}`)
  }
  if (options.repoRoot === '') {
    const found = run('git', ['rev-parse', '--show-toplevel'])
    if (found.rc !== 0) die(NAME, 'not in a git repo')
    options.repoRoot = found.stdout.trim()
  }
  if (which('gh') === null) die(NAME, 'gh is not installed')
  if (!readable(ISSUE_FETCH)) die(NAME, `issue-fetch.ts is missing at ${ISSUE_FETCH}`)
  return options
}
const excludeStateDir = (options: Options): void => {
  let stateDir = ''
  let repoDir = options.repoRoot
  try {
    stateDir = realpathSync(dirname(options.stateFile))
  } catch {
    /* 見つからないなら追加しない */
  }
  try {
    repoDir = realpathSync(repoDir)
  } catch {
    /* 元の値で比べる */
  }
  if (stateDir === '' || !stateDir.startsWith(`${repoDir}/`)) return
  const exclude = git(options.repoRoot, 'rev-parse', '--git-path', 'info/exclude')
  if (exclude.rc !== 0 || exclude.stdout.trim() === '') return
  const entry = `${relative(repoDir, stateDir)}/`
  const path = isAbsolute(exclude.stdout.trim()) ? exclude.stdout.trim() : join(options.repoRoot, exclude.stdout.trim())
  try {
    mkdirSync(dirname(path), { recursive: true })
    const current = readable(path) ? readFileSync(path, 'utf8') : ''
    if (!current.split('\n').includes(entry)) appendFileSync(path, `${entry}\n`)
  } catch {
    /* 除外に失敗しても dispatch は続ける */
  }
}
const labelTerminal = (issue: string, status: 'done' | 'failed'): boolean => {
  const other = status === 'done' ? 'failed' : 'done'
  if (run('gh', ['issue', 'edit', issue, '--add-label', `dispatch/${status}`]).rc !== 0) return false
  run('gh', ['issue', 'edit', issue, '--remove-label', `dispatch/${other}`])
  return run('gh', ['issue', 'edit', issue, '--remove-label', 'dispatch/in-progress']).rc === 0
}
const issueFetch = (options: Options, args: string[]) =>
  runNode(ISSUE_FETCH, ['--state-file', options.stateFile, ...args])
const output = (options: Options, statusDir: string): void => {
  const lines = [`issue=${options.issue}`, `slug=${options.slug}`, `status_dir=${statusDir}`]
  if (options.runId !== '') lines.push(`run_id=${options.runId}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}
const failOut = (options: Options, statusDir: string, reason: string): number => {
  log(NAME, reason)
  if (labelTerminal(options.issue, 'failed')) {
    if (
      issueFetch(options, ['finalize', '--issue', options.issue, '--status', 'failed', '--message', reason]).rc !== 0
    ) {
      log(NAME, `the state file could not be updated for issue #${options.issue}`)
    }
  } else log(NAME, `could not move the labels for issue #${options.issue}; the state is left as dispatched`)
  log(NAME, `issue #${options.issue}: resources are KEPT at ${statusDir}`)
  return 1
}
const main = (argv: string[]): number => {
  const options = parse(argv)
  const statusDir = join(options.repoRoot, '.dispatch', options.slug)
  excludeStateDir(options)
  if (options.phase !== 'finish') {
    const porcelain = git(options.repoRoot, 'status', '--porcelain')
    if (porcelain.rc === 0 && porcelain.stdout !== '') {
      log(NAME, `issue #${options.issue}: the parent checkout is dirty; it must be clean by the time this merges`)
    }
    const design = runNode(join(SCRIPTS, 'config-resolve.ts'), ['--project-root', options.repoRoot])
    const mode = design.rc === 0 ? string(get(parseJson(design.stdout), 'design_mode')) || 'direct' : 'direct'
    const modeArgs: string[] = []
    if (mode === 'brainstorm') {
      log(NAME, `issue #${options.issue}: design_mode is 'brainstorm' but an issue run is unattended; using 'plan'`)
      modeArgs.push('--design-mode', 'plan')
    }
    const startArgs = [
      '--request-file',
      options.request,
      '--slug',
      options.slug,
      '--objective',
      `issue #${options.issue}`,
      '--repo-root',
      options.repoRoot,
    ]
    if (options.runId !== '') startArgs.push('--run', options.runId)
    startArgs.push(...modeArgs)
    const started = runNode(join(HERE, 'orca-start.ts'), startArgs)
    if (started.rc !== 0) {
      log(NAME, `${started.stdout}${started.stderr}`.trimEnd())
      return failOut(options, statusDir, `issue #${options.issue}: the dispatch did not start`)
    }
    if (started.stderr !== '') process.stderr.write(started.stderr)
    for (const line of started.stdout.trimEnd().split('\n')) {
      if (!/^(status_dir|run_id)=/.test(line) && line !== '') process.stderr.write(`${line}\n`)
      if (line.startsWith('run_id=')) options.runId = line.slice('run_id='.length)
    }
    if (options.runId === '')
      return failOut(options, statusDir, `issue #${options.issue}: the dispatch printed no run_id`)
    if (issueFetch(options, ['mark-dispatched', '--issue', options.issue]).rc !== 0) {
      log(NAME, `issue #${options.issue}: could not mark it dispatched; the wait continues`)
    }
    if (options.phase === 'dispatch') {
      output(options, statusDir)
      return 0
    }
  }
  if (options.phase === 'all') {
    const waited = runNode(
      join(HERE, 'orca-wait.ts'),
      [
        '--status-dir',
        statusDir,
        '--max-waits',
        options.maxWaits,
        '--timeout-ms',
        options.timeout,
        '--on-stall',
        'report',
      ],
      true,
    )
    if (waited.rc === 5)
      return failOut(
        options,
        statusDir,
        `issue #${options.issue}: the worker reported failure; the result is in ${statusDir}/roles/design/result.md`,
      )
    if (waited.rc !== 0)
      return failOut(options, statusDir, `issue #${options.issue}: waiting ended with ${waited.rc}; nothing was merged`)
  }
  if (!readable(join(statusDir, 'workers.json')))
    return failOut(options, statusDir, `issue #${options.issue}: there is no dispatch state at ${statusDir}`)
  const resolved = runNode(join(SCRIPTS, 'config-resolve.ts'), ['--project-root', options.repoRoot])
  if (resolved.stderr !== '') process.stderr.write(resolved.stderr)
  if (resolved.rc !== 0)
    return failOut(options, statusDir, `issue #${options.issue}: cannot resolve the dispatch configuration`)
  const integration =
    string(get(readJson(join(statusDir, 'workers.json')), 'integration')) ||
    string(get(parseJson(resolved.stdout), 'integration')) ||
    'merge'
  let prUrl = ''
  if (integration === 'pr') {
    if (options.repo === '')
      return failOut(
        options,
        statusDir,
        `issue #${options.issue}: integration is 'pr' but --repo <owner/repo> was not given`,
      )
    const opened = runNode(join(HERE, 'orca-pr.ts'), [
      '--status-dir',
      statusDir,
      '--repo',
      options.repo,
      '--issue',
      options.issue,
    ])
    if (opened.stderr !== '') process.stderr.write(opened.stderr)
    if (opened.rc !== 0)
      return failOut(
        options,
        statusDir,
        `issue #${options.issue}: no pull request was opened; the worktree and branch are kept`,
      )
    prUrl = opened.stdout.trimEnd()
  } else {
    const merged = runNode(join(HERE, 'orca-merge.ts'), ['--status-dir', statusDir], true)
    if (merged.rc !== 0)
      return failOut(
        options,
        statusDir,
        `issue #${options.issue}: the work was not merged; the worktree and branch are kept`,
      )
  }
  if (!labelTerminal(options.issue, 'done'))
    return failOut(options, statusDir, `issue #${options.issue}: integrated, but the labels could not be moved`)
  if (integration === 'pr') {
    if (
      issueFetch(options, [
        'finalize',
        '--issue',
        options.issue,
        '--status',
        'done',
        '--pr-url',
        prUrl,
        '--message',
        'pull request opened',
      ]).rc !== 0
    ) {
      log(NAME, `issue #${options.issue}: the pull request is at ${prUrl} but the state file could not be updated`)
    }
    log(
      NAME,
      `issue #${options.issue}: ${prUrl} is open. The issue closes when that merges. Resources are kept at ${statusDir}`,
    )
  } else {
    if (run('gh', ['issue', 'close', options.issue, '--reason', 'completed']).rc !== 0) {
      log(NAME, `issue #${options.issue}: merged and labelled, but the issue could not be closed`)
    }
    if (
      issueFetch(options, ['finalize', '--issue', options.issue, '--status', 'done', '--message', 'merged and closed'])
        .rc !== 0
    ) {
      log(NAME, `issue #${options.issue}: merged, but the state file could not be updated`)
    }
    log(NAME, `issue #${options.issue}: merged and closed. Resources are kept for the Step 5/6 cleanup at ${statusDir}`)
  }
  output(options, statusDir)
  return 0
}

process.exitCode = main(process.argv.slice(2))
