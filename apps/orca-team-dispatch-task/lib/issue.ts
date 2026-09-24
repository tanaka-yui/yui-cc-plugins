// issue モードの state file の置き場所と、その directory を親 checkout の除外へ入れる処理。
// orca-issue.ts と orca-issue-loop.ts が同じ規則を使う（2 箇所に書くと片方だけ直されてずれる）。
import { run } from './sys.ts'

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

// ★ SKILL.md の I0 が `$RR/.dispatch-issue/state.json` と block に書いていた場所。block の間で STATE を
//   運ばせず、入口が repo root からここで決める（shell 変数は tool call を跨がない）
export const defaultStateFile = (repoRoot: string): string => join(repoRoot, '.dispatch-issue', 'state.json')

// 移植元の理由（bin/orca-issue.sh）:
// ★ **state ディレクトリを repo の除外へ入れる。**`.dispatch/` と同じ理由である —
//   入れないと state file と lock で親が常に dirty になり、`orca-merge.ts` の dirty
//   ガードが必ず発火して **1 件も merge できない**（実測）。state file の置き場所は
//   呼び出し側が決めるので、その directory 名を除外する。
//   ★ **両辺を同じ形に揃えてから比べる。**片方だけ `pwd -P` で symlink を解決すると、
//   macOS の `/var` → `/private/var` のように **repo root が symlink 越しのとき必ず外れる**
//   （実測: fixture の親が `?? .dispatch-issue/` のままになり merge が 1 件も通らない）。
export const excludeStateDir = (stateFile: string, repoRoot: string): void => {
  let stateDir = ''
  let repoDir = repoRoot
  try {
    stateDir = realpathSync(dirname(stateFile))
  } catch {
    /* 見つからないなら追加しない */
  }
  try {
    repoDir = realpathSync(repoDir)
  } catch {
    /* 元の値で比べる */
  }
  if (stateDir === '' || !stateDir.startsWith(`${repoDir}/`)) return
  const exclude = run('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'info/exclude'])
  const excludePath = exclude.stdout.trim()
  if (exclude.rc !== 0 || excludePath === '') return
  const entry = `${relative(repoDir, stateDir)}/`
  const path = isAbsolute(excludePath) ? excludePath : join(repoRoot, excludePath)
  try {
    mkdirSync(dirname(path), { recursive: true })
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      /* まだ無い exclude は空として扱う */
    }
    if (!current.split('\n').includes(entry)) appendFileSync(path, `${entry}\n`)
  } catch {
    /* 除外に失敗しても dispatch は続ける */
  }
}
