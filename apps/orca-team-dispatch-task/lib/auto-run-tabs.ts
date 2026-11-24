import { AUTO_CALL_CAP_MS, AUTO_JUDGE_LEASE_MS, hasAutoTime } from './auto-paths.ts'
import { asString, get, type Json } from './json.ts'
import { receiptArray, receiptOk, runOrca } from './orca.ts'

export const RUN_TAB_DONE_STATUS = 'completed'
export const RUN_TAB_FAILED_STATUS = 'dispatch_failed'
// 直前まで出力のあったタブは人が使っているかもしれないので、これだけ静かになってから閉じる
export const RUN_TAB_QUIET_MS = 180_000
export const RUN_TAB_RUNS_LIMIT = 100
export const RUN_TAB_TERMINALS_LIMIT = 1000

const asNumber = (value: Json | undefined): number | null => (typeof value === 'number' ? value : null)

// 終わった回の端末（ptyId）。completed は Orca が判定役の終了を見た回。dispatch_failed は Orca が見失った回で、
// まだ判定しているかもしれないので、判定のリースより古いものだけを数える
export const finishedPtyIds = (runs: Json[], now: number): Set<string> => {
  const ids = new Set<string>()
  for (const run of runs) {
    const pty = asString(get(run, 'terminalPtyId'))
    const status = asString(get(run, 'status'))
    const startedAt = asNumber(get(run, 'startedAt'))
    if (!pty) continue
    if (
      status === RUN_TAB_DONE_STATUS ||
      (status === RUN_TAB_FAILED_STATUS && startedAt !== null && now - startedAt > AUTO_JUDGE_LEASE_MS)
    )
      ids.add(pty)
  }
  return ids
}

// 閉じる端末の handle。履歴の ptyId と一致し、静かになったものだけ
export const tabsToClose = (terminals: Json[], ptyIds: Set<string>, now: number): string[] =>
  terminals.flatMap((terminal) => {
    const handle = asString(get(terminal, 'handle'))
    const pty = asString(get(terminal, 'ptyId'))
    const lastOutputAt = asNumber(get(terminal, 'lastOutputAt'))
    if (!handle || !pty || !ptyIds.has(pty)) return []
    return lastOutputAt !== null && now - lastOutputAt < RUN_TAB_QUIET_MS ? [] : [handle]
  })

// automation が起動のたびに開く判定役のタブ（--fresh-session）を、終わった回の分だけ閉じる。
// 自分の automation の履歴にある端末だけが対象で、worker・調整役・人が開いた端末と動作中の回には触れない。
// 予算が残っていなければ何もしない（次の tick がやる）。失敗は 1 行出すだけで tick の結果は変えない
export const closeFinishedRunTabs = (automationId: string, log: (line: string) => void, now = Date.now()): number => {
  const call = (args: string[]) => (hasAutoTime(AUTO_CALL_CAP_MS) ? runOrca(args, undefined, AUTO_CALL_CAP_MS) : null)
  const runs = call(['automations', 'runs', '--id', automationId, '--limit', String(RUN_TAB_RUNS_LIMIT), '--json'])
  if (!runs) return 0
  const rows = receiptArray(runs, 'runs')
  if (!rows) {
    log('automation の実行履歴を読めません（終わった回のタブを閉じられません）')
    return 0
  }
  const ptyIds = finishedPtyIds(rows, now)
  if (!ptyIds.size) return 0
  const listed = call(['terminal', 'list', '--limit', String(RUN_TAB_TERMINALS_LIMIT), '--json'])
  if (!listed) return 0
  const terminals = receiptArray(listed, 'terminals')
  if (!terminals) {
    log('端末の一覧を読めません（終わった回のタブを閉じられません）')
    return 0
  }
  let closed = 0
  for (const handle of tabsToClose(terminals, ptyIds, now)) {
    const result = call(['terminal', 'close', '--terminal', handle, '--json'])
    if (!result) break
    if (receiptOk(result)) closed++
    else log(`終わった回のタブを閉じられません: ${handle}`)
  }
  return closed
}
