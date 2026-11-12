import { parseSubmission } from '../../lib/parse.ts'
import { templateText } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('PA1 テンプレートどおりの text を読む', () => {
  assert.deepEqual(parseSubmission(templateText(), null), {
    kind: 'ok',
    fields: {
      title: 'ログインできない',
      fullTitle: 'ログインできない',
      category: 'バグ',
      priority: 'high',
      body: '本文1\n本文2',
      reporterId: 'U012AB3CD',
    },
  })
})
test('PA2 全角コロン・前後の空白・全角のマーカーも読む', () => {
  const r = parseSubmission(
    `  \n［issue-intake］ \n${templateText({ colon: '：' }).split('\n').slice(1).join('\n')}`,
    null,
  )
  assert.equal(r.kind, 'ok')
})
test('PA3 マーカーで始まらないものは投稿ではない', () => {
  assert.deepEqual(parseSubmission('今日のランチどうする？', 'U1'), { kind: 'not-submission' })
})
test('PA4 本文の中のラベルらしい行は本文のまま', () => {
  const r = parseSubmission(templateText({ body: '手順\nタイトル: 偽物\n優先度: low' }), null)
  assert.ok(
    r.kind === 'ok' && r.fields.body === '手順\nタイトル: 偽物\n優先度: low' && r.fields.title === 'ログインできない',
  )
})
test('PA5 本文ラベルと同じ行の値も本文に入る', () => {
  const text = templateText().replace('本文:\n本文1', '本文: 一行目\n本文1')
  const r = parseSubmission(text, null)
  assert.ok(r.kind === 'ok' && r.fields.body === '一行目\n本文1\n本文2')
})
test('PA6 読めない項目を順に挙げる', () => {
  const r = parseSubmission(templateText({ title: '', category: 'その他', priority: 'urgent', body: '' }), null)
  assert.deepEqual(r, {
    kind: 'invalid',
    reporterId: 'U012AB3CD',
    problems: [
      'タイトルがありません',
      'カテゴリが「バグ / 新機能 / 要望」のどれでもありません',
      '優先度が「critical / high / middle / low」のどれでもありません',
      '本文がありません',
    ],
  })
})
test('PA7 優先度は大文字小文字と全角を問わない', () => {
  const r = parseSubmission(templateText({ priority: 'ＨＩＧＨ' }), null)
  assert.ok(r.kind === 'ok' && r.fields.priority === 'high')
})
test('PA8 256 文字を超えるタイトルは 255 文字＋…にし、全文を残す', () => {
  const long = 'あ'.repeat(300)
  const r = parseSubmission(templateText({ title: long }), null)
  assert.ok(r.kind === 'ok' && r.fields.title === `${'あ'.repeat(255)}…` && r.fields.fullTitle === long)
})
test('PA9 起票者のメンションが無ければ fallback、それも無ければ null', () => {
  const a = parseSubmission(templateText({ reporter: '山田' }), 'U999')
  const b = parseSubmission(templateText({ reporter: '山田' }), null)
  assert.ok(a.kind === 'ok' && a.fields.reporterId === 'U999' && b.kind === 'ok' && b.fields.reporterId === null)
})
test('PA10 ラベル行そのものが無いときも「がありません」', () => {
  const r = parseSubmission('[issue-intake]\nタイトル: x\n本文:\ny', null)
  assert.ok(
    r.kind === 'invalid' && r.problems.includes('カテゴリがありません') && r.problems.includes('優先度がありません'),
  )
})
