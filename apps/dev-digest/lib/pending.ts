import { buildSources } from './config.ts'
import { previousIncompleteStart, runFailures, undelivered } from './db.ts'
import { X_SOURCE } from './defaults.ts'
import { asArray, asObject, asString } from './json.ts'
import { atLeast, parseSeverity } from './severity.ts'

import type { Config, RepoConfig, Section } from './config.ts'
import type { Db, StoredItem } from './db.ts'
import type { Json, JsonObject } from './json.ts'
import type { Severity } from './severity.ts'

export type PendingEntry = {
  id: number
  revision: number
  section: Section
  sourceId: string
  title: string
  url: string
  summary: string
  author: string | null
  publishedAt: string | null
  severity: Severity | null
  products: string[]
  updated: boolean
}

// 項目と revision の組。filtered は JVN のしきい値で外した項目で、publish がその送り先に filtered として記録する
export type ItemRef = { id: number; revision: number }

export type PendingRepo = {
  slug: string
  displayName: string
  watch: RepoConfig['watch']
  candidateIds: number[]
  ownIds: number[]
  filtered: ItemRef[]
}

export type PendingFile = {
  runId: number
  generatedAt: string
  previousIncomplete: string | null
  items: PendingEntry[]
  globalIds: number[]
  filtered: ItemRef[]
  repos: PendingRepo[]
  failures: Array<{ sourceId: string; reason: string }>
}

const unique = (values: string[]): string[] => [...new Set(values)]

// storeAs → section。設定から外れた source の項目も DB に残るので、接頭辞で推す
export const sectionByStoreAs = (config: Config, repos: RepoConfig[]): ((storeAs: string) => Section) => {
  const sections = new Map<string, Section>()
  for (const source of [...buildSources(config, repos), X_SOURCE]) sections.set(source.storeAs, source.section)
  return (storeAs) => {
    const known = sections.get(storeAs)
    if (known !== undefined) return known
    return storeAs.startsWith('releases:') ? 'releases' : 'devto'
  }
}

export const buildPending = (db: Db, config: Config, repos: RepoConfig[], runId: number, now: string): PendingFile => {
  const sources = buildSources(config, repos)
  const sectionOf = sectionByStoreAs(config, repos)
  // X は collect の対象ではないが、全体の投稿として扱う
  const globalStores = unique([...sources.filter((s) => s.scope === 'global').map((s) => s.storeAs), X_SOURCE.storeAs])
  const keep = (item: StoredItem, threshold: Severity): boolean =>
    sectionOf(item.sourceId) !== 'jvn' || atLeast(item.severity, threshold)

  const byId = new Map<number, StoredItem>()
  const collect = (items: StoredItem[]): number[] => {
    for (const item of items) byId.set(item.id, item)
    return items.map((item) => item.id)
  }
  // しきい値を越えたものは送る候補に、外れたものは filtered に分ける
  const split = (items: StoredItem[], threshold: Severity): { ids: number[]; filtered: ItemRef[] } => ({
    ids: collect(items.filter((item) => keep(item, threshold))),
    filtered: items.filter((item) => !keep(item, threshold)).map((item) => ({ id: item.id, revision: item.revision })),
  })

  const global = split(undelivered(db, 'global', globalStores, null), config.jvnMinSeverity)
  const pendingRepos: PendingRepo[] = repos.map((repo) => {
    const destination = `repo:${repo.slug}` as const
    const ownStores = unique(
      sources.filter((s) => s.scope === 'repo' && s.repoSlugs.includes(repo.slug)).map((s) => s.storeAs),
    )
    const candidates = split(
      undelivered(db, destination, globalStores, repo.addedAt),
      repo.jvnMinSeverity ?? config.jvnMinSeverity,
    )
    return {
      slug: repo.slug,
      displayName: repo.displayName,
      watch: repo.watch,
      candidateIds: candidates.ids,
      ownIds: collect(undelivered(db, destination, ownStores, repo.addedAt)),
      filtered: candidates.filtered,
    }
  })

  const items = [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .map(
      (item): PendingEntry => ({
        id: item.id,
        revision: item.revision,
        section: sectionOf(item.sourceId),
        sourceId: item.sourceId,
        title: item.title,
        url: item.url,
        summary: item.summary,
        author: item.author,
        publishedAt: item.publishedAt,
        severity: item.severity,
        products: item.products,
        updated: item.updated,
      }),
    )
  return {
    runId,
    generatedAt: now,
    previousIncomplete: previousIncompleteStart(db, runId),
    items,
    globalIds: global.ids,
    filtered: global.filtered,
    repos: pendingRepos,
    failures: runFailures(db, runId),
  }
}

const SECTIONS: readonly Section[] = ['jvn', 'aws', 'gcp', 'x', 'devto', 'releases']

const isInt = (value: Json | undefined): value is number => typeof value === 'number' && Number.isInteger(value)

// 要素がすべて条件を満たす配列だけを返す。1 つでも外れれば null
const mapAll = <T>(value: Json | undefined, parse: (entry: Json) => T | null): T[] | null => {
  const array = asArray(value)
  if (array === null) return null
  const result: T[] = []
  for (const entry of array) {
    const parsed = parse(entry)
    if (parsed === null) return null
    result.push(parsed)
  }
  return result
}
const intList = (value: Json | undefined): number[] | null => mapAll(value, (entry) => (isInt(entry) ? entry : null))
const strList = (value: Json | undefined): string[] | null => mapAll(value, asString)
const filteredList = (value: Json | undefined): ItemRef[] | null =>
  mapAll(value, (entry) => {
    const o = asObject(entry)
    return o !== null && isInt(o.id) && isInt(o.revision) ? { id: o.id, revision: o.revision } : null
  })
// string | null のフィールド。キーが無い・別の型なら undefined
const nullableString = (object: JsonObject, key: string): string | null | undefined => {
  const value = object[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

const parseEntry = (value: Json): PendingEntry | null => {
  const o = asObject(value)
  if (o === null) return null
  const section = SECTIONS.find((candidate) => candidate === o.section)
  const author = nullableString(o, 'author')
  const publishedAt = nullableString(o, 'publishedAt')
  const severityText = nullableString(o, 'severity')
  const severity = typeof severityText === 'string' ? parseSeverity(severityText) : null
  const products = strList(o.products)
  const sourceId = asString(o.sourceId)
  const title = asString(o.title)
  const url = asString(o.url)
  const summary = asString(o.summary)
  if (!isInt(o.id) || !isInt(o.revision) || section === undefined || typeof o.updated !== 'boolean') return null
  if (sourceId === null || title === null || url === null || summary === null || products === null) return null
  if (author === undefined || publishedAt === undefined || severityText === undefined) return null
  if (typeof severityText === 'string' && severity === null) return null
  return {
    id: o.id,
    revision: o.revision,
    section,
    sourceId,
    title,
    url,
    summary,
    author,
    publishedAt,
    severity,
    products,
    updated: o.updated,
  }
}

const parseWatch = (value: Json | undefined): PendingRepo['watch'] | null => {
  const o = asObject(value)
  if (o === null) return null
  const languages = strList(o.languages)
  const cloudServices = strList(o.cloudServices)
  const keywords = strList(o.keywords)
  const packages = mapAll(o.packages, (entry) => {
    const p = asObject(entry)
    if (p === null) return null
    const name = asString(p.name)
    const ecosystem = asString(p.ecosystem)
    const github = nullableString(p, 'github')
    return name === null || ecosystem === null || github === undefined ? null : { name, ecosystem, github }
  })
  if (languages === null || cloudServices === null || keywords === null || packages === null) return null
  return { languages, packages, cloudServices, keywords }
}

const parsePendingRepo = (value: Json): PendingRepo | null => {
  const o = asObject(value)
  if (o === null) return null
  const slug = asString(o.slug)
  const displayName = asString(o.displayName)
  const watch = parseWatch(o.watch)
  const candidateIds = intList(o.candidateIds)
  const ownIds = intList(o.ownIds)
  const filtered = filteredList(o.filtered)
  if (slug === null || displayName === null || watch === null || candidateIds === null || ownIds === null) return null
  if (filtered === null) return null
  return { slug, displayName, watch, candidateIds, ownIds, filtered }
}

// pending.json を型で絞る。形が違えば null
export const parsePending = (value: Json): PendingFile | null => {
  const o = asObject(value)
  if (o === null) return null
  const generatedAt = asString(o.generatedAt)
  const previousIncomplete = nullableString(o, 'previousIncomplete')
  const items = mapAll(o.items, parseEntry)
  const globalIds = intList(o.globalIds)
  const filtered = filteredList(o.filtered)
  const repos = mapAll(o.repos, parsePendingRepo)
  const failures = mapAll(o.failures, (entry) => {
    const f = asObject(entry)
    const sourceId = f === null ? null : asString(f.sourceId)
    const reason = f === null ? null : asString(f.reason)
    return sourceId === null || reason === null ? null : { sourceId, reason }
  })
  if (!isInt(o.runId) || generatedAt === null || previousIncomplete === undefined) return null
  if (items === null || globalIds === null || filtered === null || repos === null || failures === null) return null
  return { runId: o.runId, generatedAt, previousIncomplete, items, globalIds, filtered, repos, failures }
}
