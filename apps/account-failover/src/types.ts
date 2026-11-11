export type AgentKind = 'claude' | 'codex'

// resetsAt は epoch ms。画面から解除時刻を読めないときは null
export type LimitHit = { agent: AgentKind; reason: string; resetsAt: number | null }

// id は managed アカウントの uuid か 'system'
export type AccountRef = { agent: AgentKind; id: string; home: string; isSystem: boolean }

export type Cooldown = { agent: AgentKind; accountId: string; until: number }

export type AccountPick =
  | { kind: 'switch'; account: AccountRef }
  | { kind: 'wait'; until: number; account: AccountRef }
  | { kind: 'none' }

export type AgentProcess = { pid: number; agent: AgentKind; command: string; home: string; terminalHandle: string }

export type SessionRef = { agent: AgentKind; sessionId: string; cwd: string; transcriptPath: string }

// 外部 JSON を受ける型。any / unknown を使わずに型ガードで絞る
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
