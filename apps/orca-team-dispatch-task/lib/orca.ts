import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from './json.ts'
import { MAX_BUFFER } from './sys.ts'

import { spawnSync } from 'node:child_process'

export type OrcaResult = { rc: number; json: Json | null; stdout: string }

const APP_BUNDLE_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

// SKILL.md の `${ORCA_BIN:-${ORCA_CLI_COMMAND:-...}}` と同じ順。空文字は未設定として扱う
export const orcaBin = (): string => process.env.ORCA_BIN || process.env.ORCA_CLI_COMMAND || APP_BUNDLE_CLI

// ★ 標準入力を渡さない。`bash <<EOF` で流したとき、途中の Orca CLI がスクリプトの残りを
//   標準入力から読んでしまい、判定を黙って飛ばした（2026-09-23 実測）。stderr は捨てる。
//   ★ maxBuffer を広げる。既定の 1 MiB を越える応答（本文の長い mailbox の batch）で子が殺されると、
//   rc が失われて「Orca が答えなかった」に化ける
export const runOrca = (args: string[]): OrcaResult => {
  const child = spawnSync(orcaBin(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
  const stdout = child.stdout ?? ''
  return { rc: child.status ?? 1, json: parseJson(stdout), stdout }
}

// receipt が数えられるのは、exit 0 で、かつ Orca が ok: true と答えたときだけ
export const receiptOk = (result: OrcaResult): boolean => result.rc === 0 && get(result.json, 'ok') === true

// 受理された receipt の result.<field> が期待した形のときだけ返す。それ以外は null（fail closed）
export const receiptArray = (result: OrcaResult, field: string): Json[] | null =>
  receiptOk(result) ? asArray(get(result.json, 'result', field)) : null

export const receiptObject = (result: OrcaResult, field: string): JsonObject | null =>
  receiptOk(result) ? asObject(get(result.json, 'result', field)) : null

// worker の端末の release state の分類（orca-cleanup.ts から移した。orca-stop.ts も同じ分類で読む）
export const HELD_STATES = ['release_pending', 'release_unknown']
export const GONE_STATES = ['released', 'already_released']
export const LIVE_STATES = ['not_requested', 'retained', 'active', 'reclaimable']

// jq の `.resource.releaseState // .terminalState // empty` と同じ読み方
export const releaseState = (worker: Json | undefined): string =>
  asString(get(worker, 'resource', 'releaseState')) ?? asString(get(worker, 'terminalState')) ?? ''

// ★ **ユーザーが操作した端末は、Orca が worker-release で閉じない。**worker-list の `resource.ownershipState` が
//   `user_owned` になり、release は ok を返しながら何も閉じず、出力の archive も作らない。`retainedReason` は
//   `user_takeover` とは限らず、Step 3 の worker-retain が付けた `user_requested` のまま残る（2026-09-23 と 24 に
//   4 Run の design で実測）。だから retainedReason ではなく ownership を見る
export const userOwned = (worker: Json | undefined): boolean =>
  get(worker, 'resource', 'ownershipState') === 'user_owned'

// ★ **worker-show の `result.worker.state` の分類はここだけに置く。**orca-wait / orca-stop / orca-recover / orca-wake が
//   それぞれ同じ配列を持っていた頃、`start_unknown` はどれにも無く、待機は exit 4、停止は何も打たず、回復は何もしない、の
//   3 つの行き止まりになった（2026-09-24、influencer-platform の Run）。
//   - live: 走っている証拠
//   - unconfirmed: **生死のどちらの証拠でもない。**Orca は依頼を入力したが、agent のターン開始を観測できなかった
//     （worker.stage は turn_start_unobserved）。2026-09-24 の実測で、influencer-platform の reviewer（codex）は動いて
//     依頼を待っていたのに 15 分以上この state のままで、yui-cc-plugins の P2 の exec（codex）は同じ state のまま、自動更新の
//     あとシェルへ戻って死んでいた。どちらも端末は connected だった
//   - settled: 自分で報告して終わった（worker_done を送った）。Orca 側では決着している
//   - other: それ以外（stopped / outcome_unknown / 空 / 知らない値）。各入口が今までどおり扱う
export type WorkerStateClass = 'live' | 'unconfirmed' | 'settled' | 'other'
const LIVE_WORKER_STATES = ['active', 'ready', 'starting', 'idle']
const UNCONFIRMED_WORKER_STATES = ['start_unknown']
const SETTLED_WORKER_STATES = ['succeeded', 'failed']
export const workerStateClass = (state: string): WorkerStateClass => {
  if (LIVE_WORKER_STATES.includes(state)) return 'live'
  if (UNCONFIRMED_WORKER_STATES.includes(state)) return 'unconfirmed'
  if (SETTLED_WORKER_STATES.includes(state)) return 'settled'
  return 'other'
}

// worker-show の `result.dispatch.status` が、Orca 側で dispatch が決着したと言っているか
const SETTLED_DISPATCH_STATUSES = ['completed', 'failed', 'settled', 'terminated']
export const dispatchSettled = (status: string): boolean => SETTLED_DISPATCH_STATUSES.includes(status)

// その dispatch の agent 端末。ready にならなかった試行にも Orca は handle を出す（2026-09-24 実測）
export const workerTerminal = (shown: Json | null): string =>
  asString(get(shown, 'result', 'worker', 'agentTerminalHandle')) ?? ''

// 失敗した receipt を 1 行で言う。rc と、あれば error.code / error.message
export const failureDetail = (result: OrcaResult): string => {
  const code = asString(get(result.json, 'error', 'code'))
  const message = asString(get(result.json, 'error', 'message')) ?? asString(get(result.json, 'error'))
  return [`rc=${result.rc}`, code, message].filter((part) => part !== null && part !== '').join('; ')
}

// その Run の worker 一覧。読めなければ null（読めないことを「居ない」と取り違えない）
export const listWorkers = (run: string): Json[] | null =>
  receiptArray(runOrca(['orchestration', 'worker-list', '--run', run, '--json']), 'workers')

// worktree に今ある端末の handle。★ **列挙できないことを「0 件」と取り違えない** — 読めなければ null
export const terminalHandles = (worktreeId: string): Json[] | null => {
  const listed = receiptArray(runOrca(['terminal', 'list', '--worktree', `id:${worktreeId}`, '--json']), 'terminals')
  return listed === null ? null : listed.map((entry) => get(entry, 'handle') ?? null)
}
