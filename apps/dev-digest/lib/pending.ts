import { categoryResolver, isExcluded, normalizeUrl } from './category.ts'
import { buildSources, SECTIONS } from './config.ts'
import { previousIncompleteStart, runFailures, sentUrls, undelivered } from './db.ts'
import { CUSTOM_FEED_PREFIX, X_SOURCE } from './defaults.ts'
import { asArray, asObject, asString } from './json.ts'
import { atLeast, parseSeverity } from './severity.ts'

import type { Config, RepoConfig, Section } from './config.ts'
import type { Db, Destination, StoredItem } from './db.ts'
import type { Json, JsonObject } from './json.ts'
import type { Severity } from './severity.ts'

export type PendingEntry = {
  id: number
  revision: number
  section: Section
  // 通知でどの見出し（カテゴリ）に載るか。組み込みならセクション名、追加したカテゴリならその id
  category: string
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
    if (storeAs.startsWith(CUSTOM_FEED_PREFIX)) return 'feed'
    return storeAs.startsWith('releases:') ? 'releases' : 'devto'
  }
}

// タイトルか製品名にキーワードのどれかを含むか（大文字小文字は区別しない）。キーワードが空なら常に true
export const matchesKeywords = (item: Pick<StoredItem, 'title' | 'products'>, keywords: string[]): boolean => {
  if (keywords.length === 0) return true
  const haystack = [item.title, ...item.products].join('\n').toLowerCase()
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))
}

// 送り先ごとの重複の判定。送り済みの URL と、この実行で先に候補にした URL を覚える。
// 同じ項目の更新（【追記】）は、自分が送った URL なので重複にしない
const duplicateChecker = (db: Db, destination: Destination): ((item: StoredItem) => boolean) => {
  const owners = new Map<string, Set<number>>()
  for (const sent of sentUrls(db, destination)) {
    const url = normalizeUrl(sent.url)
    owners.set(url, (owners.get(url) ?? new Set()).add(sent.id))
  }
  const seen = new Set<string>()
  return (item) => {
    if (item.url.trim() === '') return false
    const url = normalizeUrl(item.url)
    const sentBy = owners.get(url)
    if (seen.has(url) || (sentBy !== undefined && !sentBy.has(item.id))) return true
    seen.add(url)
    return false
  }
}

export const buildPending = (db: Db, config: Config, repos: RepoConfig[], runId: number, now: string): PendingFile => {
  const sources = buildSources(config, repos)
  const sectionOf = sectionByStoreAs(config, repos)
  const resolveCategory = categoryResolver(config)
  const categoryOf = (item: StoredItem): string => resolveCategory({ ...item, section: sectionOf(item.sourceId) })
  // X は collect の対象ではないが、全体の投稿として扱う（X のカテゴリを止めていれば扱わない）
  const xStores = config.disabledSections.includes('x') ? [] : [X_SOURCE.storeAs]
  const globalStores = unique([...sources.filter((s) => s.scope === 'global').map((s) => s.storeAs), ...xStores])
  const passesJvn = (item: StoredItem, threshold: Severity | null, keywords: string[]): boolean =>
    threshold === null ||
    sectionOf(item.sourceId) !== 'jvn' ||
    (atLeast(item.severity, threshold) && matchesKeywords(item, keywords))

  const byId = new Map<number, StoredItem>()
  // 送る候補と filtered（JVN のしきい値・キーワード、除外ワード、重複で外したもの）に分ける。
  // threshold が null なら JVN の条件を見ない（リポジトリの Releases など）
  const split = (
    items: StoredItem[],
    isDuplicate: (item: StoredItem) => boolean,
    threshold: Severity | null,
    keywords: string[] = [],
  ): { ids: number[]; filtered: ItemRef[] } => {
    const ids: number[] = []
    const filtered: ItemRef[] = []
    for (const item of items) {
      // 重複は最後に見る（外す項目に URL を取らせない）
      const keep =
        passesJvn(item, threshold, keywords) && !isExcluded(config, item, categoryOf(item)) && !isDuplicate(item)
      if (keep) {
        byId.set(item.id, item)
        ids.push(item.id)
      } else {
        filtered.push({ id: item.id, revision: item.revision })
      }
    }
    return { ids, filtered }
  }

  // JVN のキーワードは全体にだけ効かせる。リポジトリの候補は watch を見て digest で選ぶので、ここでは絞らない
  const global = split(
    undelivered(db, 'global', globalStores, null),
    duplicateChecker(db, 'global'),
    config.jvnMinSeverity,
    config.jvnKeywords,
  )
  const pendingRepos: PendingRepo[] = repos.map((repo) => {
    const destination = `repo:${repo.slug}` as const
    const ownStores = unique(
      sources.filter((s) => s.scope === 'repo' && s.repoSlugs.includes(repo.slug)).map((s) => s.storeAs),
    )
    // ownIds は必ず送るので、候補と同じ URL なら own を残す（own を先に見る）
    const isDuplicate = duplicateChecker(db, destination)
    const own = split(undelivered(db, destination, ownStores, repo.addedAt), isDuplicate, null)
    const candidates = split(
      undelivered(db, destination, globalStores, repo.addedAt),
      isDuplicate,
      repo.jvnMinSeverity ?? config.jvnMinSeverity,
    )
    return {
      slug: repo.slug,
      displayName: repo.displayName,
      watch: repo.watch,
      candidateIds: candidates.ids,
      ownIds: own.ids,
      filtered: [...candidates.filtered, ...own.filtered],
    }
  })

  const items = [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .map(
      (item): PendingEntry => ({
        id: item.id,
        revision: item.revision,
        section: sectionOf(item.sourceId),
        category: categoryOf(item),
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
  const category = asString(o.category)
  const title = asString(o.title)
  const url = asString(o.url)
  const summary = asString(o.summary)
  if (!isInt(o.id) || !isInt(o.revision) || section === undefined || typeof o.updated !== 'boolean') return null
  if (sourceId === null || title === null || url === null || summary === null || products === null) return null
  if (category === null) return null
  if (author === undefined || publishedAt === undefined || severityText === undefined) return null
  if (typeof severityText === 'string' && severity === null) return null
  return {
    id: o.id,
    revision: o.revision,
    section,
    category,
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
