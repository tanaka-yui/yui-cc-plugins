// codex のフォルダの信頼（「Trust this folder?」）で止まった起動を見分け、解き方の案内を組む。
// orca-start.ts と orca-recover.ts が同じ判定と文面を使う。
import { asString, get, type Json } from './json.ts'
import { run } from './sys.ts'

import { basename, dirname } from 'node:path'

// ★ codex は信頼していないフォルダで「Trust this folder?」を出して止まり、Orca はその起動を failed にする。
//   2026-09-24 の influencer-platform で実測: worker-show の worker.lastError と dispatch.lastFailure が
//   `Agent startup blocked: agent-trust-workspace` だった。**この 2 欄だけを読む** — worker-show は端末の画面
//   （terminal.preview）も返すので、全文を探すと、この語を画面に出しているだけの worker を取り違える
export const trustBlocked = (shown: Json | null): boolean =>
  [get(shown, 'result', 'worker', 'lastError'), get(shown, 'result', 'dispatch', 'lastFailure')].some((field) =>
    (asString(field) ?? '').includes('agent-trust-workspace'),
  )

// ★ codex は信頼を worktree ごとではなく、その repository の本体の checkout の root に記録する（codex-rs の
//   resolve_root_git_project_for_trust: worktree の commondir の親）。だから一度信頼すれば以後の worktree も通る。
//   worker の worktree から git の common dir を辿って求め、読めなければ渡された path をそのまま返す。
//   ★ 空の path を git に渡さない — `git -C ''` は今のディレクトリの repository を答える
export const trustRoot = (dir: string): string => {
  if (dir === '') return ''
  const common = run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const gitDir = common.rc === 0 ? common.stdout.trim() : ''
  return basename(gitDir) === '.git' ? dirname(gitDir) : dir
}

// 案内の行。worktree は codex が動いた worktree、retry は信頼したあとに走らせる回復の 1 行
export const trustHint = (role: string, terminal: string, worktree: string, retry: string): string[] => [
  `${role}: codex stopped at its "Trust this folder?" screen${terminal === '' ? '' : ` in terminal ${terminal}`} (agent-trust-workspace).`,
  'Trust the folder on that screen, or add these two lines to ~/.codex/config.toml:',
  `  [projects."${trustRoot(worktree)}"]`,
  '  trust_level = "trusted"',
  'codex keeps that trust for the main checkout of the repository, so later worktrees of it start without asking.',
  `Then replace the failed start: ${retry}`,
]
