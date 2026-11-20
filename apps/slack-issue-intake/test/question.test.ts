import { loadConfig, saveConfig } from '../lib/config.ts'
import { getSubmission, openDb } from '../lib/db.ts'
import { parseSubmission } from '../lib/parse.ts'
import { homePaths, runPaths } from '../lib/paths.ts'
import { readWork } from '../lib/work.ts'
import { BOT_USER, kindText, NOW, REPORTER, textMessage, tsAt } from './fixtures/slack-messages.ts'
import { fakeGh, ghCalls, runCliAsync, seedSubmission, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JsonObject } from '../lib/json.ts'
import type { TranscriptEntry } from '../lib/types.ts'
import type { SlackReply } from './helpers.ts'

const COMMIT = 'abc123def456'
const PROPOSE = '起票してほしい場合は、このスレッドにそう返信してください'
const questionText = (kind: string, body = '請求書の締め日はいつですか？') =>
  kindText('質問', { 質問の種類: kind, 本文: body })
const questionFields = (kind: string) => {
  const parsed = parseSubmission(questionText(kind), null, [])
  if (parsed.kind !== 'ok') throw new Error('質問の fixture が不正です')
  return parsed.fields
}

const setup = async (
  t: { after: (fn: () => Promise<void>) => void },
  options: { thread?: JsonObject[]; knowledge?: boolean } = {},
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const server = await startSlack((r): SlackReply => {
    if (r.method === 'conversations.history') return { json: { ok: true, messages: [] } }
    if (r.method === 'conversations.replies') return { json: { ok: true, messages: options.thread ?? [] } }
    if (r.method === 'users.info') return { json: { ok: true, user: { profile: { display_name: '山田 太郎' } } } }
    if (r.method === 'chat.postMessage') return { json: { ok: true, ts: tsAt(1) } }
    return { json: { ok: true } }
  })
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  const knowledge = join(home, 'knowledge', 'acme', 'app')
  if (options.knowledge !== false) {
    mkdirSync(join(knowledge, 'docs', 'docs', 'spec'), { recursive: true })
    writeFileSync(join(knowledge, 'docs', 'docs', 'spec', 'billing.md'), '# 請求\n締め日は月末です。\n')
    writeFileSync(join(knowledge, 'INDEX.md'), '# acme/app\n')
    writeFileSync(
      join(knowledge, 'meta.json'),
      JSON.stringify({ commit: COMMIT, builtAt: NOW, files: ['docs/spec/billing.md'] }),
    )
  }
  const cli = (args: string[]) => runCliAsync([...args, '--now', NOW], env)
  const read = (id: number) => {
    const db = openDb(homePaths(home).db)
    const s = getSubmission(db, id)
    db.close()
    return s
  }
  const collect = async () => {
    const r = await cli(['collect'])
    assert.equal(r.code, 0, r.stderr)
    const id = r.stdout.match(/^run=(.+)$/m)?.[1] ?? ''
    return { r, id, paths: runPaths(homePaths(home).runsDir, id) }
  }
  const apply = async (runId: string, file: string, decisions: JsonObject[]) => {
    writeFileSync(file, JSON.stringify({ runId, decisions }))
    return cli(['apply', '--run', runId])
  }
  const posts = () => server.requests.filter((r) => r.method === 'chat.postMessage').map((r) => r.params.text ?? '')
  const mention = (groupId: string) => {
    const c = loadConfig(home)
    if (!c) throw new Error('config がありません')
    saveConfig(home, { ...c, mention: { asked: true, groupId, handle: 'dev-member' } })
  }
  const seedQuestion = (kind: string, patch: Partial<Parameters<typeof seedSubmission>[1]> = {}) =>
    seedSubmission(home, {
      ts: tsAt(1000),
      state: 'new',
      fields: questionFields(kind),
      raw: textMessage(tsAt(1000), questionText(kind)),
      ...patch,
    })
  return { home, gh, server, env, cli, read, collect, apply, posts, mention, seedQuestion, knowledge }
}

test('QA1 質問の item は質問の種類・knowledge の場所・回答の上限を持ち、mustCreate にしない', async (t) => {
  const f = await setup(t)
  const id = await f.seedQuestion('仕様について')
  const c = await f.collect()
  const item = readWork(c.paths.workFile)?.items[0]
  assert.equal(item?.id, id)
  assert.equal(item?.categoryKey, 'question')
  assert.equal(item?.questionKind, 'spec')
  assert.equal(item?.mustCreate, false)
  assert.equal(item?.mustClose, false)
  assert.equal(item?.maxRounds, 3)
  assert.equal(item?.issueProposed, false)
  assert.equal(item?.title, '請求書の締め日はいつですか？')
  assert.deepEqual(item?.knowledge, {
    repo: 'acme/app',
    index: join(f.knowledge, 'INDEX.md'),
    faq: null,
    docs: join(f.knowledge, 'docs'),
    commit: COMMIT,
    builtAt: NOW,
    stale: false,
    files: ['docs/spec/billing.md'],
  })
})

test('QA2 answer はメンション・根拠の permalink・続きの案内を付けて投稿し、waiting にして FAQ に残す', async (t) => {
  const f = await setup(t)
  const id = await f.seedQuestion('仕様について')
  const c = await f.collect()
  const r = await f.apply(c.id, c.paths.decisionsFile, [
    { id, action: 'answer', message: '締め日は <月末> です', sources: ['docs/spec/billing.md'], proposeIssue: false },
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`answered id=${id}`))
  assert.equal(f.read(id)?.state, 'waiting')
  assert.equal(f.read(id)?.rounds, 1)
  const text = f.posts().at(-1) ?? ''
  assert.ok(text.startsWith(`<@${REPORTER}> 締め日は &lt;月末&gt; です`), text)
  assert.ok(text.includes(`https://github.com/acme/app/blob/${COMMIT}/docs/spec/billing.md`), text)
  assert.ok(!text.includes(PROPOSE))
  assert.ok(!text.includes('<!subteam^'))
  const faq = readFileSync(join(f.knowledge, 'faq.jsonl'), 'utf8').trim().split('\n')
  assert.equal(faq.length, 1)
  const entry = JSON.parse(faq[0] ?? '{}')
  assert.equal(entry.repo, 'acme/app')
  assert.equal(entry.questionKind, '仕様について')
  assert.ok(String(entry.question).includes('請求書の締め日はいつですか？'))
  assert.equal(entry.answer, '締め日は <月末> です')
  assert.deepEqual(entry.sources, ['docs/spec/billing.md'])
  assert.match(String(entry.permalink), /^https:\/\/acme\.slack\.com\/archives\//)
})

test('QA3 根拠の無い回答は担当のグループへメンションし、起票の提案には定型文を足す', async (t) => {
  const f = await setup(t, { knowledge: false })
  f.mention('S0DEV0001')
  const id = await f.seedQuestion('バグか仕様なのかわからない')
  const c = await f.collect()
  assert.equal(readWork(c.paths.workFile)?.items[0]?.knowledge?.index, null)
  const r = await f.apply(c.id, c.paths.decisionsFile, [
    { id, action: 'answer', message: 'ドキュメントに見つかりませんでした', sources: [], proposeIssue: true },
  ])
  assert.equal(r.code, 0, r.stderr)
  const text = f.posts().at(-1) ?? ''
  assert.ok(text.includes('<!subteam^S0DEV0001>'), text)
  assert.ok(text.includes(PROPOSE), text)
  // 根拠の無い回答は FAQ に残さない（スレッドの文が次の回答の材料に紛れ込まないように）
  assert.ok(!existsSync(join(f.knowledge, 'faq.jsonl')))
})

test('QA4 回答の上限に達した質問は close だけを受け、担当者にメンションして closed にする', async (t) => {
  const f = await setup(t, { thread: [{ ts: tsAt(500), user: REPORTER, text: 'まだ分かりません' }] })
  f.mention('S0DEV0001')
  const id = await f.seedQuestion('仕様について', { state: 'answered', rounds: 3 })
  const c = await f.collect()
  assert.equal(readWork(c.paths.workFile)?.items[0]?.mustClose, true)
  const refused = await f.apply(c.id, c.paths.decisionsFile, [
    { id, action: 'answer', message: 'x', sources: [], proposeIssue: false },
  ])
  assert.equal(refused.code, 3)
  const r = await f.apply(c.id, c.paths.decisionsFile, [{ id, action: 'close', message: '担当者に引き継ぎます' }])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`closed id=${id}`))
  assert.equal(f.read(id)?.state, 'closed')
  const text = f.posts().at(-1) ?? ''
  assert.ok(text.includes('担当者に引き継ぎます') && text.includes('<!subteam^S0DEV0001>'), text)
  assert.ok(!existsSync(join(f.knowledge, 'faq.jsonl')))
})

test('QA5 解決した質問の close は締めの文だけを投稿して closed にする', async (t) => {
  const f = await setup(t, { thread: [{ ts: tsAt(500), user: REPORTER, text: 'ありがとうございます' }] })
  f.mention('S0DEV0001')
  const id = await f.seedQuestion('その他', { state: 'answered', rounds: 1 })
  const c = await f.collect()
  const r = await f.apply(c.id, c.paths.decisionsFile, [{ id, action: 'close', message: 'お役に立ててよかったです' }])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.read(id)?.state, 'closed')
  assert.equal(f.posts().at(-1), `<@${REPORTER}> お役に立ててよかったです`)
})

test('QA6 起票の提案に質問者が返信したら、バグ・priority: middle・決定の題で起票する', async (t) => {
  const transcript: TranscriptEntry[] = []
  const f = await setup(t, {
    thread: [
      { ts: tsAt(800), user: BOT_USER, text: `バグのようです\n\n${PROPOSE}` },
      { ts: tsAt(500), user: REPORTER, text: '起票してください' },
    ],
  })
  const id = await f.seedQuestion('バグか仕様なのかわからない', { state: 'answered', rounds: 1, transcript })
  const c = await f.collect()
  assert.equal(readWork(c.paths.workFile)?.items[0]?.issueProposed, true)
  const r = await f.apply(c.id, c.paths.decisionsFile, [
    { id, action: 'create', title: '締め日が月末にならない', summary: '要約', details: '詳細', unresolved: [] },
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.read(id)?.state, 'created')
  const call = ghCalls(f.gh.log).find((x) => x.argv[0] === 'issue')
  const argv = call?.argv ?? []
  assert.equal(argv[argv.indexOf('--title') + 1], '締め日が月末にならない')
  const labels = argv.flatMap((a, i) => (a === '--label' ? [argv[i + 1]] : []))
  assert.ok(
    labels.includes('bug') && labels.includes('priority: middle') && !labels.includes('question'),
    labels.join(),
  )
  assert.match(call?.body ?? '', /\| カテゴリ \| バグ \|/)
})

test('QA7 提案していない質問・種類の違う質問からは起票できない', async (t) => {
  const f = await setup(t, { thread: [{ ts: tsAt(500), user: REPORTER, text: '起票してください' }] })
  const id = await f.seedQuestion('バグか仕様なのかわからない', { state: 'answered', rounds: 1 })
  const c = await f.collect()
  const create = { id, action: 'create', title: '題', summary: '要約', details: '詳細', unresolved: [] }
  const r = await f.apply(c.id, c.paths.decisionsFile, [create])
  assert.equal(r.code, 3)
  assert.equal(ghCalls(f.gh.log).filter((x) => x.argv[0] === 'issue').length, 0)
})

test('QA8 返信の無いまま時間切れの質問は、Claude を起こさずに閉じる', async (t) => {
  const f = await setup(t)
  const id = await f.seedQuestion('仕様について', {
    state: 'waiting',
    rounds: 1,
    askedAt: '2026-11-01T00:00:00.000Z',
    lastQuestionTs: tsAt(900),
  })
  const before = f.posts().length
  const r = await f.cli(['poll'])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /agent_work=0/)
  assert.equal(f.read(id)?.state, 'closed')
  assert.ok(f.read(id)?.timedOutAt)
  assert.equal(f.posts().length, before)
})

test('QA9 apply が投稿し損ねた回答と締めは poll が投稿し、回答は FAQ に足す', async (t) => {
  const f = await setup(t)
  const answer = {
    action: 'answer' as const,
    message: '締め日は月末です',
    sources: ['docs/spec/billing.md'],
    links: [`https://github.com/acme/app/blob/${COMMIT}/docs/spec/billing.md`],
    proposeIssue: false,
  }
  const asked = await f.seedQuestion('仕様について', { state: 'asking', decision: answer })
  const closing = await f.seedQuestion('その他', {
    ts: tsAt(990),
    state: 'closing',
    rounds: 1,
    decision: { action: 'close', message: 'どういたしまして' },
  })
  const r = await f.cli(['poll'])
  assert.equal(r.code, 1, r.stderr)
  assert.equal(f.read(asked)?.state, 'waiting')
  assert.equal(f.read(asked)?.rounds, 1)
  assert.equal(f.read(closing)?.state, 'closed')
  assert.ok(f.posts().some((p) => p.includes(answer.links[0] ?? '?')))
  assert.ok(f.posts().includes(`<@${REPORTER}> どういたしまして`))
  assert.equal(readFileSync(join(f.knowledge, 'faq.jsonl'), 'utf8').trim().split('\n').length, 1)
})

test('QA10 質問からの起票は向き先を持ち込まない（おまかせ）', async (t) => {
  const f = await setup(t, {
    thread: [
      { ts: tsAt(800), user: BOT_USER, text: `バグのようです\n\n${PROPOSE}` },
      { ts: tsAt(500), user: REPORTER, text: '起票してください' },
    ],
  })
  const fields = { ...questionFields('バグか仕様なのかわからない'), base: 'main' }
  const id = await f.seedQuestion('バグか仕様なのかわからない', { state: 'answered', rounds: 1, fields })
  const c = await f.collect()
  const r = await f.apply(c.id, c.paths.decisionsFile, [
    { id, action: 'create', title: '締め日が月末にならない', summary: '要約', details: '詳細', unresolved: [] },
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.read(id)?.state, 'created')
  assert.ok(f.read(id)?.fields && !('base' in (f.read(id)?.fields ?? {})))
  assert.ok(!ghCalls(f.gh.log).some((x) => x.argv.some((a) => a.startsWith('base:'))))
})
