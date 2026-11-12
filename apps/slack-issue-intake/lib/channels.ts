import { CHANNEL_ID_PATTERN, CHANNEL_PAGE_SIZE, ERROR_CHANNEL_NOT_FOUND } from './defaults.ts'
import { asArray, asObject, asString, get } from './json.ts'

import type { Json } from './json.ts'
import type { SlackClient, SlackFailure } from './slack-api.ts'

export type Channel = { id: string; name: string; isPrivate: boolean; isMember: boolean }

const HASH_PREFIX = /^[#＃]+/
const CHANNEL_TYPES = 'public_channel,private_channel'

export const normalizeChannelName = (input: string): string => input.trim().replace(HASH_PREFIX, '').toLowerCase()

const toChannel = (value: Json | undefined): Channel | null => {
  const o = asObject(value)
  const id = o && asString(o.id)
  const name = o && asString(o.name)
  return o && id && name ? { id, name, isPrivate: o.is_private === true, isMember: o.is_member === true } : null
}

export const findChannel = async (
  slack: SlackClient,
  input: string,
  deadline: number,
): Promise<{ ok: true; channel: Channel | null } | SlackFailure> => {
  const name = normalizeChannelName(input)
  if (CHANNEL_ID_PATTERN.test(name.toUpperCase())) {
    const info = await slack.call('conversations.info', { channel: name.toUpperCase() }, deadline)
    if (info.ok) {
      const channel = toChannel(get(info.body, 'channel'))
      return { ok: true, channel: get(info.body, 'channel', 'is_archived') === true ? null : channel }
    }
    // customers のような名前は ID の形に見えるので、ID として見つからなければ名前で探す
    if (info.error !== ERROR_CHANNEL_NOT_FOUND) return info
  }
  let cursor = ''
  do {
    const page = await slack.call(
      'conversations.list',
      {
        types: CHANNEL_TYPES,
        exclude_archived: 'true',
        limit: String(CHANNEL_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      },
      deadline,
    )
    if (!page.ok) return page
    const channels = asArray(page.body.channels) ?? []
    for (const c of channels) {
      const channel = toChannel(c)
      if (channel?.name === name) return { ok: true, channel }
    }
    cursor = asString(get(page.body, 'response_metadata', 'next_cursor')) ?? ''
  } while (cursor)
  return { ok: true, channel: null }
}

export const joinChannel = async (
  slack: SlackClient,
  channelId: string,
  deadline: number,
): Promise<{ ok: true } | SlackFailure> => {
  const joined = await slack.call('conversations.join', { channel: channelId }, deadline)
  return joined.ok ? { ok: true } : joined
}
