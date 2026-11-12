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
