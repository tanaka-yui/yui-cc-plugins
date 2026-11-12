import { parseSubmission } from '../../lib/parse.ts'
import { kindText, templateText } from '../fixtures/slack-messages.ts'

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
test('PA11 バグの新しい形を読み、空の任意項目は本文に入れない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: '白くなる\n2行目', 画面のURL: 'https://e.x/a' }), null)
  assert.deepEqual(r, {
    kind: 'ok',
    fields: {
      title: 'ログインできない',
      fullTitle: 'ログインできない',
      category: 'バグ',
      priority: 'high',
      body: '事象:\n白くなる\n2行目\n\n画面のURL:\nhttps://e.x/a',
      reporterId: 'U012AB3CD',
    },
  })
})
test('PA12 要望の必須項目が無ければ項目名で挙げる', () => {
  const r = parseSubmission(kindText('要望', {}), null)
  assert.ok(r.kind === 'invalid' && r.problems.includes('現在がありません') && r.problems.includes('理想がありません'))
})
test('PA13 コードブロックの中の項目名らしい行は値のまま', () => {
  const r = parseSubmission(kindText('要望', { 現在: '理想: 偽物\nタイトル: 偽物', 理想: 'x' }), null)
  assert.ok(
    r.kind === 'ok' &&
      r.fields.body === '現在:\n理想: 偽物\nタイトル: 偽物\n\n理想:\nx' &&
      r.fields.title === 'ログインできない',
  )
})
test('PA14 rich_text を平らにした形（* なし、``` が独立行）も読む', () => {
  const r = parseSubmission(kindText('新機能', { 仕様: 'A\nB' }).replaceAll('*', ''), null)
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nA\nB' && r.fields.category === '新機能')
})
test('PA15 1 行に ```値``` と書かれた値も読む', () => {
  const text = kindText('新機能', { 仕様: 'X' }).replace('*仕様:*\n```\nX\n```', '*仕様:*\n```X```')
  const r = parseSubmission(text, null)
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nX')
})
test('PA16 カテゴリが不正で本文の行も無ければ、カテゴリの問題だけを挙げる', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'x' }).replace('*カテゴリ:* バグ', '*カテゴリ:* その他'), null)
  assert.deepEqual(r.kind === 'invalid' && r.problems, ['カテゴリが「バグ / 新機能 / 要望」のどれでもありません'])
})
test('PA17 値に ``` が混ざって枠が崩れても落ちず、次の項目名の行までを値にする', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a', エラーログ: 'x ``` y\nz', 画面のURL: 'u' }), null)
  assert.ok(
    r.kind === 'ok' && r.fields.body.startsWith('事象:\na\n\nエラーログ:\n') && r.fields.body.endsWith('画面のURL:\nu'),
  )
})
test('PA18 * の無い形で値に ``` があっても、後ろの項目を読み落とさない', () => {
  const r = parseSubmission(kindText('要望', { 現在: 'x ``` y', 理想: 'ok' }).replaceAll('*', ''), null)
  assert.ok(r.kind === 'ok' && r.fields.body.endsWith('理想:\nok'))
})
test('PA19 値に貼ったコードブロックの中の「項目名: 値」の行は、値のまま残す', () => {
  const r = parseSubmission(kindText('要望', { 現在: '```\n理想: 落ちない\n```', 理想: 'ok' }), null)
  assert.ok(r.kind === 'ok' && r.fields.body === '現在:\n理想: 落ちない\n\n理想:\nok')
})
test('PA20 項目が始まったあとの「本文:」の行で古い形に切り替えない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a ```\n本文: b' }), null)
  assert.ok(r.kind === 'ok' && r.fields.body === '事象:\na\n本文: b')
})
test('PA21 * のある形では、値の中の「項目名:」だけの行（ほかの種類の項目名も）を区切りにしない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a\n現在:\nb\n対応策:', 画面のURL: 'u' }), null)
  assert.ok(r.kind === 'ok' && r.fields.body === '事象:\na\n現在:\nb\n対応策:\n\n画面のURL:\nu')
})
