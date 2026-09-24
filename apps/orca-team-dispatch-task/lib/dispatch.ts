// dispatch の記録（status dir）を読む共通部品。orca-start.ts と orca-recover.ts が同じ問いを使う。
import { readJson } from './fs.ts'
import { asString, get } from './json.ts'

import { join } from 'node:path'

// ★ **起動が終わらなかった役（最新の試行が ready にならなかった役）。**orca-start と orca-recover は、
//   worker-start が ready を返さなかったとき、返ってきた dispatch を記録して `start_incomplete: true` を付け、
//   端末は記録しない（兄弟の待機を詰まらせないため、そして次の回復が最新の試行を見るため）。
//   **役の成果の status（done / error）や古い completion とは別に追う** — それらは前の試行が残したもので、
//   最新の試行が起きたかどうかは言わない（round 2 のレビュー: 完了を負う役の置き換えが失敗したあと、
//   status だけで判定すると、次の回復は古い completion を settled にして終わっていた）。
//   `start_incomplete` を書く前の版の記録は、端末が無く status が `starting` のままであることで読む
export const startIncomplete = (statusDir: string, role: string): boolean => {
  const workers = readJson(join(statusDir, 'workers.json'))
  const field = (name: string): string => asString(get(workers, 'roles', role, name)) ?? ''
  if (field('dispatch') === '') return false
  if (get(workers, 'roles', role, 'start_incomplete') === true) return true
  const status = asString(get(readJson(join(statusDir, 'roles', role, 'status.json')), 'status')) ?? ''
  return field('terminal') === '' && status === 'starting'
}
