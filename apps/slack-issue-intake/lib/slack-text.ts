import { asArray, asObject, asString } from './json.ts'

import type { Json, JsonObject } from './json.ts'

export const decodeEntities = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
export const escapeMrkdwn = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const normalizeTextMarkup = (text: string): string =>
  decodeEntities(
    text.replace(/<([^>]+)>/g, (_all, value: string) => {
      const [id = '', label] = value.split('|')
      if (id.startsWith('@')) return `<${id}>`
      if (id.startsWith('#')) return `#${label ?? id.slice(1)}`
      if (id.startsWith('!')) return `@${label ?? id.slice(1)}`
      return label ? `${label} (${id})` : id
    }),
  )
const inline = (elements: Json | undefined): string =>
  (asArray(elements) ?? [])
    .map((value) => {
      const e = asObject(value)
      if (!e) return ''
      const s = (key: string): string => asString(e[key]) ?? ''
      switch (e.type) {
        case 'text':
          return s('text')
        case 'link':
          return s('text') ? `${s('text')} (${s('url')})` : s('url')
        case 'user':
          return `<@${s('user_id')}>`
        case 'usergroup':
          return `@${s('usergroup_id')}`
        case 'channel':
          return `#${s('channel_id')}`
        case 'broadcast':
          return `@${s('range')}`
        case 'emoji':
          return `:${s('name')}:`
        case 'date':
          return s('fallback')
        default:
          return ''
      }
    })
    .join('')
const section = (value: Json): string => {
  const e = asObject(value)
  if (!e) return ''
  const text = inline(e.elements).replace(/\n+$/, '')
  switch (e.type) {
    case 'rich_text_section':
      return text
    case 'rich_text_preformatted':
      return `\`\`\`\n${text}\n\`\`\``
    case 'rich_text_quote':
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'rich_text_list':
      return (asArray(e.elements) ?? [])
        .map(
          (child, i) =>
            `${'  '.repeat(Math.max(0, Math.min(20, typeof e.indent === 'number' ? e.indent : 0)))}${e.style === 'ordered' ? `${i + 1}.` : '•'} ${section(child)}`,
        )
        .join('\n')
    default:
      return ''
  }
}
export const flattenRichText = (blocks: Json | undefined): string | null => {
  const rich = (asArray(blocks) ?? []).map(asObject).filter((b) => b?.type === 'rich_text')
  return rich.length
    ? rich
        .flatMap((b) => (asArray(b?.elements) ?? []).map(section))
        .filter(Boolean)
        .join('\n')
        .replace(/\n+$/, '')
    : null
}
export const messageText = (message: JsonObject): { text: string; source: 'blocks' | 'text' } => {
  const rich = flattenRichText(message.blocks)
  return rich === null
    ? { text: normalizeTextMarkup(asString(message.text) ?? ''), source: 'text' }
    : { text: rich, source: 'blocks' }
}
export const firstUserMention = (text: string): string | null => text.match(/<@(U[A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? null
export const messagePermalink = (teamUrl: string, channel: string, ts: string): string =>
  `${teamUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}`
export const tsMicro = (ts: string): number => {
  const [seconds = '0', fraction = ''] = ts.split('.')
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6))
}
export const compareTs = (a: string, b: string): number => tsMicro(a) - tsMicro(b)
export const formatTs = (seconds: number): string => `${seconds}.000000`
