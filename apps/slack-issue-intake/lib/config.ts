import {
  BRANCH_PATTERN,
  CHANNEL_ID_PATTERN,
  DAILY_AT_PATTERN,
  DEFAULT_DAILY_AT,
  EXISTING_MODES,
  FORM_BASE_FIELD_MIN_BRANCHES,
  REPO_PATTERN,
} from './defaults.ts'
import { readJson, writeJson } from './fs.ts'
import { asObject, asString } from './json.ts'
import { homePaths } from './paths.ts'

import type { Json } from './json.ts'
export type Config = {
  version: 1
  channel: string
  repos: RepoSetting[]
  defaultRepo: string
  report: ReportSetting
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
// branches は向き先の候補（setup か init --branches が書く。無いリポジトリには鍵ごと無い）
export type RepoSetting = {
  name: string
  form: boolean
  existing: (typeof EXISTING_MODES)[number]
  branches?: string[]
}
export const readExisting = (value: Json | undefined): RepoSetting['existing'] | null =>
  EXISTING_MODES.find((mode) => mode === value) ?? null
export type ReportSetting = { channel: string | null; dailyAt: string; source: string | null }
export const DEFAULT_REPORT: ReportSetting = { channel: null, dailyAt: DEFAULT_DAILY_AT, source: null }
export const formRepos = (config: Config): string[] =>
  config.repos.filter((r) => r.form || r.name === config.defaultRepo).map((r) => r.name)
export const repoSetting = (config: Config, name: string): RepoSetting | null =>
  config.repos.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null
// 投稿の向き先を確かめる候補。リポジトリを選んでいない投稿（null）は既定の起票先の候補
export const repoBranches = (config: Config, repo: string | null): string[] =>
  repoSetting(config, repo ?? config.defaultRepo)?.branches ?? []
// フォームの向き先の欄の選択肢（おまかせを除く）。候補が 2 つ以上あるフォームの対象のリポジトリの候補を合わせる。空なら欄を出さない
export const formBranches = (config: Config): string[] => [
  ...new Set(
    formRepos(config).flatMap((name) => {
      const branches = repoBranches(config, name)
      return branches.length >= FORM_BASE_FIELD_MIN_BRANCHES ? branches : []
    }),
  ),
]
// 空でない・重複の無いブランチ名の配列か
export const validBranches = (value: Json | readonly string[] | undefined): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((b) => typeof b === 'string' && BRANCH_PATTERN.test(b)) &&
  new Set(value).size === value.length
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
  for (const key of ['channel', 'ghPath', 'pluginRoot']) if (!asString(o[key])) return null
  for (const key of ['teamId', 'teamUrl', 'botUserId', 'botId']) if (!asString(slack[key])) return null
  if (!asString(github.login)) return null
  for (const key of ['workspaceSelector', 'automationId'])
    if (orca[key] !== null && asString(orca[key]) === null) return null
  if (o.acceptedPermissions !== null && asString(o.acceptedPermissions) === null) return null
  const repos: RepoSetting[] = []
  if (o.repos !== undefined) {
    if (!Array.isArray(o.repos) || o.repos.length === 0) return null
    for (const value of o.repos) {
      const r = asObject(value)
      const existing = readExisting(r?.existing)
      if (
        !r ||
        typeof r.name !== 'string' ||
        !REPO_PATTERN.test(r.name) ||
        typeof r.form !== 'boolean' ||
        existing === null ||
        (r.branches !== undefined && !validBranches(r.branches)) ||
        repos.some((old) => old.name.toLowerCase() === String(r.name).toLowerCase())
      )
        return null
      repos.push({
        name: r.name,
        form: r.form,
        existing,
        ...(validBranches(r.branches) ? { branches: [...r.branches] } : {}),
      })
    }
  } else {
    if (typeof o.repo !== 'string' || !REPO_PATTERN.test(o.repo)) return null
    repos.push({ name: o.repo, form: true, existing: 'skip' })
  }
  const defaultRepo = o.repos !== undefined ? asString(o.defaultRepo) : asString(o.repo)
  if (!defaultRepo || !repos.some((r) => r.name === defaultRepo)) return null
  let report = DEFAULT_REPORT
  if (o.report !== undefined) {
    const r = asObject(o.report)
    if (
      !r ||
      (r.channel !== null && (typeof r.channel !== 'string' || !CHANNEL_ID_PATTERN.test(r.channel))) ||
      typeof r.dailyAt !== 'string' ||
      !DAILY_AT_PATTERN.test(r.dailyAt) ||
      (r.source !== null && (typeof r.source !== 'string' || !r.source.trim()))
    )
      return null
    report = { channel: asString(r.channel), dailyAt: r.dailyAt, source: asString(r.source) }
  }
  const mention = readMention(o.mention)
  if (!mention) return null
  return {
    version: 1,
    channel: String(o.channel),
    repos,
    defaultRepo,
    report,
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
