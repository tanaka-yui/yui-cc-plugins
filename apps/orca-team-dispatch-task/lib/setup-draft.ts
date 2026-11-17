import { parseAutoConfig } from './auto-config.ts'
import { parseHosts } from './auto-hosts.ts'
import { autoDir } from './auto-paths.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get } from './json.ts'

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { AutoConfig } from './auto-config.ts'
import type { HostConfig } from './auto-hosts.ts'
import type { AutoState } from './auto-state.ts'
import type { Json, JsonObject } from './json.ts'

export const SETUP_DRAFT_FILE = 'setup.json'
export type SetupDraft = {
  version: 1
  name: string
  done: string[]
  values: {
    intakeConfig?: string
    sources?: AutoConfig['sources']
    repos?: AutoConfig['repos']
    hosts?: HostConfig[]
    lanes?: number
    roles?: AutoConfig['roles']
    everyMinutes?: number
    automation?: NonNullable<AutoConfig['automation']>
    automationCreated?: boolean
  }
}
const stringList = (value: Json | undefined): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
const validValues = (value: JsonObject, name: string): boolean => {
  const seed = { version: 1, name, repos: {}, sources: [] }
  for (const key of ['intakeConfig', 'roles', 'everyMinutes', 'lanes', 'automation']) {
    if (value[key] !== undefined) {
      const parsed = parseAutoConfig({ ...seed, [key]: value[key] }, name)
      if (!parsed) return false
      value[key] = parsed[key as 'intakeConfig' | 'roles' | 'everyMinutes' | 'lanes' | 'automation']
    }
  }
  if (value.automation !== undefined && value.automation === null) return false
  if (value.automationCreated !== undefined && typeof value.automationCreated !== 'boolean') return false
  if (value.repos !== undefined) {
    const config = parseAutoConfig({ ...seed, repos: value.repos }, name)
    if (!config) return false
    value.repos = config.repos
  }
  if (value.sources !== undefined) {
    const sources = asArray(value.sources)
    if (!sources) return false
    for (const row of sources) {
      const source = asObject(row)
      if (!source || !stringList(source.related) || !source.related.length || !asString(source.pick)) return false
      const repos = Object.fromEntries(source.related.map((repo) => [repo, { checkout: '/' }]))
      const { project, ...rest } = source
      if (
        !parseAutoConfig(
          { ...seed, repos, sources: [{ ...rest, ...(project === null ? {} : { project: project ?? null }) }] },
          name,
        )
      )
        return false
    }
  }
  if (value.hosts !== undefined) {
    const hosts = asArray(value.hosts)
    if (!hosts) return false
    const repos = Object.fromEntries(
      hosts.flatMap((h) =>
        Object.keys(asObject(get(h, 'repos')) ?? {}).map((repo) => [
          repo,
          { checkout: '/', verify: [], infra: false, verified: false, ci: true },
        ]),
      ),
    )
    const parsed = parseHosts(value.hosts, repos)
    if (!parsed.ok || !parsed.hosts) return false
    value.hosts = parsed.hosts
  }
  return true
}
export const readDraft = (name: string): SetupDraft | null => {
  const root = asObject(readJson(join(autoDir(name), SETUP_DRAFT_FILE)))
  const values = asObject(root?.values)
  if (
    !root ||
    root.version !== 1 ||
    root.name !== name ||
    !stringList(root.done) ||
    !values ||
    !validValues(values, name)
  )
    return null
  return root as SetupDraft
}
export const writeDraft = (draft: SetupDraft): void => {
  const file = join(autoDir(draft.name), SETUP_DRAFT_FILE)
  try {
    mkdirSync(autoDir(draft.name), { recursive: true })
    if (writeAtomic(file, `${JSON.stringify(draft, null, 2)}\n`)) return
  } catch {
    // 保存先を含めた同じエラーに揃える。
  }
  throw new Error(`下書きを書けません: ${file}`)
}
export const removeDraft = (name: string): void => rmSync(join(autoDir(name), SETUP_DRAFT_FILE), { force: true })
export const draftFromConfig = (config: AutoConfig): SetupDraft => ({
  version: 1,
  name: config.name,
  done: [],
  values: structuredClone({
    intakeConfig: config.intakeConfig,
    sources: config.sources,
    repos: config.repos,
    ...(config.hosts ? { hosts: config.hosts } : { lanes: config.lanes }),
    roles: config.roles,
    everyMinutes: config.everyMinutes,
    ...(config.automation ? { automation: config.automation } : {}),
  }),
})
export const configJsonFromDraft = (draft: SetupDraft, base: JsonObject | null): JsonObject | null => {
  const next = structuredClone(base ?? {})
  next.version = 1
  next.name = draft.name
  const v = draft.values
  for (const key of ['intakeConfig', 'repos', 'roles', 'everyMinutes', 'lanes', 'automation'] as const) {
    const value = v[key]
    if (value !== undefined) next[key] = structuredClone(value)
  }
  if (v.sources)
    next.sources = v.sources.map(({ project, ...source }) => ({ ...source, ...(project ? { project } : {}) }))
  if (v.hosts)
    next.hosts = v.hosts.map(({ spec, repos, ...host }) => ({
      ...host,
      repos: Object.fromEntries(
        Object.entries(repos).map(([repo, { measure, ...pair }]) => [
          repo,
          { ...pair, ...(measure ? { measure } : {}) },
        ]),
      ),
      ...(spec ? { spec } : {}),
    }))
  return parseAutoConfig(next, draft.name) ? next : null
}
export const inUseConflicts = (state: AutoState, next: JsonObject): string[] => {
  const repos = asObject(next.repos) ?? {}
  const sources = asArray(next.sources) ?? []
  const hosts = asArray(next.hosts) ?? [{ id: 'local', repos }]
  const conflicts: string[] = []
  for (const [key, issue] of Object.entries(state.issues)) {
    if (['done', 'failed', 'stopped', 'eng'].includes(issue.phase)) continue
    const host = issue.host ? hosts.find((h) => get(h, 'id') === issue.host) : null
    if (issue.host && !host) conflicts.push(`${key} がマシン ${issue.host} を使っています`)
    for (const repo of issue.targets) {
      if (!Object.hasOwn(repos, repo)) conflicts.push(`${key} がリポジトリ ${repo} を使っています`)
      if (host && !Object.hasOwn(asObject(get(host, 'repos')) ?? {}, repo))
        conflicts.push(`${key} がマシン ${issue.host} のリポジトリ ${repo} を使っています`)
    }
    if (!sources.some((s) => get(s, 'repo') === issue.repo))
      conflicts.push(`${key} が拾う元 ${issue.repo} を使っています`)
  }
  return conflicts
}
