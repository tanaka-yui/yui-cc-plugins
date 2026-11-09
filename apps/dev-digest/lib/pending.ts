import { buildSources } from './config.ts'
import { previousIncompleteStart, runFailures, undelivered } from './db.ts'
import { X_SOURCE } from './defaults.ts'
import { atLeast } from './severity.ts'

import type { Config, RepoConfig, Section } from './config.ts'
import type { Db, StoredItem } from './db.ts'
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

export type PendingRepo = {
  slug: string
  displayName: string
  watch: RepoConfig['watch']
  candidateIds: number[]
  ownIds: number[]
}

export type PendingFile = {
  runId: number
  generatedAt: string
  previousIncomplete: string | null
  items: PendingEntry[]
  globalIds: number[]
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

  const globalIds = collect(
    undelivered(db, 'global', globalStores, null).filter((item) => keep(item, config.jvnMinSeverity)),
  )
  const pendingRepos: PendingRepo[] = repos.map((repo) => {
    const destination = `repo:${repo.slug}` as const
    const ownStores = unique(
      sources.filter((s) => s.scope === 'repo' && s.repoSlugs.includes(repo.slug)).map((s) => s.storeAs),
    )
    const threshold = repo.jvnMinSeverity ?? config.jvnMinSeverity
    return {
      slug: repo.slug,
      displayName: repo.displayName,
      watch: repo.watch,
      candidateIds: collect(
        undelivered(db, destination, globalStores, repo.addedAt).filter((item) => keep(item, threshold)),
      ),
      ownIds: collect(undelivered(db, destination, ownStores, repo.addedAt)),
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
    globalIds,
    repos: pendingRepos,
    failures: runFailures(db, runId),
  }
}
