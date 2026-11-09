import { die, log, parseFlags, parseNow } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { finishRun, openDb, recordDelivery, saveNote } from '../db.ts'
import { MAX_MESSAGE_CHARS } from '../defaults.ts'
import { validateDigest } from '../digest.ts'
import { asArray, asObject, parseJson } from '../json.ts'
import { digestHome, homePaths } from '../paths.ts'
import { loadSecrets, maskSecrets, webhookFor } from '../secrets.ts'
import { formatMonthDay, postWebhook, renderGlobal, renderRepo, repoItemIds, splitMessages } from '../slack.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Destination } from '../db.ts'
import type { PendingFile } from '../pending.ts'

const NAME = 'dev-digest publish'
const EXIT_FAILED = 1
const EXIT_MISSING = 2
const EXIT_INVALID = 3

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const unique = (ids: number[]): number[] => [...new Set(ids)]

export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags(NAME, { args: argv, options: { file: { type: 'string' }, now: { type: 'string' } } })
  const now = parseNow(NAME, values.now)
  const digestFile = values.file ?? die(NAME, '--file <digest.json> を指定してください')
  const home = digestHome()
  const paths = homePaths(home)
  const secrets = loadSecrets(paths.secrets)
  const out: string[] = []
  // 出力はすべて Webhook URL を伏せてから書く（例外メッセージや Slack の応答も含む）
  const say = (line: string): void => {
    out.push(maskSecrets(line, secrets))
  }
  const fail = (code: number, message: string): void => {
    log(NAME, maskSecrets(message, secrets))
    process.exitCode = code
  }

  const config = loadConfig(home)
  if (config === null) return fail(EXIT_MISSING, '設定がありません。init を先に実行してください')
  const pendingText = readText(join(paths.runDir, 'pending.json'))
  const pendingJson = pendingText === null ? null : asObject(parseJson(pendingText))
  if (
    pendingJson === null ||
    asArray(pendingJson.items) === null ||
    asArray(pendingJson.globalIds) === null ||
    asArray(pendingJson.repos) === null
  ) {
    return fail(EXIT_MISSING, 'pending.json がありません。pending を先に実行してください')
  }
  // pending.json は pending コマンド自身が書いた形なので、型は PendingFile として扱う
  const pending: PendingFile = JSON.parse(pendingText ?? '')

  const digestText = readText(digestFile)
  const digestJson = digestText === null ? null : parseJson(digestText)
  if (digestJson === null) return fail(EXIT_INVALID, `digest を読めません: ${digestFile}`)
  const validation = validateDigest(digestJson, pending)
  if (!validation.ok) {
    for (const error of validation.errors) log(NAME, maskSecrets(error, secrets))
    return fail(EXIT_INVALID, `digest の検証に失敗しました（${validation.errors.length} 件）。何も送っていません`)
  }
  const digest = validation.digest

  const globalHook = webhookFor(secrets, null)
  if (globalHook === null) return fail(EXIT_MISSING, '全体の Webhook が未設定です')

  const revisionOf = new Map(pending.items.map((item) => [item.id, item.revision]))
  const deliveries = (ids: number[], destination: Destination, status: 'sent' | 'irrelevant') =>
    unique(ids).flatMap((itemId) => {
      const revision = revisionOf.get(itemId)
      return revision === undefined ? [] : [{ itemId, revision, destination, status, runId: pending.runId }]
    })

  const date = formatMonthDay(now, config.schedule.timezone)
  const options = { jvnMin: config.jvnMinSeverity, timeZone: config.schedule.timezone }
  const db = openDb(paths.db)
  try {
    // 要約は送信の成否に関わらず残す（検索に使う）
    const groupKeyOf = new Map<number, string>()
    for (const group of digest.groups)
      for (const id of group.itemIds) if (!groupKeyOf.has(id)) groupKeyOf.set(id, group.key)
    const noted = new Set<number>()
    for (const note of digest.notes) {
      const revision = revisionOf.get(note.id)
      if (revision === undefined || noted.has(note.id)) continue
      noted.add(note.id)
      saveNote(db, note.id, revision, {
        summaryJa: note.summaryJa,
        tags: note.tags,
        groupKey: groupKeyOf.get(note.id) ?? null,
      })
    }

    // 1 つの送り先へ順に送る。1 通でも失敗したらその送り先は失敗
    const send = async (destination: Destination, url: string, lines: string[]): Promise<boolean> => {
      const messages = splitMessages(lines, MAX_MESSAGE_CHARS)
      for (const message of messages) {
        const result = await postWebhook(url, message)
        if (!result.ok) {
          say(`failed ${destination} status=${result.status} error=${result.error ?? 'unknown'}`)
          return false
        }
      }
      say(`sent ${destination} messages=${messages.length}`)
      return true
    }

    let allOk = true
    if (await send('global', globalHook.url, renderGlobal(pending, digest, date, options))) {
      recordDelivery(db, deliveries(pending.globalIds, 'global', 'sent'), now)
    } else {
      allOk = false
    }

    for (const repo of pending.repos) {
      const destination: Destination = `repo:${repo.slug}`
      const lines = renderRepo(
        pending,
        digest,
        repo.slug,
        date,
        webhookFor(secrets, repo.slug)?.viaGlobal ?? true,
        options,
      )
      const chosen = new Set(repoItemIds(pending, digest, repo.slug))
      const irrelevant = deliveries(
        repo.candidateIds.filter((id) => !chosen.has(id)),
        destination,
        'irrelevant',
      )
      if (lines === null) {
        recordDelivery(db, irrelevant, now)
        say(`skipped ${destination} items=0`)
        continue
      }
      const hook = webhookFor(secrets, repo.slug) ?? globalHook
      if (await send(destination, hook.url, lines)) {
        recordDelivery(db, [...deliveries([...chosen], destination, 'sent'), ...irrelevant], now)
      } else {
        allOk = false
      }
    }

    if (allOk) finishRun(db, pending.runId, now)
    else process.exitCode = EXIT_FAILED
  } catch (error) {
    say(`failed error=${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT_FAILED
  } finally {
    db.close()
    if (out.length > 0) process.stdout.write(`${out.join('\n')}\n`)
  }
}
