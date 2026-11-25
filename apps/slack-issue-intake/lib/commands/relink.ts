import { perCallClient } from '../channels.ts'
import { die, parseFlags } from '../cli.ts'
import { isLinked, issueKey, linkAdopted, linkSubmission } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  ADOPTED_LABEL,
  COMMAND_DEADLINE_MS,
  ERROR_RATELIMITED,
  RELINK_ADOPTED_PHRASE,
  RELINK_CREATED_PHRASE,
  RELINK_HISTORY_MAX_PAGES,
  RELINK_RATELIMIT_WAIT_SECONDS,
  RELINK_TEXT,
  SOURCE_LABEL,
} from '../defaults.ts'
import { asArray, asObject, asString, get, parseJson } from '../json.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { fetchHistoryPage, fetchReplies } from '../slack-api.ts'
import { firstUserMention } from '../slack-text.ts'

import { setTimeout as sleep } from 'node:timers/promises'

import type { JsonObject } from '../json.ts'
import type { Runtime } from '../runtime.ts'
import type { SlackFailure, SlackList, SlackPage, SlackResult } from '../slack-api.ts'

// relink: 前のホーム（別のマシン）や消したボットが作ったスレッドを、チャンネルの履歴から探して DB に結び付け直す。
// フォームのスレッド（ボットの返信に「Issue を作成しました: <url>」）は submissions の created の行に、
// 既存 Issue の管理用の投稿（ボットの親の投稿に「この Issue をスレッドで管理します: …」）は adopted の行にする。
// 書くのは --apply のときだけ。Slack と GitHub へは読むだけで、投稿もラベルの変更もしない
type Kind = 'from-slack' | 'slack-thread'
type Candidate = {
  kind: Kind
  repo: string
  number: number
  ts: string
  parent: JsonObject
  reporterId: string | null
}

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => String(values[key] ?? whole))
const say = (line: string): void => console.log(maskSecrets(line))

// 429 は Retry-After だけ待って試し直す（読むだけなので重ねても害は無い）。締め切りを越えるなら諦める
const patient = async <R extends SlackList | SlackPage | SlackResult>(
  attempt: () => Promise<R>,
  deadline: number,
): Promise<R> => {
  for (;;) {
    const r = await attempt()
    if (r.ok || r.error !== ERROR_RATELIMITED) return r
    const wait = (r.retryAfterSeconds ?? RELINK_RATELIMIT_WAIT_SECONDS) * 1000
    if (Date.now() + wait >= deadline) return r
    await sleep(wait)
  }
}

// ボットの投稿だけを見る（人が同じ文を書いても結び付けない）
const byBot = (m: JsonObject): boolean => Boolean(asString(m.bot_id))
const textOf = (m: JsonObject): string => asString(m.text) ?? ''

// 文の中の、設定にあるリポジトリの Issue の URL。名前は設定の綴りで返す
const issueIn = (text: string, repos: string[]): { repo: string; number: number } | null => {
  for (const m of text.matchAll(/https:\/\/github\.com\/([^/\s|>]+\/[^/\s|>]+)\/issues\/(\d+)/g)) {
    const repo = repos.find((r) => r.toLowerCase() === m[1]?.toLowerCase())
    if (repo) return { repo, number: Number(m[2]) }
  }
  return null
}

const readParents = async (rt: Runtime, deadline: number): Promise<JsonObject[] | SlackFailure> => {
  const slack = perCallClient(rt.token)
  const all: JsonObject[] = []
  let latest = String(Date.now() / 1000)
  for (let page = 0; page < RELINK_HISTORY_MAX_PAGES; page++) {
    const r = await patient(() => fetchHistoryPage(slack, rt.config.channel, '0', latest, false, deadline), deadline)
    if (!r.ok) return r
    all.push(...r.messages)
    const oldest = r.messages.at(-1)
    if (!r.hasMore || !oldest) break
    latest = String(oldest.ts)
  }
  return all
}

const findCandidates = async (
  rt: Runtime,
  parents: JsonObject[],
  deadline: number,
): Promise<Candidate[] | SlackFailure> => {
  const slack = perCallClient(rt.token)
  const repos = rt.config.repos.map((r) => r.name)
  const found: Candidate[] = []
  for (const parent of parents) {
    if (!byBot(parent)) continue
    const ts = String(parent.ts)
    const text = textOf(parent)
    if (text.includes(RELINK_ADOPTED_PHRASE)) {
      const issue = issueIn(text, repos)
      if (issue) found.push({ kind: 'slack-thread', ...issue, ts, parent, reporterId: null })
      continue
    }
    if (Number(parent.reply_count ?? 0) <= 0) continue
    const replies = await patient(() => fetchReplies(slack, rt.config.channel, ts, null, deadline), deadline)
    if (!replies.ok) return replies
    for (const reply of replies.messages) {
      const body = textOf(reply)
      if (!byBot(reply) || !body.includes(RELINK_CREATED_PHRASE)) continue
      const issue = issueIn(body, repos)
      if (!issue) continue
      found.push({ kind: 'from-slack', ...issue, ts, parent, reporterId: firstUserMention(body) })
      break
    }
  }
  // 古い順に並べ、同じ Issue のスレッドが 2 つあれば古い方を使う
  return found.sort((a, b) => Number(a.ts) - Number(b.ts))
}

type Checked = { candidate: Candidate; title: string; url: string; permalink: string }

const check = async (rt: Runtime, candidates: Candidate[], deadline: number): Promise<Checked[]> => {
  const slack = perCallClient(rt.token)
  const seen = new Map<string, string>()
  const ready: Checked[] = []
  const skip = (c: Candidate, reason: string): void => {
    say(fill(RELINK_TEXT.skip, { repo: c.repo, number: c.number, reason }))
  }
  for (const c of candidates) {
    const key = issueKey(c.repo, c.number)
    const first = seen.get(key)
    if (first) {
      skip(c, fill(RELINK_TEXT.duplicate, { ts: first }))
      continue
    }
    seen.set(key, c.ts)
    if (isLinked(rt.db, rt.config.defaultRepo, c.repo, c.number)) {
      skip(c, RELINK_TEXT.tracked)
      continue
    }
    const r = await rt.gh(['api', `repos/${c.repo}/issues/${c.number}`], deadline)
    const issue = r.code === 0 ? asObject(parseJson(r.stdout)) : null
    if (!issue) {
      skip(c, fill(RELINK_TEXT.ghFailed, { error: r.stderr || r.stdout }))
      continue
    }
    if (issue.pull_request) {
      skip(c, RELINK_TEXT.pull)
      continue
    }
    const labels = (asArray(issue.labels) ?? []).flatMap((l) => asString(get(l, 'name')) ?? [])
    const label = c.kind === 'from-slack' ? SOURCE_LABEL : ADOPTED_LABEL
    if (!labels.some((l) => l.toLowerCase() === label)) {
      skip(c, fill(RELINK_TEXT.noLabel, { label }))
      continue
    }
    let permalink = ''
    if (c.kind === 'from-slack') {
      const link = await patient(
        () => slack.call('chat.getPermalink', { channel: rt.config.channel, message_ts: c.ts }, deadline),
        deadline,
      )
      permalink = link.ok ? (asString(link.body.permalink) ?? '') : ''
      if (!permalink) {
        skip(c, fill(RELINK_TEXT.permalinkFailed, { error: link.ok ? '' : link.error }))
        continue
      }
    }
    ready.push({
      candidate: c,
      title: asString(issue.title) ?? '',
      url: asString(issue.html_url) ?? `https://github.com/${c.repo}/issues/${c.number}`,
      permalink,
    })
    say(fill(RELINK_TEXT.link, { kind: c.kind, repo: c.repo, number: c.number, ts: c.ts }))
  }
  return ready
}

const write = (rt: Runtime, ready: Checked[]): number => {
  const lease = acquireLease(rt.db, 'admin', null, new Date(), ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error(RELINK_TEXT.busy)
    return 1
  }
  try {
    let linked = 0
    for (const { candidate: c, title, url, permalink } of ready) {
      const now = new Date()
      if (!renewLease(rt.db, lease.token, now, ADMIN_LEASE_MS)) {
        console.error(RELINK_TEXT.leaseLost)
        return 1
      }
      const result =
        c.kind === 'from-slack'
          ? linkSubmission(
              rt.db,
              lease.token,
              rt.config.defaultRepo,
              {
                repo: c.repo,
                channel: rt.config.channel,
                ts: c.ts,
                permalink,
                raw: c.parent,
                reporterId: c.reporterId,
                issueUrl: url,
                issueNumber: c.number,
              },
              now.toISOString(),
            )
          : linkAdopted(
              rt.db,
              lease.token,
              rt.config.defaultRepo,
              { repo: c.repo, issueNumber: c.number, channel: rt.config.channel, ts: c.ts, title, url },
              now.toISOString(),
            )
      if (result === 'lease lost') {
        console.error(RELINK_TEXT.leaseLost)
        return 1
      }
      if (result === 'exists')
        say(fill(RELINK_TEXT.skip, { repo: c.repo, number: c.number, reason: RELINK_TEXT.tracked }))
      else {
        linked++
        say(fill(RELINK_TEXT.linked, { kind: c.kind, repo: c.repo, number: c.number, ts: c.ts }))
      }
    }
    say(fill(RELINK_TEXT.done, { linked }))
    return 0
  } finally {
    releaseLease(rt.db, lease.token)
  }
}

export const run = async (argv: string[]): Promise<void> => {
  const { values, positionals } = parseFlags('relink', {
    args: argv,
    options: { apply: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (positionals.length) return die('relink', RELINK_TEXT.usage)
  const opened = openRuntime(intakeHome())
  if (!opened.ok) {
    console.error(opened.reason)
    process.exitCode = 2
    return
  }
  const rt = opened.runtime
  const deadline = Date.now() + COMMAND_DEADLINE_MS
  try {
    const parents = await readParents(rt, deadline)
    if (!Array.isArray(parents)) throw new Error(parents.error)
    const candidates = await findCandidates(rt, parents, deadline)
    if (!Array.isArray(candidates)) throw new Error(candidates.error)
    say(fill(RELINK_TEXT.scanned, { parents: parents.length, candidates: candidates.length }))
    const ready = await check(rt, candidates, deadline)
    if (!values.apply) {
      say(RELINK_TEXT.dryRun)
      return
    }
    process.exitCode = write(rt, ready)
  } catch (e) {
    console.error(maskSecrets(e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  } finally {
    rt.db.close()
  }
}
