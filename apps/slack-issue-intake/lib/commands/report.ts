import { perCallClient, resolveChannel } from '../channels.ts'
import { die, parseFlags } from '../cli.ts'
import { loadConfig, saveConfig } from '../config.ts'
import { writeMetaFenced } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  COMMAND_DEADLINE_MS,
  DAILY_AT_PATTERN,
  META_REPORT_ASKED,
  MSG_CONFIG_CHANGED,
  SLACK_APP_NAME,
} from '../defaults.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { fetchLatest } from '../slack-api.ts'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('report', {
    args: argv,
    options: {
      source: { type: 'string' },
      channel: { type: 'string' },
      'daily-at': { type: 'string' },
    },
  })
  if (
    !values.source?.trim() ||
    values.channel?.trim() === '' ||
    (values['daily-at'] !== undefined && !DAILY_AT_PATTERN.test(values['daily-at']))
  )
    return die('report', '--source <path|none> --channel <ID|name|default> --daily-at HH:MM')
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
    const source = values.source === 'none' ? null : resolve(values.source)
    if (source && !existsSync(source)) throw new Error(`報告の材料がありません: ${source}`)
    let channel = rt.config.report.channel
    const slack = perCallClient(rt.token)
    if (values.channel !== undefined) {
      if (values.channel === 'default') channel = null
      else {
        const found = await resolveChannel(slack, values.channel, deadline)
        if (!found.ok) throw new Error(found.error)
        channel = found.id
      }
    }
    const latest = await fetchLatest(slack, channel ?? rt.config.channel, 1, deadline)
    if (!latest.ok)
      throw new Error(
        latest.error === 'not_in_channel'
          ? `チャンネルにボットを招待してください: /invite @${SLACK_APP_NAME}`
          : latest.error,
      )
    if (!renewLease(rt.db, lease.token, new Date(), ADMIN_LEASE_MS)) throw new Error('lease lost')
    const config = loadConfig(rt.home)
    if (!config || JSON.stringify(config) !== base) throw new Error(MSG_CONFIG_CHANGED)
    const report = { channel, source, dailyAt: values['daily-at'] ?? config.report.dailyAt }
    saveConfig(rt.home, { ...config, report })
    if (!writeMetaFenced(rt.db, lease.token, new Date().toISOString(), { [META_REPORT_ASKED]: '1' }))
      throw new Error('lease lost')
    console.log(`report=${source ?? 'none'} channel=${channel ?? 'default'} daily_at=${report.dailyAt}`)
  } catch (e) {
    console.error(maskSecrets(e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  } finally {
    releaseLease(rt.db, lease.token)
    rt.db.close()
  }
}
