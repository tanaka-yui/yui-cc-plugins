import { type CommentInput, renderComment } from '../../lib/auto-comment.ts'
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
