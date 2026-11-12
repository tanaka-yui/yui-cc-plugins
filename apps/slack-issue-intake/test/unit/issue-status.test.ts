import { STATUS_EVENTS } from '../../lib/defaults.ts'
import { currentStatus, isTrusted, parseMarker, renderStatusMessage, slackifyComment } from '../../lib/issue-status.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { StatusChange } from '../../lib/issue-status.ts'

// orca-team-dispatch-task（部分 C）と共有するコメントの例。両方のテストで同じものを使う
const EXAMPLES = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/orca-auto-comments.json'), 'utf8')) as {
  event: string
  status: string
  body: string
}[]
const URL = 'https://github.com/acme/app/issues/42'
const MENTION = '<!subteam^S0DEV0001> '
const SLUG_TO_NAME: Record<string, string> = {
  'ready-eng': 'Ready_Eng',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done',
  failed: 'Failed',
}

test('IS1 currentStatus は大文字小文字を無視し、2つあれば優先順で選ぶ', () => {
  assert.equal(currentStatus(['ready', 'Done']), 'Done')
  assert.equal(currentStatus(['bug', 'in progress']), 'In progress')
  assert.equal(currentStatus(['Backlog', 'Ready']), 'Ready')
  assert.equal(currentStatus(['bug']), null)
})
test('IS2 parseMarker は最終行だけを読み、形が違えば null', () => {
  assert.equal(EXAMPLES.length, 8)
  for (const e of EXAMPLES) assert.equal(parseMarker(e.body)?.event, e.event, e.event)
  assert.deepEqual(parseMarker(EXAMPLES[6]?.body ?? ''), { slug: 'failed', generation: 2, event: 'failed' })
  assert.equal(parseMarker('<!-- orca-auto:done:1:ai-merged -->\nあとがき'), null)
  assert.equal(parseMarker('<!-- orca-auto:in progress:1:started -->'), null)
  assert.equal(parseMarker('<!-- orca-auto:unknown:1:started -->'), null)
  assert.deepEqual(parseMarker('x\n<!-- orca-auto:done:1:ai-merged -->\n\n'), {
    slug: 'done',
    generation: 1,
    event: 'ai-merged',
  })
})
test('IS3 isTrusted は OWNER/MEMBER/COLLABORATOR か bot の login だけ', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.ok(isTrusted({ authorAssociation: a, login: 'x' }, 'bot'))
  for (const a of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER'])
    assert.ok(!isTrusted({ authorAssociation: a, login: 'x' }, 'bot'))
  assert.ok(isTrusted({ authorAssociation: 'NONE', login: 'bot' }, 'bot'))
})
test('IS4 slackifyComment はメンションを無効にし、秘密を伏せ、リンクと太字を Slack の形にし、長さを切る', () => {
  const out = slackifyComment(
    '<!channel> <@U1> a&b **太字** [PR](https://github.com/o/r/pull/1) xoxb-123-secret\n<!-- orca-auto:done:1:ai-merged -->',
  )
  assert.ok(out.includes('&lt;!channel&gt;'))
  assert.ok(out.includes('&lt;@U1&gt;'))
  assert.ok(out.includes('a&amp;b'))
  assert.ok(out.includes('*太字*'))
  assert.ok(out.includes('<https://github.com/o/r/pull/1|PR>'))
  assert.ok(!out.includes('xoxb-123-secret'))
  assert.ok(!out.includes('orca-auto'))
  assert.ok(slackifyComment('あ'.repeat(10_000)).length <= 3000)
})
test('IS5 renderStatusMessage は event ごとの文言とメンションを返す', () => {
  for (const e of EXAMPLES) {
    const to = SLUG_TO_NAME[e.status] ?? null
    const change: StatusChange = {
      from: { status: e.event === 'stalled' ? to : 'Ready', state: 'open' },
      to: { status: to, state: 'open' },
      marker: { event: e.event, body: e.body },
    }
    const text = renderStatusMessage(change, URL, MENTION)
    assert.ok(text, e.event)
    const mentioned = STATUS_EVENTS[e.event]?.mention ?? false
    assert.equal(text.startsWith(MENTION), mentioned, e.event)
    assert.ok(text.includes(URL), e.event)
  }
  const judged = EXAMPLES.find((e) => e.event === 'judged')
  const text = renderStatusMessage(
    {
      from: { status: 'Ready', state: 'open' },
      to: { status: 'Ready_Eng', state: 'open' },
      marker: { event: 'judged', body: judged?.body ?? '' },
    },
    URL,
    MENTION,
  )
  assert.match(text ?? '', /エンジニアの対応が必要/)
  assert.match(text ?? '', /判定の理由: 対象リポジトリが 3 つあり/)
  assert.equal(renderStatusMessage({ ...noChange, marker: { event: 'judged', body: '' } }, URL, MENTION), null)
  for (const event of ['human-merged', 'started']) assert.equal(STATUS_EVENTS[event]?.mention, false, event)
  assert.equal(
    renderStatusMessage(
      {
        from: { status: 'Ready', state: 'open' },
        to: { status: 'In progress', state: 'open' },
        marker: { event: 'started', body: '' },
      },
      URL,
      MENTION,
    ),
    `ステータスが Ready から In progress に変わりました\n${URL}`,
  )
})
const noChange: StatusChange = {
  from: { status: 'In progress', state: 'open' },
  to: { status: 'In progress', state: 'open' },
  marker: null,
}
test('IS6 マーカー無しの変化は、閉じた・Done なら完了、それ以外はふつうの変化、変化なしは null', () => {
  assert.equal(renderStatusMessage(noChange, URL, MENTION), null)
  const done = `完了しました\n${URL}`
  assert.equal(renderStatusMessage({ ...noChange, to: { status: 'Done', state: 'open' } }, URL, MENTION), done)
  assert.equal(renderStatusMessage({ ...noChange, to: { status: 'In progress', state: 'closed' } }, URL, MENTION), done)
  assert.equal(
    renderStatusMessage(
      { ...noChange, from: { status: null, state: 'open' }, to: { status: 'Ready', state: 'open' } },
      URL,
      MENTION,
    ),
    `ステータスが （なし） から Ready に変わりました\n${URL}`,
  )
  assert.equal(
    renderStatusMessage(
      { ...noChange, from: { status: 'Done', state: 'closed' }, to: { status: 'Ready', state: 'open' } },
      URL,
      MENTION,
    ),
    `Issue が開き直されました（Ready）\n${URL}`,
  )
})
