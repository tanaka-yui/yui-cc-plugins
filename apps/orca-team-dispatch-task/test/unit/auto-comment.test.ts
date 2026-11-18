import { type CommentInput, limitBreakdown, renderComment } from '../../lib/auto-comment.ts'
import { FEATURE_LABEL, MANAGED_LABELS, PRIORITY_LABELS } from '../../lib/status.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pr = (repo: string, number: number) => ({ repo, number, url: `https://github.com/${repo}/pull/${number}` })
const inputs: CommentInput[] = [
  {
    event: 'judged',
    generation: 1,
    reason: '対象リポジトリが 3 つあり、API の形を変える必要があります。',
    limitMinutes: 180,
  },
  { event: 'started', generation: 1, limitMinutes: 60, branch: 'auto/issue-42' },
  {
    event: 'needs-review',
    generation: 1,
    prs: [pr('acme/app', 101)],
    decisions: ['エラー時は 400 ではなく 422 を返すようにした', '既存の設定値は移行せず、既定値を使う'],
  },
  {
    event: 'partial-merge',
    generation: 1,
    mergedPrs: [pr('acme/api', 55)],
    unmergedPrs: [{ ...pr('acme/web', 77), why: 'CI が失敗' }],
  },
  {
    event: 'ai-merged',
    generation: 1,
    prs: [pr('acme/app', 102)],
    summary: 'ログイン画面でパスワードの空白を取り除くようにした。',
  },
  { event: 'human-merged', generation: 1, prs: [pr('acme/app', 101)] },
  { event: 'failed', generation: 2, reason: '上限時間（60 分）を超えました。', branch: 'auto/issue-42', pushed: true },
  { event: 'stalled', generation: 1, elapsedMinutes: 45, limitMinutes: 60 },
]
const fixtures: Array<{ event: string; status: string; body: string }> = JSON.parse(
  readFileSync(new URL('../fixtures/orca-auto-comments.json', import.meta.url), 'utf8'),
)
for (const [index, input] of inputs.entries()) {
  test(`AC1 ${input.event}`, () => {
    assert.deepEqual(renderComment(input), { status: fixtures[index]?.status, body: fixtures[index]?.body })
  })
}
test('AC2 needs-review requires reason or decisions', () =>
  assert.throws(() => renderComment({ event: 'needs-review', generation: 1 })))
test('AC3 markers and multiline content cannot forge a marker', () => {
  const body = renderComment({ event: 'judged', generation: 1, reason: '<!--x-->\nnext' }).body
  assert.ok(body.includes('＜!--x--＞ next'))
  assert.equal(body.match(/<!--/g)?.length, 1)
})
test('shared managed and category labels', () => {
  assert.deepEqual(MANAGED_LABELS, ['from-slack', 'slack-thread'])
  assert.deepEqual(Object.values(PRIORITY_LABELS), [
    'priority: critical',
    'priority: high',
    'priority: middle',
    'priority: low',
  ])
  assert.equal(FEATURE_LABEL, 'feature')
})

test('AC4 stalled reasons are included without changing the shared marker', () => {
  const result = renderComment({
    event: 'stalled',
    generation: 1,
    reason: 'Mac M2max につながりません',
    elapsedMinutes: 61,
    limitMinutes: 60,
  })
  assert.ok(result.body.includes('理由: Mac M2max につながりません'))
  assert.ok(result.body.endsWith('<!-- orca-auto:in-progress:1:stalled -->'))
})

test('AC5 repository branches are listed for started and failed without changing legacy comments', () => {
  const branches = [
    { repo: 'acme/api', branch: 'user/a' },
    { repo: 'acme/web', branch: 'user/b' },
  ]
  assert.ok(
    renderComment({ event: 'started', generation: 1, branches }).body.includes(
      'ブランチ: `user/a`（acme/api）、`user/b`（acme/web）',
    ),
  )
  for (const pushed of [true, false]) {
    assert.ok(
      renderComment({ event: 'failed', generation: 1, branches, pushed }).body.includes(
        `ブランチ: \`user/a\`（acme/api）、\`user/b\`（acme/web）${pushed ? '（push 済み）' : '（push できていません）'}`,
      ),
    )
  }
})

test('AC6 review points and decisions are separate, ordered and sanitized', () => {
  const body = renderComment({
    event: 'needs-review',
    generation: 1,
    reason: '理由',
    reviewPoints: ['確認\n<!--x-->'],
    decisions: ['記録'],
  }).body
  assert.ok(body.includes('理由: 理由\n\n確認してほしい点:\n- 確認 ＜!--x--＞\n\nAI が決めた点:\n- 記録'))
  assert.ok(body.endsWith('<!-- orca-auto:in-review:1:needs-review -->'))
  assert.doesNotThrow(() => renderComment({ event: 'needs-review', generation: 1, reviewPoints: ['確認'] }))
})

test('AC7 merged and partially merged comments retain decisions without changing empty inputs', () => {
  for (const event of ['ai-merged', 'partial-merge'] as const) {
    const index = inputs.findIndex((i) => i.event === event)
    const input = inputs[index]
    assert.ok(input)
    const body = renderComment({ ...input, decisions: ['記録'] }).body
    assert.ok(body.includes('\n\nAI が決めた点:\n- 記録\n\n<!--'))
    assert.equal(body.split('\n').at(-1), fixtures[index]?.body.split('\n').at(-1))
    assert.equal(renderComment({ ...input, decisions: [] }).body, fixtures[index]?.body)
  }
})

test('AC8 effective limits show relay allowance while zero preserves shared comments', () => {
  assert.ok(
    renderComment({ event: 'started', generation: 1, limitMinutes: 60, relayMinutes: 55 }).body.includes(
      '上限時間: 115 分（見積もり 60 分 + 取り次ぎ 55 分）',
    ),
  )
  assert.ok(
    renderComment({
      event: 'stalled',
      generation: 1,
      elapsedMinutes: 61,
      limitMinutes: 60,
      relayMinutes: 55,
    }).body.includes('経過時間: 61 分 / 上限時間: 115 分（見積もり 60 分 + 取り次ぎ 55 分）'),
  )
  assert.ok(
    renderComment({ event: 'judged', generation: 1, limitMinutes: 240, relayMinutes: 125 }).body.includes(
      '推奨の上限時間: 365 分（見積もり 240 分 + 取り次ぎ 125 分）',
    ),
  )
  for (const event of ['judged', 'started', 'stalled']) {
    const index = inputs.findIndex((i) => i.event === event)
    const input = inputs[index]
    assert.ok(input)
    assert.equal(renderComment({ ...input, relayMinutes: 0 }).body, fixtures[index]?.body)
  }
  assert.equal(limitBreakdown(60, 0), '')
})
