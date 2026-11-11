import { cooldownFor, parseAccountList, pickNextAccount } from './accounts.ts'
import {
  claudeTranscriptPath,
  findAgentProcess,
  parseClaudeSessionFile,
  parseCodexRollout,
  transcriptEndsWithRateLimit,
} from './agent-process.ts'
import {
  BLOCKING_DIALOG_PATTERNS,
  KILL_POLL_MS,
  KILL_TIMEOUT_MS,
  LOOP_WINDOW_MS,
  MAX_FAILOVERS_PER_WINDOW,
  RESUME_CHECK_MS,
  RESUME_PROMPT,
  SHELL_SETTLE_MS,
} from './config.ts'
import { detectLimit } from './limit-detect.ts'
import { buildResumeCommand, codexRolloutTarget } from './resume-command.ts'

import type { AccountRef, AgentKind, AgentProcess, Cooldown, LimitHit, SessionRef } from './types.ts'

export type StatusEvent = { terminalId?: string; state: 'working' | 'blocked' | 'waiting' | 'done' }

export type Deps = {
  readTerminal(terminalId: string): Promise<string[]>
  sendText(terminalId: string, text: string): Promise<boolean>
  listProcesses(): Promise<string>
  readFile(path: string): Promise<string | null>
  readFileTail(path: string): Promise<string | null>
  globTranscripts(home: string, sessionId: string): Promise<string[]>
  lsof(pid: number): Promise<string>
  copyFile(from: string, to: string): Promise<void>
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void
  isAlive(pid: number): boolean
  accountListJson(): Promise<string>
  selectAccount(agent: AgentKind, accountId: string): Promise<void>
  notify(title: string, body: string): Promise<void>
  status(text: string): Promise<void>
  log(message: string): void
  now(): number
  sleep(ms: number): Promise<void>
  schedule(ms: number, fn: () => void): void
  homeDir: string
  orcaUserData: string
}

export type Failover = { onStatus(event: StatusEvent): Promise<void> }

const AGENTS: AgentKind[] = ['claude', 'codex']
const TITLE = 'account-failover'

const DAY_MS = 24 * 60 * 60_000
// 同じ limit 表示かどうかの目印。時計の時刻だけの解除時刻は、読んだ時点で過ぎていると翌日（や翌週）に
// 繰り上がるので、日単位の余りで比べる
const signatureOf = (hit: LimitHit): string =>
  `${hit.agent}|${hit.reason}|${hit.resetsAt === null ? 'none' : hit.resetsAt % DAY_MS}`
const trimSlash = (path: string): string => path.replace(/\/+$/, '')
const formatTime = (ms: number): string => new Date(ms).toLocaleString('ja-JP')

export function createFailover(deps: Deps): Failover {
  const inFlight = new Set<string>()
  const history = new Map<string, number[]>()
  // ペインごとに、最後に処理した limit 表示と、そのときのプロセス
  const handled = new Map<string, { signature: string; pid: number }>()
  const cooldowns: Cooldown[] = []
  // 全アカウントが上限で、解除を待っているペイン
  const waiting = new Set<string>()
  let chain: Promise<void> = Promise.resolve()

  const fail = async (message: string): Promise<void> => {
    deps.log(message)
    await deps.notify(`${TITLE}: 乗り換えを中止しました`, message)
  }

  const resolveSession = async (proc: AgentProcess): Promise<SessionRef | null> => {
    if (proc.agent === 'claude') {
      const file = await deps.readFile(`${proc.home}/sessions/${proc.pid}.json`)
      const info = file === null ? null : parseClaudeSessionFile(file, proc.pid)
      if (!info) return null
      const transcriptPath = claudeTranscriptPath(
        await deps.globTranscripts(proc.home, info.sessionId),
        proc.home,
        info.sessionId,
      )
      return transcriptPath ? { agent: 'claude', ...info, transcriptPath } : null
    }
    const rollout = parseCodexRollout(await deps.lsof(proc.pid), proc.home)
    return rollout
      ? { agent: 'codex', sessionId: rollout.sessionId, cwd: '', transcriptPath: rollout.rolloutPath }
      : null
  }

  const stopProcess = async (pid: number): Promise<boolean> => {
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      deps.signal(pid, sig)
      for (let waited = 0; waited < KILL_TIMEOUT_MS; waited += KILL_POLL_MS) {
        if (!deps.isAlive(pid)) return true
        await deps.sleep(KILL_POLL_MS)
      }
      if (!deps.isAlive(pid)) return true
    }
    return false
  }

  const switchAndResume = async (
    terminalId: string,
    proc: AgentProcess,
    session: SessionRef,
    target: AccountRef,
  ): Promise<void> => {
    if (!(await stopProcess(proc.pid))) {
      await fail(`${terminalId}: ${proc.agent} (pid ${proc.pid}) が終了しないため、resume しませんでした`)
      return
    }
    await deps.selectAccount(proc.agent, target.id)
    if (proc.agent === 'codex' && trimSlash(proc.home) !== trimSlash(target.home)) {
      await deps.copyFile(session.transcriptPath, codexRolloutTarget(session.transcriptPath, proc.home, target.home))
    }
    await deps.sleep(SHELL_SETTLE_MS)
    await deps.sendText(terminalId, buildResumeCommand(proc, session, target, RESUME_PROMPT))
    history.set(terminalId, [...(history.get(terminalId) ?? []), deps.now()])

    await deps.sleep(RESUME_CHECK_MS)
    const screen = (await deps.readTerminal(terminalId)).join('\n')
    if (BLOCKING_DIALOG_PATTERNS.some((p) => p.test(screen))) {
      await deps.notify(
        `${TITLE}: 確認画面で止まっています`,
        `${terminalId}: ${proc.agent} を ${target.id} で resume しましたが、初回の確認画面が出ています。ペインで答えてください。`,
      )
      return
    }
    await deps.status(`failover: ${proc.agent} → ${target.id}`)
    await deps.notify(
      `${TITLE}: アカウントを切り替えました`,
      `${terminalId}: ${proc.agent} を ${target.id} で resume しました`,
    )
  }

  const handle = async (event: StatusEvent & { terminalId: string }, hit: LimitHit): Promise<void> => {
    const { terminalId } = event
    const proc = findAgentProcess(await deps.listProcesses(), terminalId, hit.agent, deps.homeDir)
    if (!proc) {
      await fail(`${terminalId}: limit の表示がありますが、${hit.agent} のプロセスが見つかりません`)
      return
    }
    const last = handled.get(terminalId)
    const sameLimit = last !== undefined && last.signature === signatureOf(hit)
    if (sameLimit && last.pid !== proc.pid) {
      deps.log(`${terminalId}: 乗り換え前の limit 表示なので無視します`)
      return
    }
    const session = await resolveSession(proc)
    if (!session) {
      await fail(`${terminalId}: ${hit.agent} の session を特定できないため、乗り換えませんでした`)
      return
    }
    const tail = proc.agent === 'claude' ? await deps.readFileTail(session.transcriptPath) : null
    if (proc.agent === 'claude' && !transcriptEndsWithRateLimit(tail ?? '')) {
      deps.log(`${terminalId}: 画面に limit の文言がありますが、transcript には記録がないので無視します`)
      return
    }
    handled.set(terminalId, { signature: signatureOf(hit), pid: proc.pid })

    const accounts = parseAccountList(await deps.accountListJson(), hit.agent, deps.orcaUserData, deps.homeDir)
    const current = accounts.find((a) => trimSlash(a.home) === trimSlash(proc.home))
    // 同じプロセスの同じ limit（解除待ちの再判定）は記録済み。読み直すと解除時刻が繰り上がるので足さない
    if (!sameLimit) cooldowns.push(cooldownFor(hit, current?.id ?? `unknown:${proc.home}`, deps.now()))
    const pick = pickNextAccount(accounts, proc.home, cooldowns, deps.now())

    if (pick.kind === 'none') {
      await fail(`${terminalId}: ${hit.agent} の乗り換え先のアカウントがありません`)
      return
    }
    if (pick.kind === 'wait') {
      deps.log(`${terminalId}: 全アカウントが上限のため ${formatTime(pick.until)} まで待ちます`)
      await deps.status(`failover: ${hit.agent} 待機中 (${formatTime(pick.until)})`)
      waiting.add(terminalId)
      deps.schedule(pick.until - deps.now(), () => {
        waiting.delete(terminalId)
        void onStatus(event)
      })
      return
    }
    await switchAndResume(terminalId, proc, session, pick.account)
  }

  const onStatus = async (event: StatusEvent): Promise<void> => {
    const { terminalId } = event
    if (event.state === 'working' || !terminalId) return
    if (inFlight.has(terminalId) || waiting.has(terminalId)) return
    inFlight.add(terminalId)
    try {
      const lines = await deps.readTerminal(terminalId)
      const now = new Date(deps.now())
      const hit = AGENTS.map((agent) => detectLimit(agent, lines, now)).find((h) => h !== null)
      if (!hit) return

      const recent = (history.get(terminalId) ?? []).filter((t) => deps.now() - t < LOOP_WINDOW_MS)
      history.set(terminalId, recent)
      if (recent.length >= MAX_FAILOVERS_PER_WINDOW) {
        await fail(`${terminalId}: 1 時間に ${MAX_FAILOVERS_PER_WINDOW} 回乗り換えても limit になるため止めました`)
        return
      }

      // アカウントの選択はホスト全体に効くので、全ペインで 1 本に並べる
      const run = chain.then(() => handle({ ...event, terminalId }, hit))
      chain = run.catch(() => {})
      await run
    } catch (error) {
      await fail(`${terminalId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      inFlight.delete(terminalId)
    }
  }

  return { onStatus }
}
