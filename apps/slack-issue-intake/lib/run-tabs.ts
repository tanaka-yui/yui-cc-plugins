import {
  RUN_LEASE_MS,
  RUN_TAB_DONE_STATUS,
  RUN_TAB_FAILED_STATUS,
  RUN_TAB_QUIET_MS,
  RUN_TAB_RUNS_LIMIT,
  RUN_TAB_TERMINALS_LIMIT,
} from './defaults.ts'
import { asArray, asString, get } from './json.ts'
import { runOrca } from './orca.ts'

import type { Json } from './json.ts'

const asNumber = (value: Json | undefined): number | null => (typeof value === 'number' ? value : null)

// 終わった回の端末（ptyId）。completed は Orca が Claude の終了を見た回。dispatch_failed は Orca が見失った回で、
// まだ動いているかもしれないので、手順の実行のリースより古いものだけを数える
export const finishedPtyIds = (runs: Json[], now: number): Set<string> => {
  const ids = new Set<string>()
  for (const run of runs) {
    const pty = asString(get(run, 'terminalPtyId'))
    const status = asString(get(run, 'status'))
    const startedAt = asNumber(get(run, 'startedAt'))
    if (!pty) continue
    if (
      status === RUN_TAB_DONE_STATUS ||
      (status === RUN_TAB_FAILED_STATUS && startedAt !== null && now - startedAt > RUN_LEASE_MS)
    )
      ids.add(pty)
  }
  return ids
}

// 閉じる端末の handle。直前まで出力のあった端末は、人が続きを打っているかもしれないので次の回に回す
export const tabsToClose = (terminals: Json[], ptyIds: Set<string>, now: number): string[] =>
  terminals.flatMap((terminal) => {
    const handle = asString(get(terminal, 'handle'))
    const pty = asString(get(terminal, 'ptyId'))
    const lastOutputAt = asNumber(get(terminal, 'lastOutputAt'))
    if (!handle || !pty || !ptyIds.has(pty)) return []
    return lastOutputAt !== null && now - lastOutputAt < RUN_TAB_QUIET_MS ? [] : [handle]
  })

// automation が起動のたびに開く Claude のタブ（--fresh-session）を、終わった回の分だけ閉じる。
// 自分の automation の履歴にある端末だけが対象で、人が開いた端末と動作中の回には触れない
export const closeFinishedRunTabs = (
  automationId: string,
  deadline: number,
  now = Date.now(),
): { closed: number; errors: string[] } => {
  const left = (): number => deadline - Date.now()
  const runs = runOrca(['automations', 'runs', '--id', automationId, '--limit', String(RUN_TAB_RUNS_LIMIT)], left())
  const rows = runs.ok ? asArray(get(runs.json ?? undefined, 'result', 'runs')) : null
  if (!rows) return { closed: 0, errors: [`automation の実行履歴を読めません: ${runs.stderr}`] }
  const ptyIds = finishedPtyIds(rows, now)
  if (!ptyIds.size || left() <= 0) return { closed: 0, errors: [] }
  const listed = runOrca(['terminal', 'list', '--limit', String(RUN_TAB_TERMINALS_LIMIT)], left())
  const terminals = listed.ok ? asArray(get(listed.json ?? undefined, 'result', 'terminals')) : null
  if (!terminals) return { closed: 0, errors: [`端末の一覧を読めません: ${listed.stderr}`] }
  let closed = 0
  const errors: string[] = []
  for (const handle of tabsToClose(terminals, ptyIds, now)) {
    if (left() <= 0) break
    const result = runOrca(['terminal', 'close', '--terminal', handle], left())
    if (result.ok) closed++
    else errors.push(`終わった回のタブを閉じられません: ${handle} ${result.stderr}`)
  }
  return { closed, errors }
}
