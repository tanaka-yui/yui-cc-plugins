import { RESET_GRACE_MS, UNKNOWN_RESET_COOLDOWN_MS } from './config.ts'
import { asArray, asString, isObject, parseJson } from './json.ts'

import type { AccountPick, AccountRef, AgentKind, Cooldown, LimitHit } from './types.ts'

const SYSTEM_ID = 'system'

const trimSlash = (path: string): string => path.replace(/\/+$/, '')

// `orca account list --json` から、乗り換えの候補を並び順に返す（managed が先、system が最後）
export function parseAccountList(json: string, agent: AgentKind, orcaUserData: string, homeDir: string): AccountRef[] {
  const root = parseJson(json)
  const result = isObject(root) ? root.result : undefined
  const section = isObject(result) ? result[agent] : undefined
  if (!isObject(section)) return []

  const managed = asArray(section.accounts).flatMap((entry): AccountRef[] => {
    if (!isObject(entry)) return []
    const id = asString(entry.id)
    if (!id) return []
    const home = agent === 'claude' ? asString(entry.home) : `${orcaUserData}/codex-accounts/${id}/home`
    return home ? [{ agent, id, home, isSystem: false }] : []
  })

  const system = (): AccountRef | null => {
    if (agent === 'claude') {
      if (!asString(section.systemDefaultEmail)) return null
      return { agent, id: SYSTEM_ID, home: asString(section.systemDefaultHome) ?? `${homeDir}/.claude`, isSystem: true }
    }
    const info = section.systemDefault
    if (!isObject(info) || info.hasAuth !== true) return null
    return { agent, id: SYSTEM_ID, home: `${homeDir}/.codex`, isSystem: true }
  }

  const sys = system()
  return sys ? [...managed, sys] : managed
}

export function cooldownFor(hit: LimitHit, accountId: string, now: number): Cooldown {
  const until = hit.resetsAt === null ? now + UNKNOWN_RESET_COOLDOWN_MS : hit.resetsAt + RESET_GRACE_MS
  return { agent: hit.agent, accountId, until }
}

// 現在のアカウントの次から順に、cooldown 中でないものを選ぶ。全部 cooldown 中なら一番早く解除されるものを待つ
export function pickNextAccount(
  accounts: readonly AccountRef[],
  currentHome: string,
  cooldowns: readonly Cooldown[],
  now: number,
): AccountPick {
  if (accounts.length < 2) return { kind: 'none' }
  const currentIndex = accounts.findIndex((a) => trimSlash(a.home) === trimSlash(currentHome))
  const coolingUntil = (account: AccountRef): number =>
    Math.max(0, ...cooldowns.filter((c) => c.agent === account.agent && c.accountId === account.id).map((c) => c.until))

  const rotation = accounts.map((_, i) => accounts[(currentIndex + 1 + i) % accounts.length] as AccountRef)
  const free = rotation.find((a) => a !== accounts[currentIndex] && coolingUntil(a) <= now)
  if (free) return { kind: 'switch', account: free }

  const earliest = rotation.reduce((best, a) => (coolingUntil(a) < coolingUntil(best) ? a : best))
  return { kind: 'wait', until: coolingUntil(earliest), account: earliest }
}
