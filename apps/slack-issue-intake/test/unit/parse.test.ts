import { parseSubmission } from '../../lib/parse.ts'
import { kindText, templateText } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('PA1 テンプレートどおりの text を読む', () => {
  assert.deepEqual(parseSubmission(templateText(), null, []), {
    kind: 'ok',
    repo: null,
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
    [],
  )
  assert.equal(r.kind, 'ok')
})
test('PA3 マーカーで始まらないものは投稿ではない', () => {
  assert.deepEqual(parseSubmission('今日のランチどうする？', 'U1', []), { kind: 'not-submission' })
})
test('PA4 本文の中のラベルらしい行は本文のまま', () => {
  const r = parseSubmission(templateText({ body: '手順\nタイトル: 偽物\n優先度: low' }), null, [])
  assert.ok(
    r.kind === 'ok' && r.fields.body === '手順\nタイトル: 偽物\n優先度: low' && r.fields.title === 'ログインできない',
  )
})
test('PA5 本文ラベルと同じ行の値も本文に入る', () => {
  const text = templateText().replace('本文:\n本文1', '本文: 一行目\n本文1')
  const r = parseSubmission(text, null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '一行目\n本文1\n本文2')
})
test('PA6 読めない項目を順に挙げる', () => {
  const r = parseSubmission(templateText({ title: '', category: 'その他', priority: 'urgent', body: '' }), null, [])
  assert.deepEqual(r, {
    kind: 'invalid',
    reporterId: 'U012AB3CD',
    problems: [
      'タイトルがありません',
      'カテゴリが「バグ / 新機能 / 要望 / 質問」のどれでもありません',
      '優先度が「critical / high / middle / low」のどれでもありません',
      '本文がありません',
    ],
  })
})
test('PA7 優先度は大文字小文字と全角を問わない', () => {
  const r = parseSubmission(templateText({ priority: 'ＨＩＧＨ' }), null, [])
  assert.ok(r.kind === 'ok' && r.fields.priority === 'high')
})
test('PA8 256 文字を超えるタイトルは 255 文字＋…にし、全文を残す', () => {
  const long = 'あ'.repeat(300)
  const r = parseSubmission(templateText({ title: long }), null, [])
  assert.ok(r.kind === 'ok' && r.fields.title === `${'あ'.repeat(255)}…` && r.fields.fullTitle === long)
})
test('PA9 起票者のメンションが無ければ fallback、それも無ければ null', () => {
  const a = parseSubmission(templateText({ reporter: '山田' }), 'U999', [])
  const b = parseSubmission(templateText({ reporter: '山田' }), null, [])
  assert.ok(a.kind === 'ok' && a.fields.reporterId === 'U999' && b.kind === 'ok' && b.fields.reporterId === null)
})
test('PA10 ラベル行そのものが無いときも「がありません」', () => {
  const r = parseSubmission('[issue-intake]\nタイトル: x\n本文:\ny', null, [])
  assert.ok(
    r.kind === 'invalid' && r.problems.includes('カテゴリがありません') && r.problems.includes('優先度がありません'),
  )
})
test('PA11 バグの新しい形を読み、空の任意項目は本文に入れない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: '白くなる\n2行目', 画面のURL: 'https://e.x/a' }), null, [])
  assert.deepEqual(r, {
    kind: 'ok',
    repo: null,
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
  const r = parseSubmission(kindText('要望', {}), null, [])
  assert.ok(r.kind === 'invalid' && r.problems.includes('現在がありません') && r.problems.includes('理想がありません'))
})
test('PA13 コードブロックの中の項目名らしい行は値のまま', () => {
  const r = parseSubmission(kindText('要望', { 現在: '理想: 偽物\nタイトル: 偽物', 理想: 'x' }), null, [])
  assert.ok(
    r.kind === 'ok' &&
      r.fields.body === '現在:\n理想: 偽物\nタイトル: 偽物\n\n理想:\nx' &&
      r.fields.title === 'ログインできない',
  )
})
test('PA14 rich_text を平らにした形（* なし、``` が独立行）も読む', () => {
  const r = parseSubmission(kindText('新機能', { 仕様: 'A\nB' }).replaceAll('*', ''), null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nA\nB' && r.fields.category === '新機能')
})
test('PA15 1 行に ```値``` と書かれた値も読む', () => {
  const text = kindText('新機能', { 仕様: 'X' }).replace('*仕様:*\n```\nX\n```', '*仕様:*\n```X```')
  const r = parseSubmission(text, null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '仕様:\nX')
})
test('PA16 カテゴリが不正で本文の行も無ければ、カテゴリの問題だけを挙げる', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'x' }).replace('*カテゴリ:* バグ', '*カテゴリ:* その他'), null, [])
  assert.deepEqual(r.kind === 'invalid' && r.problems, [
    'カテゴリが「バグ / 新機能 / 要望 / 質問」のどれでもありません',
  ])
})
test('PA17 値に ``` が混ざって枠が崩れても落ちず、次の項目名の行までを値にする', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a', エラーログ: 'x ``` y\nz', 画面のURL: 'u' }), null, [])
  assert.ok(
    r.kind === 'ok' && r.fields.body.startsWith('事象:\na\n\nエラーログ:\n') && r.fields.body.endsWith('画面のURL:\nu'),
  )
})
test('PA18 * の無い形で値に ``` があっても、後ろの項目を読み落とさない', () => {
  const r = parseSubmission(kindText('要望', { 現在: 'x ``` y', 理想: 'ok' }).replaceAll('*', ''), null, [])
  assert.ok(r.kind === 'ok' && r.fields.body.endsWith('理想:\nok'))
})
test('PA19 値に貼ったコードブロックの中の「項目名: 値」の行は、値のまま残す', () => {
  const r = parseSubmission(kindText('要望', { 現在: '```\n理想: 落ちない\n```', 理想: 'ok' }), null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '現在:\n理想: 落ちない\n\n理想:\nok')
})
test('PA20 項目が始まったあとの「本文:」の行で古い形に切り替えない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a ```\n本文: b' }), null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '事象:\na\n本文: b')
})
test('PA21 * のある形では、値の中の「項目名:」だけの行（ほかの種類の項目名も）を区切りにしない', () => {
  const r = parseSubmission(kindText('バグ', { 事象: 'a\n現在:\nb\n対応策:', 画面のURL: 'u' }), null, [])
  assert.ok(r.kind === 'ok' && r.fields.body === '事象:\na\n現在:\nb\n対応策:\n\n画面のURL:\nu')
})

test('PA22 空のリポジトリは既定、指定は正規化し、未登録は不備', () => {
  const repos = ['acme/app', 'acme/web']
  for (const [value, expected] of [
    ['', null],
    [' ACME/Web ', 'acme/web'],
  ] as const) {
    for (const text of [templateText(), kindText('バグ', { 事象: 'x' })]) {
      const result = parseSubmission(text.replace(/(優先度:\*? high)/, `$1\n*リポジトリ:* ${value}`), null, repos)
      assert.equal(result.kind, 'ok')
      if (result.kind === 'ok') assert.equal(result.repo, expected)
    }
  }
  const invalid = parseSubmission(
    templateText().replace('優先度: high', '優先度: high\nリポジトリ: acme/other'),
    null,
    repos,
  )
  assert.deepEqual(invalid.kind === 'invalid' && invalid.problems, [
    'リポジトリは次のどれかにしてください: acme/app / acme/web',
  ])
})

test('PA23 質問は題と優先度なしで読み、本文の先頭行を題にし、優先度は middle、質問の種類を残す', () => {
  const r = parseSubmission(
    kindText('質問', { 質問の種類: 'バグか仕様なのかわからない', 本文: '\n請求書の締め日は？\n2行目' }),
    null,
    [],
  )
  assert.deepEqual(r, {
    kind: 'ok',
    repo: null,
    fields: {
      title: '請求書の締め日は？',
      fullTitle: '請求書の締め日は？',
      category: '質問',
      priority: 'middle',
      body: '質問の種類:\nバグか仕様なのかわからない\n\n本文:\n請求書の締め日は？\n2行目',
      reporterId: 'U012AB3CD',
      questionKind: 'バグか仕様なのかわからない',
    },
  })
  const long = parseSubmission(kindText('質問', { 質問の種類: 'その他', 本文: 'あ'.repeat(300) }), null, [])
  assert.ok(long.kind === 'ok' && long.fields.title === `${'あ'.repeat(255)}…`)
  const flat = parseSubmission(
    kindText('質問', { 質問の種類: '仕様について', 本文: 'x' }).replaceAll('*', ''),
    null,
    [],
  )
  assert.ok(flat.kind === 'ok' && flat.fields.questionKind === '仕様について')
})
test('PA24 質問の種類が選択肢に無い・行が無い・0.2 の形の質問は読めない', () => {
  const bad = parseSubmission(kindText('質問', { 質問の種類: '雑談', 本文: 'x' }), null, [])
  assert.deepEqual(bad.kind === 'invalid' && bad.problems, [
    '質問の種類が「仕様について / バグか仕様なのかわからない / その他」のどれでもありません',
  ])
  const noKind = parseSubmission(kindText('質問', { 本文: 'x' }).replace(/\n\*質問の種類:\* \n/, '\n'), null, [])
  assert.ok(noKind.kind === 'invalid' && noKind.problems.includes('質問の種類がありません'))
  const legacy = parseSubmission(templateText({ category: '質問' }), null, [])
  assert.ok(legacy.kind === 'invalid' && legacy.problems.includes('質問の種類がありません'))
  const bug = parseSubmission(templateText(), null, [])
  assert.ok(bug.kind === 'ok' && !('questionKind' in bug.fields))
})
test('PA25 向き先は選んだリポジトリ（無ければ既定）の候補にあるときだけ残し、おまかせ・空・候補外は持たない', () => {
  const repos = ['acme/app', 'acme/web']
  const branchesOf = (repo: string | null): readonly string[] =>
    (repo ?? 'acme/app') === 'acme/app' ? ['develop', 'main'] : []
  const read = (base: string, o: { repo?: string; category?: string } = {}) =>
    parseSubmission(
      kindText(o.category ?? 'バグ', { 事象: 'x', 質問の種類: 'その他', 本文: 'x' }, { repo: o.repo, base }),
      null,
      repos,
      branchesOf,
    )
  const main = read('main')
  assert.ok(main.kind === 'ok' && main.fields.base === 'main')
  const flat = parseSubmission(
    templateText().replace('優先度: high', '優先度: high\n向き先: develop'),
    null,
    repos,
    branchesOf,
  )
  assert.ok(flat.kind === 'ok' && flat.fields.base === 'develop')
  for (const [base, o] of [
    ['おまかせ', {}],
    ['', {}],
    ['release', {}],
    ['main', { repo: 'acme/web' }],
    ['main', { category: '質問' }],
  ] as const) {
    const r = read(base, o)
    assert.ok(r.kind === 'ok' && !('base' in r.fields), `${base} ${JSON.stringify(o)}`)
  }
  // 候補を渡さない呼び出し（既存の形）は向き先を持たない
  const none = parseSubmission(kindText('バグ', { 事象: 'x' }, { base: 'main' }), null, [])
  assert.ok(none.kind === 'ok' && !('base' in none.fields))
})
test('PA26 任意の複数行の項目の「記載なし」は空とみなし、消し忘れて本文の前に残った「記載なし」の行も外す', () => {
  const empty = parseSubmission(
    kindText('バグ', { 事象: '落ちる', エラーログ: '記載なし', 対応策: ' 記載なし ' }),
    null,
    [],
  )
  assert.ok(empty.kind === 'ok')
  assert.equal(empty.fields.body, '事象:\n落ちる')
  const mixed = parseSubmission(
    kindText('バグ', { 事象: '落ちる', エラーログ: '記載なし\nTypeError: x is undefined', 対応策: '' }),
    null,
    [],
  )
  assert.ok(mixed.kind === 'ok')
  assert.equal(mixed.fields.body, '事象:\n落ちる\n\nエラーログ:\nTypeError: x is undefined')
  // 必須の項目には既定値が無いので、人が書いた「記載なし」はそのまま残す
  const typed = parseSubmission(kindText('バグ', { 事象: '記載なし' }), null, [])
  assert.ok(typed.kind === 'ok')
  assert.equal(typed.fields.body, '事象:\n記載なし')
})
