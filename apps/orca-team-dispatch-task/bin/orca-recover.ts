// 完了を託した worker が失われたとき、または起動が終わらなかったときに、その役の owner を回復する
// （旧版 orca-recover の移植。spec 10-1 / F-e）。
//
// Usage: node orca-recover.ts --status-dir <d> [--role <r>] [--dry-run]
// Exit:  0 = 判断して行動した（何もしないという判断を含む）/ 1 = 判断できない / 2 = 使用法エラー
//
// ★ **なぜ要るか。**O33 により **親は `worker_done` を代理送信できない。**元の agent process が消えたら
//   誰も送れない。これは失敗系だけでなく、`completion.json = accepted` の後・`worker_done` の前に worker が
//   失われた**成功系にも同じく存在する**。
// ★ **回復するのは「durable intent を実行できる owner」であって、completion の exactly-once journal ではない。**
// ★ **fence が先。**旧 capability と新 capability が同時に lifecycle を進めてはならない。だから
//   `outcome_unknown` では replacement を作らない（O19）。
import { die, log } from '../lib/cli.ts'
import { startIncomplete } from '../lib/dispatch.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject } from '../lib/json.ts'
import { failureDetail, orcaBin, receiptOk, runOrca, terminalHandles } from '../lib/orca.ts'
import { nowSeconds, runNode } from '../lib/sys.ts'

import { accessSync, constants, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'orca-recover'
const HERE = dirname(fileURLToPath(import.meta.url))
const COMPLETION = join(HERE, '..', 'skills', 'orca-team-dispatch-task', 'scripts', 'completion.ts')
const WAKE = join(HERE, 'orca-wake.ts')
const TERMINAL_STATUSES = ['completed', 'failed', 'settled', 'terminated']
const LIVE_STATES = ['active', 'ready', 'starting', 'idle']

const readable = (file: string): boolean => {
  try {
    accessSync(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// jq -r で読んで `^[0-9]+$` に合うか、と同じ判定（数値でも数字だけの文字列でもよい）
const count = (value: Json | undefined): number | null => {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

// ★ **回復に入る前に「誰か待っているか」を言う。**待機は最大 24 時間常駐するので外から止められることがあり、
//   止まったままだと worker は生きているのに誰も受理を返さない。要るのは待機の起動し直しである。
//   **役ごとの判断は変えない** — 見落とさせないために言うだけである
const reportWait = (statusDir: string): void => {
  const stamp = readJson(join(statusDir, 'wait.json'))
  if (stamp === null) {
    log(NAME, 'no wait has stamped this status dir; if a worker is alive, start orca-wait.ts before recovering')
    return
  }
  const beat = count(get(stamp, 'beat'))
  if (beat === null) return
  const windowMs = count(get(stamp, 'window_ms')) ?? 300000
  // ★ 沈黙 3 窓ぶんで「居ない」とみなす。1 窓は待ちの上限そのものなので、2 窓では正常な 1 回の待ちを
  //   死んだと呼びかねない
  const limit = Math.max(Math.floor(windowMs / 1000) * 3, 60)
  const age = nowSeconds() - beat
  if (age >= limit) {
    log(
      NAME,
      `no wait has answered for ${age}s (its window is ${Math.floor(windowMs / 1000)}s); start orca-wait.ts again before recovering`,
    )
  }
}

type Role = { name: string; dispatch: string; task: string; record: JsonObject }

// ★ **失われたことが証明された役を、同じ Task へ置き換える。**`task-create` は走らせない — Task は既に在る。
//   generation を上げ（旧 generation の accepted は nonce 照合で落ちる）、置き換えた dispatch を `superseded`
//   に残す（Orca がそれを retained のまま持っていても、[C7] が「記録に無い保持」と数えないため）。
//   新しい agent 端末が同じ worktree に生まれるので、端末の inventory も取り直す（取り直さないと [C3] が
//   「記録に無い端末が居る」と読み、worktree の片付けを提示できない）
const replace = (statusDir: string, parent: string, role: Role): boolean => {
  const worktreeId = asString(role.record.worktree_id) ?? ''
  if (worktreeId === '') {
    log(NAME, `${role.name}: no worktree recorded; refusing to place a replacement`)
    return false
  }
  const agent = asString(role.record.agent) ?? 'claude'
  const model = asString(role.record.model) ?? ''
  const effort = asString(role.record.effort) ?? ''
  const args = ['--task', role.task, '--worktree', `id:${worktreeId}`, '--retry-of', role.dispatch]
  args.push('--agent', agent, '--from', parent)
  if (model !== '') {
    args.push('--model', model)
    if (effort !== '') args.push('--effort', effort)
  }
  const started = runOrca(['orchestration', 'worker-start', ...args, '--json'])
  const next = asString(get(started.json, 'result', 'dispatchId')) ?? ''
  const state = asString(get(started.json, 'result', 'state')) ?? ''
  const ready = started.rc === 0 && state === 'ready' && next !== ''
  if (next === '') {
    log(NAME, `${role.name}: could not start a replacement (rc=${started.rc}); the old resources are KEPT`)
    return false
  }
  const terminal = ready
    ? (asString(
        get(
          (asArray(get(started.json, 'result', 'effects')) ?? []).find(
            (effect) => get(effect, 'kind') === 'terminal' && get(effect, 'role') === 'agent',
          ),
          'id',
        ),
      ) ?? '')
    : ''
  const generation = (count(role.record.generation) ?? 1) + 1
  const superseded = (asArray(role.record.superseded) ?? []).filter((id) => typeof id === 'string')
  const workersFile = join(statusDir, 'workers.json')
  const workers = asObject(readJson(workersFile))
  const roles = asObject(get(workers, 'roles'))
  const current = asObject(get(workers, 'roles', role.name))
  // ★ **発行された dispatch は ready でなくても記録する**（orca-start の record_orphan_dispatch と同じ理由）。
  //   捨てると、次の回復は古い dispatch を --retry-of に渡し直し、新しい試行は誰にも追われないまま残る。
  //   ready でなければ端末は記録しない — その役は「起動が終わらなかった」まま、次の回復がこの試行を見る
  const updated: JsonObject = {
    ...(current ?? {}),
    dispatch: next,
    terminal,
    generation,
    retained: false,
    superseded: [...superseded, role.dispatch],
    worktree_terminals: terminalHandles(worktreeId),
  }
  if (ready) delete updated.start_incomplete
  else updated.start_incomplete = true
  const inspect = `  ${orcaBin()} orchestration worker-show --dispatch ${next} --json`
  if (
    workers === null ||
    roles === null ||
    !writeAtomic(workersFile, `${JSON.stringify({ ...workers, roles: { ...roles, [role.name]: updated } })}\n`)
  ) {
    log(
      NAME,
      `${role.name}: dispatch ${next} was issued but could not be recorded in ${workersFile}; record it there as the ${role.name} dispatch before running this again. Inspect with:`,
    )
    log(NAME, inspect)
    return false
  }
  if (!ready) {
    log(
      NAME,
      `${role.name}: the replacement did not report ready (rc=${started.rc} state='${state || 'none'}'); dispatch ${next} is recorded in place of ${role.dispatch}. Run this again once Orca reports it failed or stopped. Inspect with:`,
    )
    log(NAME, inspect)
    return false
  }
  // 旧試行の完了記録は捨てる。新しい worker は新しい nonce で offer し直す
  rmSync(join(statusDir, 'roles', role.name, 'completion.json'), { force: true })
  log(NAME, `${role.name}: replaced dispatch ${role.dispatch} with ${next} (generation ${generation})`)
  return true
}

// ★ **起動が終わらなかった試行の端末は、その dispatch が持ったまま `reclaimable` で残る**（Orca の
//   recovery-and-cleanup）。Orca の勧めどおり release で閉じる（出力は保存される）。手で閉じると
//   user_takeover として残る。**閉じられなくても置き換えは止めない** — その dispatch は superseded として
//   記録に残るので、[C7] は止まらない
const releaseFailedStart = (role: Role): void => {
  const released = runOrca(['orchestration', 'worker-release', '--dispatch', role.dispatch, '--json'])
  if (receiptOk(released)) {
    log(NAME, `${role.name}: asked Orca to release the terminal of the failed start (dispatch ${role.dispatch})`)
  } else {
    log(
      NAME,
      `${role.name}: could not release the terminal of the failed start (dispatch ${role.dispatch}, ${failureDetail(released)}); it stays recorded as superseded`,
    )
  }
}

const main = (argv: string[]): number => {
  let statusDir = ''
  let onlyRole = ''
  let dryRun = false
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index] ?? ''
    if (flag === '--dry-run') {
      dryRun = true
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (flag !== '--status-dir' && flag !== '--role') return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    if (flag === '--status-dir') statusDir = value
    else onlyRole = value
    index += 2
  }
  if (statusDir === '') return die(NAME, '--status-dir is required')
  const workersFile = join(statusDir, 'workers.json')
  if (!readable(workersFile) || !readable(join(statusDir, 'run.json'))) {
    return die(NAME, `cannot read the dispatch state in ${statusDir}`)
  }
  const parent = asString(get(readJson(join(statusDir, 'run.json')), 'parent_handle')) ?? ''
  if (parent === '') return die(NAME, 'no parent handle recorded')
  reportWait(statusDir)

  const say = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const phaseOf = (roleDir: string): string => {
    const result = runNode(COMPLETION, ['--role-dir', roleDir, 'phase'])
    return result.rc === 0 ? result.stdout.replace(/\n+$/, '') : ''
  }

  let rc = 0
  const roles = asObject(get(readJson(workersFile), 'roles')) ?? {}
  // jq の `.roles | keys[]` と同じく、役名の順に回す
  for (const name of Object.keys(roles).sort()) {
    if (onlyRole !== '' && onlyRole !== name) continue
    const record = asObject(roles[name]) ?? {}
    const role: Role = {
      name,
      dispatch: asString(record.dispatch) ?? '',
      task: asString(record.task) ?? '',
      record,
    }
    if (role.dispatch === '' || role.task === '') continue
    const roleDir = join(statusDir, 'roles', name)
    // ★ **ユーザーが止めた役には何もしない**（orca-stop.ts）。置き換えると、止めた役が別の端末で生き返る
    if (isFile(join(roleDir, 'stopped.json'))) {
      log(NAME, `${name}: stopped by the user; not recovering it`)
      continue
    }
    // ★ **起動が終わらなかった役は「起動」を負っている。**完了を負っているかの判定より先に見る
    const incomplete = startIncomplete(statusDir, name)
    const phase = incomplete ? '' : phaseOf(roleDir)
    if (!incomplete) {
      // ★ **その役に「まだ送るべきもの」があるか。**無いなら回復するものも無い。
      //   成功系は completion.json が settled でないこと、失敗系は status.json = error である
      const status = asString(get(readJson(join(roleDir, 'status.json')), 'status')) ?? ''
      if (phase === 'settled') {
        log(NAME, `${name}: already settled locally; nothing is owed`)
        continue
      }
      if (phase === '' && status !== 'error') {
        log(NAME, `${name}: nothing is owed yet (phase '${phase || 'none'}', status '${status || 'none'}')`)
        continue
      }
    }
    const shown = runOrca(['orchestration', 'worker-show', '--dispatch', role.dispatch, '--json'])
    if (!receiptOk(shown) || asObject(get(shown.json, 'result')) === null) {
      log(NAME, `${name}: cannot read the worker state for dispatch '${role.dispatch}'; not deciding anything`)
      rc = 1
      continue
    }
    const state = asString(get(shown.json, 'result', 'worker', 'state')) ?? ''
    const dispatchStatus = asString(get(shown.json, 'result', 'dispatch', 'status')) ?? ''
    const inspect = (): void => {
      log(NAME, `  ${orcaBin()} orchestration worker-show --dispatch ${role.dispatch} --json`)
    }

    if (incomplete) {
      // ★ **置き換えてよいのは、失敗か停止が証明された試行だけ**（Orca の recovery-and-cleanup）。
      //   それ以外（まだ起動中・outcome_unknown など）は見るだけにする
      if (state !== 'failed' && state !== 'stopped') {
        log(
          NAME,
          `${name}: its start did not complete and Orca reports the worker as '${state || 'unknown'}'; not replacing anything. Inspect with:`,
        )
        inspect()
        rc = 1
        continue
      }
      if (dryRun) {
        say(`${name}: replace the failed start`)
        continue
      }
      releaseFailedStart(role)
      if (!replace(statusDir, parent, role)) rc = 1
      continue
    }

    if (TERMINAL_STATUSES.includes(dispatchStatus)) {
      // ★ **Orca 側が既に terminal。送らない。**ローカルを合わせて終わる
      if (dryRun) {
        say(`${name}: reconcile (orca is terminal)`)
        continue
      }
      if (phase !== '' && phase !== 'settled' && runNode(COMPLETION, ['--role-dir', roleDir, 'reconcile']).rc !== 0) {
        log(NAME, `${name}: could not reconcile the local record to settled`)
      }
      log(NAME, `${name}: Orca already settled this dispatch; reconciled locally`)
      continue
    }
    if (LIVE_STATES.includes(state)) {
      // ★ **生きているなら nudge するだけ。**replacement を作ると、旧 capability と新 capability が
      //   同時に lifecycle を進めうる
      if (dryRun) {
        say(`${name}: nudge`)
        continue
      }
      const nudged = runOrca([
        'orchestration',
        'send',
        '--to',
        `dispatch:${role.dispatch}`,
        '--type',
        'status',
        '--subject',
        `completion-nudge: ${name}`,
        '--body',
        'your completion is still owed; continue from your completion record',
        '--from',
        parent,
        '--json',
      ])
      if (nudged.rc === 0) {
        log(NAME, `${name}: nudged the live worker`)
      } else {
        log(NAME, `${name}: could not nudge dispatch '${role.dispatch}'`)
        rc = 1
      }
      // ★ **nudge も届くだけでは起こせない。****ベストエフォート** — 起こせないことは「回復できなかった」
      //   ではないので rc を汚さない
      if (runNode(WAKE, ['--workers', workersFile, '--role', name]).rc !== 0) {
        log(NAME, `${name}: could not wake its terminal; the nudge may sit unread`)
      }
      continue
    }
    if (state === 'failed' || state === 'stopped') {
      // ★ **失われたことが証明された。**同じ Task へ replacement を作る
      if (dryRun) {
        say(`${name}: replace`)
        continue
      }
      if (!replace(statusDir, parent, role)) rc = 1
      continue
    }
    // ★ `outcome_unknown` を含め、**確認できないものでは replacement を作らない**（O19）
    log(NAME, `${name}: the worker state is '${state || 'unknown'}'; not replacing anything. Inspect with:`)
    inspect()
    rc = 1
  }
  return rc
}

process.exitCode = main(process.argv.slice(2))
