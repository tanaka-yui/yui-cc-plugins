// worker の成果を親ブランチへ取り込む。資源は消さない。
// Usage: node orca-merge.ts --status-dir <d> [--allow-unreviewed]
// Exit: 0 = merge 済み（冪等）/ 1 = 未 merge / 2 = 使用法エラー
import { die, log } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asString, get } from '../lib/json.ts'
import { run, runNode } from '../lib/sys.ts'

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-merge'
const HERE = dirname(fileURLToPath(import.meta.url))
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
  valueToWrite: { merged: boolean; reason?: string; branch?: string; base?: string },
): boolean => writeAtomic(file, `${JSON.stringify(valueToWrite)}\n`)
const stop = (statusDir: string, reason: string): number => {
  persist(join(statusDir, 'integration-result.json'), { merged: false, reason })
  log(NAME, reason)
  return 1
}

const received = (file: string, task: string, dispatch: string): boolean => {
  const entries = asArray(readJson(file))
  if (entries === null) return false
  const valid = entries.every((entry) => {
    if (typeof entry !== 'string') return false
    const parts = entry.split('|')
    return (
      parts.length === 4 &&
      parts[0] === 'worker_done' &&
      parts[1] !== '' &&
      parts[2] !== '' &&
      (parts[3] === 'succeeded' || parts[3] === 'failed')
    )
  })
  return valid && entries.includes(`worker_done|${task}|${dispatch}|succeeded`)
}

// 移植元の理由（bin/orca-merge.sh）:
// ★ **PR と決めた dispatch を merge しない。**両方やるとレビュー前に成果が入る。記録が無い
//   （旧版で起動した）dispatch は今までどおり通す。`stop` は integration-result.json を書くので
//   使わない — PR 側の記録を汚さない。
//
// ★ **取り込む役は記録から引く。既定を置かない。**`// "design"` と書くと、記録を書き
//   損ねた dispatch が黙って design のブランチを取り込む。取り込み先の取り違えは成果の
//   喪失につながるので、他の identity と同じく「無ければ止まる」。
//
// ★ **レビューを求めておいて verdict が 1 つも無い成果を、黙って取り込まない。**
//   実測 2026-09-12: reviewer の verdict が未配送のまま捨てられ（3 Run 中 2 Run）、
//   無レビューの成果が succeeded のまま取り込み待ちになった。
//   **worker を差し戻して閉じてはならない** — 「round 2 で打ち切り」も「諦めて進む」も
//   spec が認めた離脱経路であり、そこを塞ぐと worker は永久に差し戻される。だから
//   **人の承認を経る離散的な一手であるここ**で閉じ、明示の override だけを通す。
const main = (argv: string[]): number => {
  let statusDir = ''
  let allowUnreviewed = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--status-dir') {
      if (i + 1 >= argv.length) die(NAME, `${arg} requires a value`)
      statusDir = argv[++i] ?? ''
    } else if (arg === '--allow-unreviewed') {
      allowUnreviewed = true
    } else {
      die(NAME, `unknown option: ${arg}`)
    }
  }
  if (statusDir === '') die(NAME, '--status-dir is required')
  const workersFile = join(statusDir, 'workers.json')
  const runFile = join(statusDir, 'run.json')
  try {
    readFileSync(workersFile)
    readFileSync(runFile)
  } catch {
    die(NAME, `cannot read the dispatch state in ${statusDir}`)
  }

  const workers = readJson(workersFile)
  // ★ PR と決めた dispatch を merge しない。stop は PR 側の記録を汚すので使わない。
  if (get(workers, 'integration') === 'pr') {
    log(NAME, 'this dispatch was started to open a pull request; use orca-pr.ts instead')
    return 1
  }
  if (get(readJson(join(statusDir, 'integration-result.json')), 'merged') === true) {
    log(NAME, 'already merged')
    return 0
  }
  const repoRoot = value(runFile, 'repo_root')
  if (repoRoot === '') return stop(statusDir, 'no repository identity recorded')
  // ★ 取り込む役は記録から引く。既定を置くと別の役のブランチを取り込む。
  const role = value(workersFile, 'integration_role')
  if (role === '') return stop(statusDir, 'no integration role recorded; refusing to guess')
  const branch = asString(get(workers, 'roles', role, 'branch')) ?? ''
  if (branch === '') return stop(statusDir, `no branch identity recorded for role '${role}'; refusing to guess`)
  const baseBranch = value(workersFile, 'integration_branch')
  if (baseBranch === '') return stop(statusDir, 'no integration branch recorded; refusing to guess')
  const task = asString(get(workers, 'roles', role, 'task')) ?? ''
  const dispatch = asString(get(workers, 'roles', role, 'dispatch')) ?? ''
  if (task === '' || dispatch === '') return stop(statusDir, `the dispatch identity is incomplete for role '${role}'`)
  if (git(repoRoot, 'rev-parse', '--is-inside-work-tree').rc !== 0) {
    return stop(statusDir, 'the recorded repository is unavailable')
  }
  const status = value(join(statusDir, 'roles', role, 'status.json'), 'status')
  if (status !== 'done') return stop(statusDir, `the worker status is '${status || 'missing'}', not done`)
  if (!received(join(statusDir, 'received.json'), task, dispatch)) {
    return stop(statusDir, 'no succeeded worker_done was received for this dispatch; run orca-wait.ts first')
  }
  if (!nonempty(join(statusDir, 'roles', role, 'result.md'))) return stop(statusDir, 'result.md is missing or empty')

  // ★ verdict が届かないままレビュー済みとして取り込まない。明示 override だけ通す。
  const review = runNode(join(HERE, 'review-state.ts'), ['--status-dir', statusDir, '--role', role])
  const reviewState = review.rc === 0 ? review.stdout.trim() : 'none'
  if (reviewState === 'unreviewed' && !allowUnreviewed) {
    return stop(
      statusDir,
      `a reviewer was started for '${role}' but no delivered verdict exists; read ${statusDir}/roles/${role}/result.md and ${statusDir}/review, then pass --allow-unreviewed to take it anyway`,
    )
  }
  if (git(repoRoot, 'show-ref', '--quiet', `refs/heads/${branch}`).rc !== 0) {
    return stop(statusDir, `branch ${branch} does not exist`)
  }
  const base = git(repoRoot, 'symbolic-ref', '--short', 'HEAD')
  const current = base.rc === 0 ? base.stdout.trim() : ''
  if (current !== baseBranch) {
    return stop(
      statusDir,
      `the parent checkout is on '${current || 'detached'}', not the '${baseBranch}' it started on`,
    )
  }
  if (current === branch) return stop(statusDir, 'the parent checkout is on the worker branch itself')
  const porcelain = git(repoRoot, 'status', '--porcelain')
  if (porcelain.rc !== 0) return stop(statusDir, 'cannot inspect the parent checkout')
  if (porcelain.stdout !== '') return stop(statusDir, 'the parent checkout has uncommitted changes')
  if (git(repoRoot, 'merge', '--no-edit', branch).rc === 0) {
    if (!persist(join(statusDir, 'integration-result.json'), { merged: true, branch, base: current })) {
      log(NAME, 'merged but cannot persist the result')
      return 1
    }
    log(NAME, `merged ${branch} into ${current}`)
    return 0
  }
  git(repoRoot, 'merge', '--abort')
  return stop(statusDir, 'merge conflict; the worktree and branch are kept for manual resolution')
}

process.exitCode = main(process.argv.slice(2))
