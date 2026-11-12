import {
  compareTs,
  decodeEntities,
  escapeMrkdwn,
  firstUserMention,
  flattenRichText,
  formatTs,
  messagePermalink,
  messageText,
  normalizeTextMarkup,
  tsMicro,
} from '../../lib/slack-text.ts'
import { CHANNEL, NOW_SEC, richTextMessage, TEAM_URL, textMessage } from '../fixtures/slack-messages.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Json } from '../../lib/json.ts'

test('ST1 decodeEntities は &lt; &gt; &amp; を戻す', () => {
  assert.equal(decodeEntities('a &lt;b&gt; &amp; c'), 'a <b> & c')
})
test('ST2 escapeMrkdwn は一斉メンションとリンクを無効にする', () => {
  assert.equal(escapeMrkdwn('<!channel> & <@U1>'), '&lt;!channel&gt; &amp; &lt;@U1&gt;')
})
test('ST3 normalizeTextMarkup はメンションを残し、リンクやチャンネルを読める形にする', () => {
  assert.equal(
    normalizeTextMarkup('<@U012AB3CD|yamada> <#C1|dev> <!here> <https://x.test/a|A> <https://x.test/b> &amp;'),
    '<@U012AB3CD> #dev @here A (https://x.test/a) https://x.test/b &',
  )
})
test('ST4 flattenRichText は section・list・preformatted・quote を行にする', () => {
  const blocks: Json[] = [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: '起票者: ' },
            { type: 'user', user_id: 'U012AB3CD' },
            { type: 'text', text: '\n' },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          indent: 0,
          elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'a' }] }],
        },
        {
          type: 'rich_text_list',
          style: 'ordered',
          indent: 1,
          elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'b' }] }],
        },
        { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'code' }] },
        { type: 'rich_text_quote', elements: [{ type: 'text', text: 'q1\nq2' }] },
      ],
    },
  ]
  assert.equal(flattenRichText(blocks), '起票者: <@U012AB3CD>\n• a\n  1. b\n```\ncode\n```\n> q1\n> q2')
})
test('ST5 link・emoji・channel・broadcast の inline 要素', () => {
  const s: Json = {
    type: 'rich_text_section',
    elements: [
      { type: 'link', url: 'https://x.test', text: 'X' },
      { type: 'text', text: ' ' },
      { type: 'link', url: 'https://y.test' },
      { type: 'text', text: ' ' },
      { type: 'emoji', name: 'bug' },
      { type: 'text', text: ' ' },
      { type: 'channel', channel_id: 'C1' },
      { type: 'text', text: ' ' },
      { type: 'broadcast', range: 'here' },
    ],
  }
  assert.equal(
    flattenRichText([{ type: 'rich_text', elements: [s] }]),
    'X (https://x.test) https://y.test :bug: #C1 @here',
  )
})
test('ST6 rich_text が無ければ null', () => {
  assert.equal(flattenRichText([{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }]), null)
  assert.equal(flattenRichText(undefined), null)
})
test('ST7 messageText は blocks を優先し、無ければ text を整形して使う', () => {
  assert.deepEqual(
    messageText(
      richTextMessage('1.0', [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'B' }] }], { text: 'T' }),
    ),
    { text: 'B', source: 'blocks' },
  )
  assert.deepEqual(messageText(textMessage('1.0', 'a &amp; <@U1>')), { text: 'a & <@U1>', source: 'text' })
})
test('ST8 未知の要素は無視して落ちない', () => {
  const blocks: Json[] = [
    {
      type: 'rich_text',
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'mystery' }, { type: 'text', text: 'ok' }] },
        { type: 'rich_text_unknown' },
      ],
    },
  ]
  assert.equal(flattenRichText(blocks), 'ok')
})
test('ST9 permalink とメンション', () => {
  assert.equal(
    messagePermalink(TEAM_URL, CHANNEL, '1712345678.000100'),
    'https://acme.slack.com/archives/C0123456789/p1712345678000100',
  )
  assert.equal(firstUserMention('<@U012AB3CD> さん'), 'U012AB3CD')
  assert.equal(firstUserMention('なし'), null)
})
test('ST10 ts は数値として比べる', () => {
  assert.equal(tsMicro('1712345678.000100'), 1712345678000100)
  assert.equal(tsMicro('1.5'), 1500000)
  assert.ok(
    compareTs('999.5', '1000.000000') < 0 &&
      compareTs('1000.1', '1000.000001') > 0 &&
      compareTs('2.0', '2.000000') === 0,
  )
  assert.equal(formatTs(NOW_SEC), '1794441600.000000')
})
