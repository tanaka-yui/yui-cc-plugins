import { openDb, trackedIssues } from '../lib/db.ts'
import {
  MSG_ADOPTED,
  MSG_CREATED,
  MSG_CREATED_TIMEOUT,
  RELINK_ADOPTED_PHRASE,
  RELINK_CREATED_PHRASE,
} from '../lib/defaults.ts'
import { acquireLease } from '../lib/lease.ts'
import { homePaths } from '../lib/paths.ts'
import { CHANNEL, NOW_SEC, REPORTER } from './fixtures/slack-messages.ts'
import { fakeGh, repliesHandler, runCliAsync, seedIssues, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { JsonObject } from '../lib/json.ts'
import type { SlackReply, SlackRequest } from './helpers.ts'

// 前のホームのボット（今のボットとは別の bot_id）が作ったスレッド
const OLD_BOT = 'B0OLDBOT01'
const ts = (n: number): string => `${NOW_SEC - 86400 + n}.000100`
const FORM_TS = ts(1)
const ADOPTED_TS = ts(2)
const HUMAN_TS = ts(3)
const OTHER_REPO_TS = ts(4)
const UNLABELED_TS = ts(5)
const DUPLICATE_TS = ts(6)
const url = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`
const adoptedText = (repo: string, n: number, title: string): string =>
  `:pushpin: ${RELINK_ADOPTED_PHRASE}${repo}#${n} ${title}\n<${url(repo, n)}>\nステータス: Backlog`

const PARENTS: JsonObject[] = [
  { ts: FORM_TS, bot_id: OLD_BOT, text: '[issue-intake]\n*タイトル:* ログインできない', reply_count: 1 },
  { ts: ADOPTED_TS, bot_id: OLD_BOT, text: adoptedText('acme/app', 5, '前からある Issue') },
  // 人が同じ文を書いても結び付けない
  { ts: HUMAN_TS, user: REPORTER, text: adoptedText('acme/app', 6, '人の投稿') },
  // 設定に無いリポジトリは見ない
  { ts: OTHER_REPO_TS, bot_id: OLD_BOT, text: adoptedText('other/repo', 1, '別のリポジトリ') },
  // slack-thread の付いていない Issue は飛ばす
  { ts: UNLABELED_TS, bot_id: OLD_BOT, text: adoptedText('acme/app', 7, 'ラベルなし') },
  // 同じ Issue の 2 つ目のスレッドは古い方を使う
  { ts: DUPLICATE_TS, bot_id: OLD_BOT, text: adoptedText('acme/app', 5, '前からある Issue') },
]
const REPLIES: Record<string, JsonObject[]> = {
  [FORM_TS]: [
    {
      ts: ts(1).replace('.000100', '.000200'),
      bot_id: OLD_BOT,
      text: `<@${REPORTER}> ${MSG_CREATED.replace('{url}', `<${url('acme/app', 3)}>`)}`,
    },
  ],
}
const ISSUES = [
  {
    number: 3,
    repo: 'acme/app',
    title: 'ログインできない',
    html_url: url('acme/app', 3),
    labels: [{ name: 'from-slack' }],
  },
  {
    number: 5,
    repo: 'acme/app',
    title: '前からある Issue',
    html_url: url('acme/app', 5),
    labels: [{ name: 'slack-thread' }],
  },
  { number: 6, repo: 'acme/app', title: '人の投稿', html_url: url('acme/app', 6), labels: [{ name: 'slack-thread' }] },
  { number: 7, repo: 'acme/app', title: 'ラベルなし', html_url: url('acme/app', 7), labels: [] },
]

const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const replies = repliesHandler(REPLIES)
  const server = await startSlack((r: SlackRequest): SlackReply => {
    if (r.method === 'conversations.history')
      return { json: { ok: true, messages: [...PARENTS].reverse(), has_more: false } }
    if (r.method === 'conversations.replies') return replies(r)
    if (r.method === 'chat.getPermalink')
      return { json: { ok: true, permalink: `https://acme.slack.com/archives/${CHANNEL}/p${r.params.message_ts}` } }
    return { json: { ok: false, error: 'unexpected' } }
  })
  t.after(() => server.close())
  const home = tempHome()
  const gh = fakeGh(tempHome())
  seedIssues(gh.state, ISSUES)
  const env = await setupHome(home, {
    apiBase: server.url,
    ghPath: gh.ghPath,
    ghState: gh.state,
    repos: [{ name: 'acme/app', form: true, existing: 'thread' }],
  })
  const all = { ...env, ...gh.env }
  return {
    home,
    server,
    relink: (args: string[] = []) => runCliAsync(['relink', ...args], all),
    rows: () => {
      const db = openDb(homePaths(home).db)
      try {
        return {
          submissions: db.prepare('SELECT * FROM submissions').all(),
          adopted: db.prepare('SELECT * FROM adopted').all(),
          status: db.prepare('SELECT * FROM issue_status2').all(),
          tracked: [...trackedIssues(db, 'acme/app').values()],
        }
      } finally {
        db.close()
      }
    },
  }
}

test('RL1 見分ける語は、今の投稿の文言（作成・時間切れの作成・取り込み）の固定部分と一致する', () => {
  assert.ok(MSG_CREATED.includes(RELINK_CREATED_PHRASE))
  assert.ok(MSG_CREATED_TIMEOUT.includes(RELINK_CREATED_PHRASE))
  assert.ok(MSG_ADOPTED.includes(RELINK_ADOPTED_PHRASE))
})

test('RL2 --apply が無ければ候補を示すだけで、DB にも Slack にも書かない', async (t) => {
  const f = await fixture(t)
  const r = await f.relink()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /結び付けます: from-slack acme\/app#3/)
  assert.match(r.stdout, /結び付けます: slack-thread acme\/app#5/)
  assert.match(r.stdout, /飛ばします: acme\/app#7（Issue に slack-thread が付いていません）/)
  assert.match(r.stdout, /飛ばします: acme\/app#5（同じ Issue の別のスレッド/)
  assert.doesNotMatch(r.stdout, /#6|other\/repo/)
  assert.match(r.stdout, /--apply/)
  const rows = f.rows()
  assert.equal(rows.submissions.length, 0)
  assert.equal(rows.adopted.length, 0)
  assert.ok(f.server.requests.every((q) => !q.method.startsWith('chat.post')))
})

test('RL3 --apply でフォームのスレッドを submissions に、管理用の投稿を adopted に結び付け、ステータスは poll に任せる', async (t) => {
  const f = await fixture(t)
  const r = await f.relink(['--apply'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /2 件を結び付けました/)
  const rows = f.rows()
  assert.equal(rows.submissions.length, 1)
  const s = rows.submissions[0]
  assert.equal(s?.repo, 'acme/app')
  assert.equal(s?.ts, FORM_TS)
  assert.equal(s?.state, 'created')
  assert.equal(s?.issue_number, 3)
  assert.equal(s?.reporter_id, REPORTER)
  assert.equal(s?.permalink, `https://acme.slack.com/archives/${CHANNEL}/p${FORM_TS}`)
  assert.equal(rows.adopted.length, 1)
  assert.equal(rows.adopted[0]?.ts, ADOPTED_TS)
  assert.equal(rows.adopted[0]?.labeled, 1)
  assert.equal(rows.status.length, 0)
  assert.deepEqual(rows.tracked.map((x) => [x.number, x.label, x.ts]).sort(), [
    [3, 'from-slack', FORM_TS],
    [5, 'slack-thread', ADOPTED_TS],
  ])
  assert.ok(f.server.requests.every((q) => !q.method.startsWith('chat.post')))
})

test('RL4 もう一度実行しても重ねて書かない', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.relink(['--apply'])).code, 0)
  const r = await f.relink(['--apply'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /飛ばします: acme\/app#3（すでに結び付いています）/)
  assert.match(r.stdout, /0 件を結び付けました/)
  const rows = f.rows()
  assert.equal(rows.submissions.length, 1)
  assert.equal(rows.adopted.length, 1)
})

test('RL5 poll がリースを持っている間は書かずに止まる', async (t) => {
  const f = await fixture(t)
  const db = openDb(homePaths(f.home).db)
  acquireLease(db, 'poll', null, new Date(), 60_000)
  db.close()
  const r = await f.relink(['--apply'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /処理中です/)
  assert.equal(f.rows().submissions.length, 0)
})

test('RL6 知らない引数は使用法の誤り', async (t) => {
  const f = await fixture(t)
  const r = await f.relink(['extra'])
  assert.equal(r.code, 2)
})
