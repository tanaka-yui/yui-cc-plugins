// issue モードの 1 回の実行の前後（lock・単件の claim・claim 前の整合・lock の解放）を受け持つ。
// SKILL.md の I0 / I1a / I2 / I4 の block をここへ移した（設計 6 章）。
//
// Usage: node orca-issue-loop.ts start               [--repo-root <p>] [--state-file <p>]
//        node orca-issue-loop.ts claim --issue <N>   [--repo-root <p>] [--state-file <p>]
//        node orca-issue-loop.ts reconcile           [--repo-root <p>] [--state-file <p>]
//        node orca-issue-loop.ts release             [--repo-root <p>] [--state-file <p>]
// Exit: 0 / 1 = できなかった（理由は stderr）/ 2 = 使用法の誤り
//
// ★ **state file の場所はここで決める**（lib/issue.ts の defaultStateFile。orca-issue.ts と同じ場所）。以前は
//   STATE を block から block へ運ばせていたが、shell 変数は tool call を跨がない。I4 のガードは「I0 を先に
//   走らせよ」と言っていたが、I0 を走らせ直すと自分の lock に弾かれた
// ★ issue-fetch.ts は import せず子プロセスで呼ぶ（lib/sys.ts の runNode）。lock と claim の失敗様式
//   （in-flight grace / takeover mutex / claim の補償）は issue-fetch.ts が持ち、ここは順番と、block が jq で
//   読んでいた判定だけを持つ
import { die, log, parseFlags } from '../lib/cli.ts'
import { defaultStateFile, excludeStateDir } from '../lib/issue.ts'
import { asArray, asString, get, parseJson } from '../lib/json.ts'
import { runOrca } from '../lib/orca.ts'
import { type ProcResult, run, runNode, which } from '../lib/sys.ts'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-issue-loop'
const USAGE =
  'usage: orca-issue-loop.ts <start|claim --issue <N>|reconcile|release> [--repo-root <p>] [--state-file <p>]'
const COMMANDS = ['start', 'claim', 'reconcile', 'release']
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ISSUE_FETCH = join(PLUGIN, 'skills', 'orca-team-dispatch-task', 'scripts', 'issue-fetch.ts')

type Options = { repoRoot: string; stateFile: string; issue: string }

const parse = (command: string, args: string[]): Options => {
  const { values } = parseFlags(NAME, {
    args,
    options: { 'repo-root': { type: 'string' }, 'state-file': { type: 'string' }, issue: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  const issue = values.issue ?? ''
  if (command === 'claim' && !/^\d+$/.test(issue)) return die(NAME, `claim needs --issue <number> (got: '${issue}')`)
  if (command !== 'claim' && issue !== '') return die(NAME, `--issue is only for claim\n${USAGE}`)
  let repoRoot = values['repo-root'] ?? ''
  if (repoRoot === '') {
    const found = run('git', ['rev-parse', '--show-toplevel'])
    if (found.rc !== 0) return die(NAME, 'not in a git repo')
    repoRoot = found.stdout.trim()
  }
  return { repoRoot, stateFile: values['state-file'] || defaultStateFile(repoRoot), issue }
}

// issue-fetch.ts の 1 段を走らせ、その stderr をそのまま流す（stdout は呼び出し側が使う）
const step = (options: Options, args: string[]): ProcResult => {
  const result = runNode(ISSUE_FETCH, ['--state-file', options.stateFile, ...args])
  if (result.stderr !== '') process.stderr.write(result.stderr)
  return result
}

// I0。★ **Orca に届くかを lock より先に確かめる。**届かないまま claim すると、各 issue の dispatch が
//   起動できずに失敗し、ラベルが dispatch/failed へ動く（SKILL.md の I0 は「確かめる」と書いていたのに、
//   block は gh しか見ていなかった）
const start = (options: Options): number => {
  if (which('gh') === null) {
    log(NAME, 'gh is not installed')
    return 1
  }
  const runtime = runOrca(['status', '--json'])
  if (runtime.rc !== 0 || get(runtime.json, 'result', 'runtime', 'reachable') !== true) {
    log(NAME, 'the Orca runtime is not reachable')
    return 1
  }
  if (step(options, ['lock-check']).rc !== 0) return 1
  if (step(options, ['lock-acquire', '--lease-min', '60']).rc !== 0) return 1
  excludeStateDir(options.stateFile, options.repoRoot)
  process.stdout.write(`state_file=${options.stateFile}\n`)
  return 0
}

// I1a。名指しの issue を claim し、title と body を依頼ファイルへ書く（I3 のパス 1 が受け取る）。
// ★ **claim が 1 件でなければ止める。**空の claim は「既に state に載っている」であって、隠す失敗ではない
const claim = (options: Options): number => {
  if (step(options, ['init', '--config-json', '{"concurrency":1}', '--filter-json', '{"issue":"named"}']).rc !== 0)
    return 1
  if (step(options, ['ensure-labels']).rc !== 0) return 1
  const fetched = step(options, ['fetch', '--issue', options.issue, '--limit', '1', '--batch', '1'])
  if (fetched.rc !== 0) return 1
  const claimed = asArray(parseJson(fetched.stdout)) ?? []
  const issue = claimed[0]
  if (claimed.length !== 1 || issue === undefined) {
    log(NAME, `issue #${options.issue} was not claimed; it is already recorded in ${options.stateFile}`)
    return 1
  }
  const slug = asString(get(issue, 'slug')) ?? ''
  const text = `${asString(get(issue, 'title')) ?? ''}\n\n${asString(get(issue, 'body')) ?? ''}\n`
  let requestFile = ''
  try {
    requestFile = join(mkdtempSync(join(tmpdir(), 'orca-issue-')), 'request.md')
    writeFileSync(requestFile, text)
  } catch {
    log(NAME, `issue #${options.issue} was claimed as ${slug}, but its request file could not be written`)
    return 1
  }
  process.stdout.write(`slug=${slug}\nrequest_file=${requestFile}\n`)
  return 0
}

// I2。★ **abort でも exit 0 で JSON を返す**（block のときの reconcile と同じ）。止めるのは親で、理由を
//   見せてから lock を解放する
const reconcile = (options: Options): number => {
  if (step(options, ['init', '--config-json', '{"concurrency":5}', '--filter-json', '{"state":"open"}']).rc !== 0)
    return 1
  if (step(options, ['ensure-labels']).rc !== 0) return 1
  const reconciled = step(options, ['reconcile'])
  process.stdout.write(reconciled.stdout)
  return reconciled.rc === 0 ? 0 : 1
}

// I4。自分の lock だけを外す（他の owner の lock は issue-fetch.ts が拒む）
const release = (options: Options): number => (step(options, ['lock-release']).rc === 0 ? 0 : 1)

const main = (argv: string[]): number => {
  const [command = '', ...rest] = argv
  if (!COMMANDS.includes(command)) return die(NAME, USAGE)
  const options = parse(command, rest)
  if (command === 'start') return start(options)
  if (command === 'claim') return claim(options)
  if (command === 'reconcile') return reconcile(options)
  return release(options)
}

// ★ process.exit で終えない。パイプへの stdout 書き込みが途中で切れうる
process.exitCode = main(process.argv.slice(2))
