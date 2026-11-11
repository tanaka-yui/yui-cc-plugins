import { cooldownFor, parseAccountList, pickNextAccount } from './accounts.ts'
import {
  claudeTranscriptPath,
  findAgentProcess,
  lastRateLimitId,
  parseClaudeSessionFile,
  parseCodexRollout,
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
  pathExists(path: string): boolean
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
// Codex の同じ limit 表示かどうかの目印。時計の時刻だけの解除時刻は、読んだ時点で過ぎていると翌日（や翌週）に
// 繰り上がるので、日単位の余りで比べる。Claude は transcript のエントリの uuid を使う
const codexSignature = (hit: LimitHit): string =>
  `codex|${hit.reason}|${hit.resetsAt === null ? 'none' : hit.resetsAt % DAY_MS}`
const trimSlash = (path: string): string => path.replace(/\/+$/, '')
const formatTime = (ms: number): string => new Date(ms).toLocaleString('ja-JP')

export function createFailover(deps: Deps): Failover {
  const inFlight = new Set<string>()
  const history = new Map<string, number[]>()
  // ペインごとに、最後に処理した limit と、そのときのプロセス
  const handled = new Map<string, { signature: string; pid: number }>()
  // ペインごとに、最後に出した通知。同じ内容を繰り返し出さない
  const lastNotice = new Map<string, string>()
  const cooldowns: Cooldown[] = []
  // 全アカウントが上限で、解除を待っているペイン
  const waiting = new Set<string>()
  let chain: Promise<void> = Promise.resolve()

  const notifyOnce = async (terminalId: string, title: string, body: string): Promise<void> => {
    deps.log(body)
    const key = `${title}|${body}`
    if (lastNotice.get(terminalId) === key) return
    lastNotice.set(terminalId, key)
    await deps.notify(title, body)
  }
  const fail = (terminalId: string, message: string): Promise<void> =>
    notifyOnce(terminalId, `${TITLE}: 乗り換えを中止しました`, `${terminalId}: ${message}`)

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
    // 選択は以後の起動にしか効かないので先に行う。失敗したらプロセスには触らない
    try {
      await deps.selectAccount(proc.agent, target.id)
    } catch (error) {
      await fail(
        terminalId,
        `アカウントを ${target.id} に切り替えられませんでした: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!(await stopProcess(proc.pid))) {
      await fail(terminalId, `${proc.agent} (pid ${proc.pid}) が終了しないため、resume しませんでした`)
      return
    }
    if (proc.agent === 'codex' && trimSlash(proc.home) !== trimSlash(target.home)) {
      await deps.copyFile(session.transcriptPath, codexRolloutTarget(session.transcriptPath, proc.home, target.home))
    }
    await deps.sleep(SHELL_SETTLE_MS)
    history.set(terminalId, [...(history.get(terminalId) ?? []), deps.now()])
    const accepted = await deps.sendText(
      terminalId,
      buildResumeCommand(proc, session, target, RESUME_PROMPT, deps.pathExists),
    )
    if (!accepted) {
      await fail(terminalId, `resume コマンドを打ち込めませんでした（${proc.agent} は止めてあります）`)
      return
    }

    await deps.sleep(RESUME_CHECK_MS)
    const screen = (await deps.readTerminal(terminalId)).join('\n')
    if (BLOCKING_DIALOG_PATTERNS.some((p) => p.test(screen))) {
      await notifyOnce(
        terminalId,
        `${TITLE}: 確認画面で止まっています`,
        `${terminalId}: ${proc.agent} を ${target.id} で resume しましたが、初回の確認画面が出ています。ペインで答えてください。`,
      )
      return
    }
    const resumed = findAgentProcess(await deps.listProcesses(), terminalId, deps.homeDir)
    if (!resumed || resumed.pid === proc.pid) {
      await fail(terminalId, `${proc.agent} を ${target.id} で resume しましたが、起動を確認できませんでした`)
      return
    }
    lastNotice.delete(terminalId)
    await deps.status(`failover: ${proc.agent} → ${target.id}`)
    await deps.notify(
      `${TITLE}: アカウントを切り替えました`,
      `${terminalId}: ${proc.agent} を ${target.id} で resume しました`,
    )
  }

  const handle = async (event: StatusEvent & { terminalId: string }, lines: string[]): Promise<void> => {
    const { terminalId } = event
    const proc = findAgentProcess(await deps.listProcesses(), terminalId, deps.homeDir)
    if (!proc) {
      await fail(terminalId, 'limit の表示がありますが、エージェントのプロセスを 1 つに特定できません')
      return
    }
    const hit = detectLimit(proc.agent, lines, new Date(deps.now()))
    if (!hit) {
      deps.log(`${terminalId}: ${proc.agent} の limit の表示ではないので無視します`)
      return
    }
    const session = await resolveSession(proc)
    if (!session) {
      await fail(terminalId, `${proc.agent} の session を特定できないため、乗り換えませんでした`)
      return
    }
    let signature = codexSignature(hit)
    if (proc.agent === 'claude') {
      const id = lastRateLimitId((await deps.readFileTail(session.transcriptPath)) ?? '')
      if (!id) {
        deps.log(`${terminalId}: 画面に limit の文言がありますが、transcript には記録がないので無視します`)
        return
      }
      signature = `claude|${id}`
    }

    const recent = (history.get(terminalId) ?? []).filter((t) => deps.now() - t < LOOP_WINDOW_MS)
    history.set(terminalId, recent)
    if (recent.length >= MAX_FAILOVERS_PER_WINDOW) {
      await fail(terminalId, `1 時間に ${MAX_FAILOVERS_PER_WINDOW} 回乗り換えても limit になるため止めました`)
      return
    }

    const last = handled.get(terminalId)
    // 同じプロセスの同じ limit（解除待ちの再判定）は cooldown を記録済み。読み直すと解除時刻が繰り上がるので足さない
    const sameLimit = last !== undefined && last.signature === signature && last.pid === proc.pid
    handled.set(terminalId, { signature, pid: proc.pid })

    const accounts = parseAccountList(await deps.accountListJson(), proc.agent, deps.orcaUserData, deps.homeDir)
    const current = accounts.find((a) => trimSlash(a.home) === trimSlash(proc.home))
    if (!sameLimit) cooldowns.push(cooldownFor(hit, current?.id ?? `unknown:${proc.home}`, deps.now()))
    const pick = pickNextAccount(accounts, proc.home, cooldowns, deps.now())

    if (pick.kind === 'none') {
      await fail(terminalId, `${proc.agent} の乗り換え先のアカウントがありません`)
      return
    }
    if (pick.kind === 'wait') {
      deps.log(`${terminalId}: 全アカウントが上限のため ${formatTime(pick.until)} まで待ちます`)
      await deps.status(`failover: ${proc.agent} 待機中 (${formatTime(pick.until)})`)
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
      // 画面に limit の文言が無ければ、プロセスを調べずに終わる（ほとんどのイベントはここで終わる）
      if (!AGENTS.some((agent) => detectLimit(agent, lines, now) !== null)) return

      // アカウントの選択はホスト全体に効くので、全ペインで 1 本に並べる
      const run = chain.then(() => handle({ ...event, terminalId }, lines))
      chain = run.catch(() => {})
      await run
    } catch (error) {
      await fail(terminalId, error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.delete(terminalId)
    }
  }

  return { onStatus }
}
