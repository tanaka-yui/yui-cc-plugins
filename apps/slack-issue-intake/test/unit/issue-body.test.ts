import { getSubmission, insertSubmission, openDb } from '../../lib/db.ts'
import {
  buildIssueBody,
  fenced,
  issueLabels,
  issueMarker,
  lastLineIsMarker,
  neutralizeMentions,
} from '../../lib/issue-body.ts'
import { parseSubmission } from '../../lib/parse.ts'
import { CHANNEL, NOW, templateText, textMessage } from '../fixtures/slack-messages.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

test('IB1 メンションを無効にし、メールは残す', () =>
  assert.equal(neutralizeMentions('@alice と a@b.c と (@org/team)'), '@\u200balice と a@b.c と (@\u200borg/team)'))
test('IB2 フェンスの脱出と長さの増幅を防ぐ', () => {
  assert.equal(fenced('plain'), '```text\nplain\n```')
  assert.equal(fenced('a ```` b `` c'), '```text\na ˋˋˋˋ b `` c\n```')
})
test('IB3–IB7 本文とラベルの構造を保ち、全体を上限内にする', () => {
  const db = openDb(join(tempHome(), 'db'))
  const p = parseSubmission(templateText(), null)
  assert.ok(p.kind === 'ok')
  const id = insertSubmission(
    db,
    {
      channel: CHANNEL,
      ts: '1712345678.000100',
      permalink: 'https://acme.slack.com/archives/C0123456789/p1712345678000100',
      raw: textMessage('1', 'x'),
      fields: p.fields,
      problems: [],
      reporterId: p.fields.reporterId,
      state: 'new',
    },
    NOW,
  )
  assert.ok(id)
  const s = getSubmission(db, id)
  assert.ok(s)
  s.reporterName = '山田 太郎'
  const body = buildIssueBody(s, { action: 'create', summary: '要約 @bob', details: '### 現象\nx', unresolved: [] })
  assert.ok(body.startsWith('## 概要\n\n要約 @\u200bbob'))
  assert.ok(body.includes('| 起票者 | 山田 太郎（Slack） |'))
  assert.ok(body.includes('[元の投稿]('))
  assert.ok(!body.includes('## 未確認事項'))
  s.fields = { ...p.fields, fullTitle: 'T'.repeat(5000), body: '`'.repeat(30000) }
  s.transcript = [{ ts: '2', from: 'human', userId: 'U1', name: '山田', text: '@a '.repeat(10000), files: [] }]
  s.files = Array.from({ length: 60 }, (_, i) => ({
    id: `F${i}`,
    name: `f${i}.png`,
    mimetype: 'image/png',
    size: 1,
    permalink: `https://acme.slack.com/f${i}`,
    downloadUrl: null,
  }))
  const long = buildIssueBody(s, {
    action: 'create',
    summary: '@b '.repeat(400),
    details: '@c '.repeat(6000),
    unresolved: Array.from({ length: 10 }, () => 'x'.repeat(500)),
  })
  assert.ok(long.length <= 60000)
  assert.match(long, /ほか 10 件/)
  assert.ok(long.includes('…（省略）'))
  assert.ok(long.includes('## 未確認事項'))
  assert.ok(lastLineIsMarker(long, issueMarker(CHANNEL, s.ts)))
  assert.ok(!lastLineIsMarker(`x\n${issueMarker(CHANNEL, '2')}\nother`, issueMarker(CHANNEL, '2')))
  assert.deepEqual(issueLabels({ ...p.fields, category: '新機能', priority: 'low' }), [
    'feature',
    'priority: low',
    'from-slack',
  ])
  db.close()
})
