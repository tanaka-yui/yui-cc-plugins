import { BUILTIN_FEEDS, devtoTagFeed, releasesFeed } from './defaults.ts'
import { asArray, asObject, asString, parseJson } from './json.ts'
import { homePaths } from './paths.ts'
import { parseSeverity, type Severity } from './severity.ts'

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Json, JsonObject } from './json.ts'

export const SECTIONS = ['jvn', 'aws', 'gcp', 'x', 'devto', 'releases'] as const
export type Section = (typeof SECTIONS)[number]

export type FeedSource = {
  id: string
  // DB に入れるときの source_id。JVN の 2 フィードは同じ脆弱性を載せるので 'jvn' に揃える
  storeAs: string
  url: string
  section: Section
  trackUpdates: boolean
  scope: 'global' | 'repo'
}

export type Config = {
  version: 1
  schedule: { trigger: 'daily' | 'weekdays'; time: string; timezone: string }
  jvnMinSeverity: Severity
  // 全体向けの JVN を、タイトルか製品名にどれかを含むものだけに絞る。空なら絞らない（しきい値だけ）
  jvnKeywords: string[]
  devtoTags: string[]
  x: { listUrl: string | null; hashtags: string[] }
  orca: { workspaceSelector: string | null; automationId: string | null }
  pluginRoot: string
}

export type WatchPackage = { name: string; ecosystem: string; github: string | null }

export type RepoConfig = {
  slug: string
  displayName: string
  path: string
  addedAt: string
  jvnMinSeverity: Severity | null
  devtoTags: string[]
  watch: { languages: string[]; packages: WatchPackage[]; cloudServices: string[]; keywords: string[] }
}

export type ResolvedSource = FeedSource & { repoSlugs: string[] }

const DIR_MODE = 0o700
const TRIGGERS: readonly Config['schedule']['trigger'][] = ['daily', 'weekdays']

const str = (object: JsonObject, key: string): string | null => asString(object[key])

const nullableStr = (object: JsonObject, key: string): string | null | undefined => {
  const value = object[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

const strList = (value: Json | undefined): string[] | null => {
  const array = asArray(value)
  if (array === null) return null
  const items: string[] = []
  for (const item of array) {
    if (typeof item !== 'string') return null
    items.push(item)
  }
  return items
}

const parsePackage = (value: Json): WatchPackage | null => {
  const object = asObject(value)
  if (object === null) return null
  const name = str(object, 'name')
  const ecosystem = str(object, 'ecosystem')
  const github = nullableStr(object, 'github')
  if (name === null || ecosystem === null || github === undefined) return null
  return { name, ecosystem, github }
}

export const parseConfig = (value: Json): Config | string => {
  const root = asObject(value)
  if (root === null) return 'config: オブジェクトではありません'
  if (root.version !== 1) return 'config.version: 1 のみ対応しています'
  const schedule = asObject(root.schedule)
  const trigger = schedule === null ? null : TRIGGERS.find((t) => t === schedule.trigger)
  const time = schedule === null ? null : str(schedule, 'time')
  const timezone = schedule === null ? null : str(schedule, 'timezone')
  if (trigger === null || trigger === undefined || time === null || timezone === null) {
    return 'config.schedule: trigger (daily|weekdays) / time / timezone が必要です'
  }
  const jvnMinSeverity = typeof root.jvnMinSeverity === 'string' ? parseSeverity(root.jvnMinSeverity) : null
  if (jvnMinSeverity === null) return 'config.jvnMinSeverity: low|medium|high|critical のいずれかにしてください'
  // jvnKeywords より前に作った設定には無いので、無ければ空（絞らない）とみなす
  const jvnKeywords = root.jvnKeywords === undefined ? [] : strList(root.jvnKeywords)
  if (jvnKeywords === null) return 'config.jvnKeywords: 文字列の配列にしてください'
  const devtoTags = strList(root.devtoTags)
  if (devtoTags === null) return 'config.devtoTags: 文字列の配列にしてください'
  const x = asObject(root.x)
  const listUrl = x === null ? undefined : nullableStr(x, 'listUrl')
  const hashtags = x === null ? null : strList(x.hashtags)
  if (listUrl === undefined || hashtags === null)
    return 'config.x: listUrl (文字列か null) と hashtags (文字列の配列) が必要です'
  const orca = asObject(root.orca)
  const workspaceSelector = orca === null ? undefined : nullableStr(orca, 'workspaceSelector')
  const automationId = orca === null ? undefined : nullableStr(orca, 'automationId')
  if (workspaceSelector === undefined || automationId === undefined) {
    return 'config.orca: workspaceSelector と automationId (文字列か null) が必要です'
  }
  const pluginRoot = str(root, 'pluginRoot')
  if (pluginRoot === null) return 'config.pluginRoot: 文字列が必要です'
  return {
    version: 1,
    schedule: { trigger, time, timezone },
    jvnMinSeverity,
    jvnKeywords,
    devtoTags,
    x: { listUrl, hashtags },
    orca: { workspaceSelector, automationId },
    pluginRoot,
  }
}

export const parseRepoConfig = (value: Json): RepoConfig | string => {
  const root = asObject(value)
  if (root === null) return 'repo: オブジェクトではありません'
  const slug = str(root, 'slug')
  const displayName = str(root, 'displayName')
  const path = str(root, 'path')
  const addedAt = str(root, 'addedAt')
  if (slug === null || displayName === null || path === null || addedAt === null) {
    return 'repo: slug / displayName / path / addedAt (文字列) が必要です'
  }
  let jvnMinSeverity: Severity | null = null
  if (root.jvnMinSeverity !== null && root.jvnMinSeverity !== undefined) {
    jvnMinSeverity = typeof root.jvnMinSeverity === 'string' ? parseSeverity(root.jvnMinSeverity) : null
    if (jvnMinSeverity === null) return 'repo.jvnMinSeverity: low|medium|high|critical か null にしてください'
  }
  const devtoTags = strList(root.devtoTags)
  if (devtoTags === null) return 'repo.devtoTags: 文字列の配列にしてください'
  const watch = asObject(root.watch)
  const languages = watch === null ? null : strList(watch.languages)
  const cloudServices = watch === null ? null : strList(watch.cloudServices)
  const keywords = watch === null ? null : strList(watch.keywords)
  const packageValues = watch === null ? null : asArray(watch.packages)
  if (languages === null || cloudServices === null || keywords === null || packageValues === null) {
    return 'repo.watch: languages / packages / cloudServices / keywords が必要です'
  }
  const packages: WatchPackage[] = []
  for (const item of packageValues) {
    const parsed = parsePackage(item)
    if (parsed === null) return 'repo.watch.packages: name / ecosystem / github (文字列か null) が必要です'
    packages.push(parsed)
  }
  return {
    slug,
    displayName,
    path,
    addedAt,
    jvnMinSeverity,
    devtoTags,
    watch: { languages, packages, cloudServices, keywords },
  }
}

// owner/repo → owner__repo.json
export const slugToFile = (slug: string): string => `${slug.replaceAll('/', '__')}.json`

// 一時ファイルに書いてから rename する（途中で切れた設定ファイルを残さない）
const writeJson = (file: string, dir: string, value: Config | RepoConfig): void => {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

const readJson = (file: string): Json | null => {
  try {
    return parseJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export const loadConfig = (home: string): Config | null => {
  const json = readJson(homePaths(home).config)
  if (json === null) return null
  const parsed = parseConfig(json)
  return typeof parsed === 'string' ? null : parsed
}

export const saveConfig = (home: string, config: Config): void => {
  writeJson(homePaths(home).config, home, config)
}

export const loadRepos = (home: string): RepoConfig[] => {
  const { reposDir } = homePaths(home)
  let names: string[]
  try {
    names = readdirSync(reposDir)
  } catch {
    return []
  }
  const repos: RepoConfig[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const json = readJson(join(reposDir, name))
    if (json === null) continue
    const parsed = parseRepoConfig(json)
    if (typeof parsed !== 'string') repos.push(parsed)
  }
  return repos
}

export const saveRepo = (home: string, repo: RepoConfig): void => {
  const { reposDir } = homePaths(home)
  writeJson(join(reposDir, slugToFile(repo.slug)), reposDir, repo)
}

// slug のファイル名に今入っているリポジトリの slug。無い・読めないなら null
export const storedSlug = (home: string, slug: string): string | null => {
  const json = readJson(join(homePaths(home).reposDir, slugToFile(slug)))
  return json === null ? null : asString(asObject(json)?.slug)
}

export const removeRepo = (home: string, slug: string): boolean => {
  // 同じファイル名の別の slug を消さない
  if (storedSlug(home, slug) !== slug) return false
  rmSync(join(homePaths(home).reposDir, slugToFile(slug)))
  return true
}

// 同じ url は 1 つにまとめ、repoSlugs を合併する。全体のものが先に入るので、
// 全体タグとリポジトリタグが同じ url なら scope は global のまま残る
export const buildSources = (config: Config, repos: RepoConfig[]): ResolvedSource[] => {
  const byUrl = new Map<string, ResolvedSource>()
  const add = (feed: FeedSource, slug: string | null): void => {
    const existing = byUrl.get(feed.url)
    if (existing === undefined) {
      byUrl.set(feed.url, { ...feed, repoSlugs: slug === null ? [] : [slug] })
    } else if (slug !== null && !existing.repoSlugs.includes(slug)) {
      existing.repoSlugs.push(slug)
    }
  }
  for (const feed of BUILTIN_FEEDS) add(feed, null)
  for (const tag of config.devtoTags) add(devtoTagFeed(tag), null)
  for (const repo of repos) {
    for (const tag of repo.devtoTags) add({ ...devtoTagFeed(tag), scope: 'repo' }, repo.slug)
    for (const pkg of repo.watch.packages) {
      if (pkg.github !== null) add(releasesFeed(pkg.github), repo.slug)
    }
  }
  return [...byUrl.values()]
}
