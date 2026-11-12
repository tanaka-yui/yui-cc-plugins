import { readJson, writeJson } from './fs.ts'
import { asObject, asString } from './json.ts'
import { homePaths } from './paths.ts'

import type { Json } from './json.ts'
export type Config = {
  version: 1
  channel: string
  repo: string
  everyMinutes: number
  ghPath: string
  pluginRoot: string
  slack: { teamId: string; teamUrl: string; botUserId: string; botId: string }
  github: { login: string }
  orca: { workspaceSelector: string | null; automationId: string | null }
  acceptedPermissions: string | null
  // ステータスの通知でメンションする Slack のユーザーグループ。asked が false なら setup で聞く（0.3 の config には無い）
  mention: Mention
}
export type Mention = { asked: boolean; groupId: string | null; handle: string | null }
const NOT_ASKED: Mention = { asked: false, groupId: null, handle: null }
const readMention = (value: Json | undefined): Mention | null => {
  if (value === undefined) return NOT_ASKED
  const m = asObject(value)
  if (!m || typeof m.asked !== 'boolean') return null
  for (const key of ['groupId', 'handle']) if (m[key] !== null && asString(m[key]) === null) return null
  return { asked: m.asked, groupId: asString(m.groupId), handle: asString(m.handle) }
}
export const mentionPrefix = (config: Config): string =>
  config.mention.groupId ? `<!subteam^${config.mention.groupId}> ` : ''
export const loadConfig = (home: string): Config | null => {
  const o = asObject(readJson(homePaths(home).config))
  if (!o) return null
  const slack = asObject(o.slack)
  const github = asObject(o.github)
  const orca = asObject(o.orca)
  if (o.version !== 1 || !slack || !github || !orca || typeof o.everyMinutes !== 'number') return null
  for (const key of ['channel', 'repo', 'ghPath', 'pluginRoot']) if (!asString(o[key])) return null
  for (const key of ['teamId', 'teamUrl', 'botUserId', 'botId']) if (!asString(slack[key])) return null
  if (!asString(github.login)) return null
  for (const key of ['workspaceSelector', 'automationId'])
    if (orca[key] !== null && asString(orca[key]) === null) return null
  if (o.acceptedPermissions !== null && asString(o.acceptedPermissions) === null) return null
  const mention = readMention(o.mention)
  if (!mention) return null
  return {
    version: 1,
    channel: String(o.channel),
    repo: String(o.repo),
    everyMinutes: o.everyMinutes,
    ghPath: String(o.ghPath),
    pluginRoot: String(o.pluginRoot),
    slack: {
      teamId: String(slack.teamId),
      teamUrl: String(slack.teamUrl),
      botUserId: String(slack.botUserId),
      botId: String(slack.botId),
    },
    github: { login: String(github.login) },
    orca: { workspaceSelector: asString(orca.workspaceSelector), automationId: asString(orca.automationId) },
    acceptedPermissions: asString(o.acceptedPermissions),
    mention,
  }
}
export const saveConfig = (home: string, config: Config): void => writeJson(homePaths(home).config, config)
