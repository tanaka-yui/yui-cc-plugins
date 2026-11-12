import type { Json, JsonObject } from '../../lib/json.ts'
export const TEAM_URL = 'https://acme.slack.com/'
export const TEAM_ID = 'T0ACME001'
export const CHANNEL = 'C0123456789'
export const BOT_USER = 'UBOT00001'
export const BOT_ID = 'BBOT00001'
export const WORKFLOW_BOT_ID = 'BWF000001'
export const REPORTER = 'U012AB3CD'
export const NOW = '2026-11-12T00:00:00.000Z'
export const NOW_SEC = Math.floor(Date.parse(NOW) / 1000)
export const tsAt = (secondsBeforeNow: number, micro = 100): string =>
  `${NOW_SEC - secondsBeforeNow}.${String(micro).padStart(6, '0')}`
export const templateText = (
  o: { title?: string; category?: string; priority?: string; reporter?: string; body?: string; colon?: string } = {},
): string => {
  const c = o.colon ?? ':'
  return `[issue-intake]\nタイトル${c} ${o.title ?? 'ログインできない'}\nカテゴリ${c} ${o.category ?? 'バグ'}\n優先度${c} ${o.priority ?? 'high'}\n起票者${c} ${o.reporter ?? `<@${REPORTER}>`}\n本文${c}\n${o.body ?? '本文1\n本文2'}`
}
// カテゴリ別フォームの投稿。項目の並びと複数行かどうかは、本体の FORM_KINDS から引かずにここで固定する（本体の誤りを写さないため）
const KIND_ITEMS: Record<string, ReadonlyArray<readonly [label: string, long: boolean]>> = {
  バグ: [
    ['事象', true],
    ['エラーログ', true],
    ['対応策', true],
    ['画面のURL', false],
    ['ソースコードのパス', false],
  ],
  要望: [
    ['現在', true],
    ['理想', true],
    ['画面のURL', false],
    ['ソースコードのパス', false],
  ],
  新機能: [['仕様', true]],
}
export const kindText = (
  category: string,
  values: Record<string, string>,
  o: { title?: string; priority?: string; reporter?: string } = {},
): string =>
  [
    '[issue-intake]',
    `*タイトル:* ${o.title ?? 'ログインできない'}`,
    `*カテゴリ:* ${category}`,
    `*優先度:* ${o.priority ?? 'high'}`,
    `*起票者:* ${o.reporter ?? `<@${REPORTER}>`}`,
    ...(KIND_ITEMS[category] ?? []).flatMap(([label, long]) =>
      long ? ['', `*${label}:*`, '```', values[label] ?? '', '```'] : ['', `*${label}:* ${values[label] ?? ''}`],
    ),
  ].join('\n')
export const textMessage = (ts: string, text: string, extra: JsonObject = {}): JsonObject => ({
  type: 'message',
  subtype: 'bot_message',
  bot_id: WORKFLOW_BOT_ID,
  ts,
  text,
  ...extra,
})
export const richTextMessage = (ts: string, sections: Json[], extra: JsonObject = {}): JsonObject =>
  textMessage(ts, '', { blocks: [{ type: 'rich_text', elements: sections }], ...extra })
