// タスクの子（worker）が最後に書いた時刻と、端末で人の答えを待っている役の判定（orca-wait と orca-wake が共有する）。
//
// ★ **1 箇所に置く理由。**待機（停滞の時計を戻す）と起床（入力欄に打たない）が同じ問い「その役は端末で答えを
//   待っているか」を別々に答えると、片方だけ直されてずれる。最終レビューで、reviewer を止めたときの
//   review-skipped の起床が、答えを待つ design の入力欄に 1 行を打ち込む経路が見つかった
import { readJson } from './fs.ts'
import { asObject, asString, get } from './json.ts'
import { run } from './sys.ts'

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const fileMtime = (file: string): number => {
  try {
    return Math.floor(statSync(file).mtimeMs / 1000)
  } catch {
    return 0
  }
}
// 移植元の理由（bin/orca-wait.sh）:
// ★ **停滞は親が見つけ、止めるかどうかは人が決める。**子は待機に期限を持たない（待っている
//   相手の事情を知らないので「来ない」を判断できない）。タスク単位で「子が書くもの」が一定時間
//   どれも変わらなければ知らせる。**親が書くもの（wait.json / .woken / received.json /
//   questions.json / stall.json）は数えない** — 数えると親の鼓動で常に「変化あり」になる。
// ★ **human.json は含めない** — 親が毎周書くので、含めると awaiting-user.json が 2 周目から「最新」でなくなる。
//   awaiting-user.json は子が書くので含める
export const workerLastChange = (statusDir: string): number => {
  let latest = fileMtime(join(statusDir, 'run.json'))
  const newer = (file: string): void => {
    latest = Math.max(latest, fileMtime(file))
  }
  const rolesDir = join(statusDir, 'roles')
  try {
    for (const role of readdirSync(rolesDir)) {
      for (const name of ['status.json', 'result.md', 'completion.json', 'awaiting-user.json'])
        newer(join(rolesDir, role, name))
    }
  } catch {
    /* 子のファイルがまだ無い */
  }
  for (const name of ['spec.md', 'plan.md']) newer(join(statusDir, name))
  try {
    for (const name of readdirSync(join(statusDir, 'review'))) newer(join(statusDir, 'review', name))
  } catch {
    /* review はまだ無い */
  }
  const workers = readJson(join(statusDir, 'workers.json'))
  for (const role of Object.values(asObject(get(workers, 'roles')) ?? {})) {
    const worktree = asString(get(role, 'worktree_path')) ?? ''
    if (worktree === '' || !existsSync(worktree)) continue
    const last = run('git', ['-C', worktree, 'log', '-1', '--format=%ct'])
    latest = Math.max(latest, Number(last.stdout.trim()) || 0)
    const changed = run('git', ['-C', worktree, 'status', '--porcelain'])
    for (const line of changed.stdout.split('\n')) {
      if (line.length < 4) continue
      newer(join(worktree, line.slice(3)))
    }
  }
  return latest
}
// ★ **端末で人の答えを待つ役。**Orca の agentWait はターンを終えて端末で待つ状態を拾わない（実測 2026-09-24、
//   logi-app: state=ready・agentWait=null）。ask_via=terminal の worker は尋ねる前に awaiting-user.json を書く。
//   それがタスクで子が最後に書いたものである間は人を待っている。答えのあとに何か書けば自然に外れる。
//   待っていればその印の時刻を、待っていなければ 0 を返す。latest は呼び出し側が 1 周で使い回すために受け取る
export const awaitingSince = (statusDir: string, role: string, latest = workerLastChange(statusDir)): number => {
  const at = fileMtime(join(statusDir, 'roles', role, 'awaiting-user.json'))
  return at > 0 && at >= latest ? at : 0
}
