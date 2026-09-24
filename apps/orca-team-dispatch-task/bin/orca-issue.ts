// claim 済みの issue を 1 件、最後まで運ぶ。
// Usage: node orca-issue.ts --issue <N> --slug <s> [--state-file <p>] [--phase dispatch|finish|all]
//        [--request-file <f>] [--run <id>] [--repo-root <p>] [--repo <owner/repo>]
//        [--timeout-ms <n>] [--max-waits <n>]
//        --state-file の既定は <repo-root>/.dispatch-issue/state.json。空の --run / --repo は渡さないのと同じ
// Exit: 0 done / 1 運べなかった（資源は保持）/ 2 使用法
// ★ dispatch → wait → finish。merge が成功してから cleanup の判断を始める。
import { die, log } from '../lib/cli.ts'
import { readJson } from '../lib/fs.ts'
import { defaultStateFile, excludeStateDir } from '../lib/issue.ts'
import { asString, get, parseJson } from '../lib/json.ts'
import { run, runNode, which } from '../lib/sys.ts'

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  phase: string
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
      options.phase = value
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
  if (options.issue === '' || options.slug === '') die(NAME, '--issue and --slug are required')
  if (options.phase !== 'dispatch' && options.phase !== 'finish' && options.phase !== 'all')
    die(NAME, `--phase must be dispatch, finish or all: ${options.phase}`)
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
  // ★ 省けば repo の .dispatch-issue/state.json（orca-issue-loop.ts の start が lock を取った場所と同じ）
  if (options.stateFile === '') options.stateFile = defaultStateFile(options.repoRoot)
  if (which('gh') === null) die(NAME, 'gh is not installed')
  if (!readable(ISSUE_FETCH)) die(NAME, `issue-fetch.ts is missing at ${ISSUE_FETCH}`)
  return options
}
// 移植元の理由（bin/orca-issue.sh）:
// ★ **終端ラベルを先に付け、`dispatch/in-progress` はそのあとで外す。**間で落ちても
//   issue には結末が付いた状態で残る。逆順にすると「in-progress でも done でもない」
//   宙ぶらりんの issue ができ、次の実行の候補にも入らない。
//
//   ★ **`terminal` という名前のラベルは無い。**cmux 版の `terminal` は「終端ラベル」を
//   指す変数名であって、ラベル名ではない（実機で発見: 存在しないラベルを付けようとして
//   全 issue の遷移が失敗した）。作るのも付けるのも `dispatch/*` の 3 つだけである。
//
// ★ **反対の終端ラベルも外す。**1 度失敗して再実行した issue には `dispatch/failed` が
//   既に付いている。外さないと done と failed が同時に付き、**人が結末を読めなくなる**
//   （実機で発見）。`fetch` の検索はどちらでも除外するので取りこぼしはしないが、
//   矛盾したラベルを残さない。
//
// ★ ラベルを動かせなかったことを **state に嘘で上書きしない。**次の reconcile が
//   痕跡を見て止まるほうが、静かに done にするより良い。
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
// 移植元の理由（bin/orca-issue.sh）:
// ★ **phase を分けられるのは並列のためである。**`all`（既定）は dispatch → wait → finish を
//   1 件ぶん通すので、バッチで順に呼ぶと **1 件ずつ直列にしか走らない**。バッチでは
//   `dispatch` を N 件ぶん先に呼び、`orca-wait.ts` を **1 回**で全件待ってから `finish` を
//   N 件ぶん呼ぶ。Stage A が作った「N タスクを 1 Run に載せて 1 回で待つ」形をそのまま使う。
//   単件（`--issue <N>`）には並列にするものが無いので `all` でよい。
// Exit:  0 = done（merge してラベルを遷移し、片付けの判定まで済んだ）
//        1 = 運べなかった（**資源は保持する**）
//        2 = 使用法エラー
//
// ★ **順序が核心である。merge が成功して初めて cleanup してよい**（spec 18-1 の裁定）。
//   逆にすると worktree を消してから merge に失敗し、成果が消える。
//
// ★ **統合はどちらか一方である。**`integration=merge` は親ブランチへ取り込み、
//   `integration=pr` は push して pull request を作る。両方はやらない — PR を作ったうえで
//   親へ merge すると、レビューされる前に成果が入る。
//
// ★ **`integration=pr` のとき issue を close しない。**本文に `Closes #N` を入れてあるので、
//   **PR がマージされたときに GitHub が閉じる。**先に閉じると、PR が却下されても issue は
//   閉じたままになる。
//
// ★ **cleanup は資源を消さない。**Step 5 と同じく「消してよいか」を判定して印字するだけで、
//   実行はユーザーの承認を経た Step 6 が行う。無人で走る経路が資源を消すと、失敗の証拠が
//   その場で失われる。
//
// ★ **親が dirty なら先に言う。**merge の dirty ガードは finish まで発火しないので、
//   黙って進むと **必ず merge できない仕事に worker を 1 本使う**。止めはしない
//   （dispatch と finish の間に commit されうる）が、無人実行で気づけるようにする。
//
// ★ **無人実行で brainstorming は成立しない。**答える人が居ないので、design は 1 往復
//   待ってから自分で決めることになる。待つだけ無駄なので `plan` へ落とす。cmux 版が
//   loop-mode で「plan mode に固定」としているのと同じ判断である。
//
// ★ **機械可読行を stderr へ複製しない。**呼び出し側が `2>&1` で受けると `run_id=` が
//   2 行になり、`--run` に改行入りの値が渡って壊れる（実機で発見）。診断だけ通す。
//
// ★ **待たない。**呼び出し側が全件を 1 回の `orca-wait.ts` で待ち、そのあと finish を呼ぶ。
//
// ★ wake 駆動にしない。落とした通知でジョブが黙って消える失敗様式を持ち込まない。
// ★ **停滞で止まって尋ねない。**無人なので尋ねる相手が居ない。stall.json に残して待ち続ける。
//
// ★ **取り込み方は記録した値を読む。**dispatch と finish の間には待機バッチが挟まり、
//   その間に設定が変わりうる。orca-merge.ts / orca-pr.ts は起動時に記録した値を基準に
//   もう一方を拒むので、finish もそこと同じ値を読む。記録が無い（旧版の status dir）
//   ときだけ、いま解決した設定へ従来どおり落ちる。
//
// ★ **repo は呼び出し側が 1 度だけ解決した値を渡す。**`orca-pr.ts` も自分では見に行かない
//   （spec 12-2 の実測: 子が remote を解決して fork の中に PR を作った）。
//
// ★ **成功時にも message を書く。**`finalize` は空の message を無視するので、
//   前回の失敗時に書かれた理由が `done` のまま残る（実機で発見）。上書きする。
//
// ★ **閉じない。**`Closes #$NUM` を本文に入れてあるので、PR がマージされたときに
//   GitHub が閉じる。先に閉じると、PR が却下されても issue は閉じたままになる。
//
// ★ **空の値を印字しない。**finish phase は Run を知らないので `run_id=` を出すと
//   空文字が渡り、受け取った側が `--run ""` を組み立てて壊れる（実機で気づいた）。
const main = (argv: string[]): number => {
  const options = parse(argv)
  const statusDir = join(options.repoRoot, '.dispatch', options.slug)
  excludeStateDir(options.stateFile, options.repoRoot)
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
