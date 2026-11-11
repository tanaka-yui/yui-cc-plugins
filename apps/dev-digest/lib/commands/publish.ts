import { die, log, parseFlags, parseNow } from '../cli.ts'
import { categoryIds, loadConfig } from '../config.ts'
import { finishRun, latestRun, openDb, recordDelivery, recordedIds, saveNote } from '../db.ts'
import { MAX_MESSAGE_CHARS } from '../defaults.ts'
import { validateDigest } from '../digest.ts'
import { parseJson } from '../json.ts'
import { digestHome, homePaths } from '../paths.ts'
import { parsePending } from '../pending.ts'
import { loadSecrets, maskSecrets, webhookFor } from '../secrets.ts'
import {
  formatMonthDay,
  placeItems,
  postWebhook,
  renderGlobal,
  renderRepo,
  renderSection,
  repoItemIds,
  splitMessages,
} from '../slack.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DeliveryStatus, Destination } from '../db.ts'
import type { ItemRef } from '../pending.ts'

const NAME = 'dev-digest publish'
const EXIT_FAILED = 1
const EXIT_MISSING = 2
const EXIT_INVALID = 3
const STALE_PENDING =
  'pending.json がこの実行のものでないか、この実行は送信を終えています。何も送っていません。送り直すなら collect と pending からやり直してください'

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
  const pending = pendingText === null ? null : parsePending(parseJson(pendingText) ?? null)
  if (pending === null)
    return fail(EXIT_MISSING, 'pending.json がないか、形式が正しくありません。pending を先に実行してください')

  const db = openDb(paths.db)
  try {
    // 最新の、まだ終わっていない実行の pending.json だけで送る（古い pending.json や送り終えた実行で二重に送らない）
    const latest = latestRun(db)
    if (latest === null || latest.runId !== pending.runId || latest.finishedAt !== null)
      return fail(EXIT_MISSING, STALE_PENDING)

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

    const revisionOf = new Map(pending.items.map((item) => [item.id, item.revision]))
    const refsOf = (ids: number[]): ItemRef[] =>
      unique(ids).flatMap((id) => {
        const revision = revisionOf.get(id)
        return revision === undefined ? [] : [{ id, revision }]
      })
    const deliveries = (refs: ItemRef[], destination: Destination, status: DeliveryStatus) =>
      refs.map((ref) => ({ itemId: ref.id, revision: ref.revision, destination, status, runId: pending.runId }))
    // 送り直しのとき、その送り先に記録済みの項目は描かず、記録もし直さない
    const withoutRecorded = (recorded: Set<number>) => ({
      ...pending,
      items: pending.items.filter((item) => !recorded.has(item.id)),
    })

    const date = formatMonthDay(now, config.schedule.timezone)
    const options = {
      jvnMin: config.jvnMinSeverity,
      timeZone: config.schedule.timezone,
      categories: config.categories.map((category) => ({ id: category.id, title: category.title })),
    }
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

    // 要約を残したあとで、全体の Webhook が無ければ送らずに終える
    if (globalHook === null) return fail(EXIT_MISSING, '全体の Webhook が未設定です')

    // 1 つの送り先へ順に送る。1 通でも失敗したらその送り先は失敗。label は出力に使う送り先の名前
    const send = async (label: string, url: string, lines: string[]): Promise<boolean> => {
      const messages = splitMessages(lines, MAX_MESSAGE_CHARS)
      for (const message of messages) {
        const result = await postWebhook(url, message)
        if (!result.ok) {
          say(`failed ${label} status=${result.status} error=${result.error ?? 'unknown'}`)
          return false
        }
      }
      say(`sent ${label} messages=${messages.length}`)
      return true
    }

    // 全体の項目を、専用の Webhook があるカテゴリのチャンネルと全体のチャンネルに振り分ける。
    // 記録はどちらも送り先 global（同じ項目を 2 つのチャンネルには送らない）。今無いカテゴリの Webhook は使わない
    const channels = categoryIds(config).filter((id) => secrets.sections[id] !== undefined)
    const placement = placeItems(pending, digest, new Set(pending.globalIds))
    const sectionIds = new Map<string, number[]>()
    const mainIds: number[] = []
    for (const id of unique(pending.globalIds)) {
      const section = placement.get(id)
      if (section !== undefined && channels.includes(section)) {
        sectionIds.set(section, [...(sectionIds.get(section) ?? []), id])
      } else {
        mainIds.push(id)
      }
    }

    let allOk = true
    const globalRecorded = recordedIds(db, 'global', [...refsOf(pending.globalIds), ...pending.filtered])
    const unsent = (ids: number[]): ItemRef[] => refsOf(ids).filter((ref) => !globalRecorded.has(ref.id))
    const mainSent = unsent(mainIds)
    const globalFiltered = deliveries(
      pending.filtered.filter((ref) => !globalRecorded.has(ref.id)),
      'global',
      'filtered',
    )
    // 全体のチャンネルに送らない: 前の publish で送り終えているとき。全体のチャンネルに載る項目が無いときは、
    // この実行で global に何か記録済みのとき（filtered は全体のチャンネルへの送信と同時に記録する）と、
    // 項目がすべてセクションのチャンネルに行き、全体に載せる警告（前回未完了・取得失敗）も無いとき
    const onlyInSections = sectionIds.size > 0 && pending.failures.length === 0 && pending.previousIncomplete === null
    const mainSkip = mainIds.length > 0 ? mainSent.length === 0 : globalRecorded.size > 0 || onlyInSections
    if (mainSkip) {
      recordDelivery(db, globalFiltered, now)
      say('skipped global items=0')
    } else if (
      await send(
        'global',
        globalHook.url,
        renderGlobal({ ...withoutRecorded(globalRecorded), globalIds: mainIds }, digest, date, options),
      )
    ) {
      recordDelivery(db, [...deliveries(mainSent, 'global', 'sent'), ...globalFiltered], now)
    } else {
      allOk = false
    }

    for (const section of channels) {
      const url = secrets.sections[section]
      const ids = sectionIds.get(section) ?? []
      if (url === undefined || ids.length === 0) continue
      const label = `global:${section}`
      const sent = unsent(ids)
      const lines = renderSection(withoutRecorded(globalRecorded), digest, ids, date, options)
      if (sent.length === 0 || lines === null) {
        say(`skipped ${label} items=0`)
      } else if (await send(label, url, lines)) {
        recordDelivery(db, deliveries(sent, 'global', 'sent'), now)
      } else {
        allOk = false
      }
    }

    for (const repo of pending.repos) {
      const destination: Destination = `repo:${repo.slug}`
      const selected = repoItemIds(pending, digest, repo.slug)
      const recorded = recordedIds(db, destination, [...refsOf([...repo.candidateIds, ...selected]), ...repo.filtered])
      const chosen = selected.filter((id) => !recorded.has(id))
      const rest = [
        ...deliveries(
          refsOf(repo.candidateIds.filter((id) => !selected.includes(id) && !recorded.has(id))),
          destination,
          'irrelevant',
        ),
        ...deliveries(
          repo.filtered.filter((ref) => !recorded.has(ref.id)),
          destination,
          'filtered',
        ),
      ]
      const lines = renderRepo(
        withoutRecorded(recorded),
        digest,
        repo.slug,
        date,
        webhookFor(secrets, repo.slug)?.viaGlobal ?? true,
        options,
      )
      if (lines === null) {
        recordDelivery(db, rest, now)
        say(`skipped ${destination} items=0`)
        continue
      }
      const hook = webhookFor(secrets, repo.slug) ?? globalHook
      if (await send(destination, hook.url, lines)) {
        recordDelivery(db, [...deliveries(refsOf(chosen), destination, 'sent'), ...rest], now)
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
