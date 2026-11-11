import { readJson, writeJson } from './fs.ts'
import { asObject, asString } from './json.ts'
import { homePaths } from './paths.ts'
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
}
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
  }
}
export const saveConfig = (home: string, config: Config): void => writeJson(homePaths(home).config, config)
