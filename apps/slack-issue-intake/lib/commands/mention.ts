import { die, parseFlags } from '../cli.ts'
import { loadConfig, saveConfig } from '../config.ts'
import {
  ADMIN_LEASE_MS,
  COMMAND_DEADLINE_MS,
  ERROR_MISSING_SCOPE,
  MSG_CONFIG_CHANGED,
  MSG_MENTION_LIST_FAILED,
  MSG_MENTION_NO_SCOPE,
  MSG_MENTION_NOT_FOUND,
  MSG_MENTION_USAGE,
  USERGROUP_ID_PATTERN,
} from '../defaults.ts'
import { asArray, asObject, asString } from '../json.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'

import type { Mention } from '../config.ts'
import type { SlackClient } from '../slack-api.ts'

type Resolved = { ok: true; mention: Mention } | { ok: false; error: string }
const normalize = (s: string): string => s.normalize('NFKC').trim().toLowerCase()

// ハンドル（先頭の @ は外す）か表示名で、usergroups.list からグループを探す。S で始まる ID は探さずに受け付ける
const resolve = async (slack: SlackClient, input: string, deadline: number): Promise<Resolved> => {
  const value = input.trim()
  if (USERGROUP_ID_PATTERN.test(value)) return { ok: true, mention: { asked: true, groupId: value, handle: null } }
  const listed = await slack.call('usergroups.list', {}, deadline)
  if (!listed.ok)
    return {
      ok: false,
      error:
        listed.error === ERROR_MISSING_SCOPE
          ? MSG_MENTION_NO_SCOPE
          : MSG_MENTION_LIST_FAILED.replace('{error}', listed.error),
    }
  const wanted = normalize(value.replace(/^@/, ''))
  for (const g of asArray(listed.body.usergroups) ?? []) {
    const o = asObject(g)
    const id = asString(o?.id)
    const handle = asString(o?.handle)
    if (!o || !id || !USERGROUP_ID_PATTERN.test(id)) continue
    if ((handle && normalize(handle) === wanted) || normalize(asString(o.name) ?? '') === wanted)
      return { ok: true, mention: { asked: true, groupId: id, handle } }
  }
  return { ok: false, error: MSG_MENTION_NOT_FOUND.replace('{group}', value) }
}

// ステータスの通知でメンションするグループを config に残す。setup の 6 段から呼ぶ。手で変えるときもこれを使う
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('mention', {
    args: argv,
    options: { group: { type: 'string' }, none: { type: 'boolean' } },
  })
  if (Boolean(values.none) === (values.group !== undefined) || values.group?.trim() === '')
    die('mention', MSG_MENTION_USAGE)
  const opened = openRuntime(intakeHome())
  if (!opened.ok) {
    console.error(opened.reason)
    process.exitCode = 2
    return
  }
  const rt = opened.runtime
  const base = JSON.stringify(rt.config)
  const deadline = Date.now() + COMMAND_DEADLINE_MS
  const lease = acquireLease(rt.db, 'admin', null, new Date(), ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error('処理中です。少し待ってから再実行してください')
    rt.db.close()
    process.exitCode = 1
    return
  }
  try {
    const resolved: Resolved = values.none
      ? { ok: true, mention: { asked: true, groupId: null, handle: null } }
      : await resolve(rt.slack, values.group ?? '', deadline)
    if (!resolved.ok) {
      console.error(maskSecrets(resolved.error))
      process.exitCode = 1
      return
    }
    if (!renewLease(rt.db, lease.token, new Date(), ADMIN_LEASE_MS)) throw new Error('lease lost')
    const current = loadConfig(rt.home)
    if (!current || JSON.stringify(current) !== base) throw new Error(MSG_CONFIG_CHANGED)
    saveConfig(rt.home, { ...current, mention: resolved.mention })
    console.log(`mention=${resolved.mention.groupId ?? 'none'}`)
  } catch (error) {
    console.error(maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    releaseLease(rt.db, lease.token)
    rt.db.close()
  }
}
