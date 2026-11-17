import { parseHosts } from './auto-hosts.ts'
import { AUTO_FILES, autoDir } from './auto-paths.ts'
import { OPUS_MODEL } from './config.ts'
import { readJson } from './fs.ts'
import { INTAKE_HOME_DIRNAME } from './intake-homes.ts'
import { asArray, asObject, asString, type Json } from './json.ts'

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { HostConfig } from './auto-hosts.ts'

export type ProjectRef = { owner: string; number: number }

export type AutoConfig = {
  version: 1
  name: string
  everyMinutes: number
  intakeConfigs: string[]
  sources: Array<{ repo: string; related: string[]; pick: string; project: ProjectRef | null }>
  repos: Record<string, { checkout: string; verify: string[]; infra: boolean; verified: boolean; ci: boolean }>
  hosts: HostConfig[] | null
  automation: { id: string; acceptedFingerprint: string | null } | null
  lanes: number
  roles: { review_mode: 'on' | 'off'; phase_b: 'on' | 'off' }
  limits: { defaultMinutes: number; maxMinutes: number; stallMinutes: number }
  judge: { model: string; effort: string }
  minFreeMemoryMb: number
  minFreeDiskMb: number
}
const count = (value: Json | undefined, fallback: number, min = 1): number =>
  value === undefined ? fallback : typeof value === 'number' && Number.isInteger(value) && value >= min ? value : NaN
const strings = (value: Json | undefined): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0) ? (value as string[]) : null
const boolean = (value: Json | undefined, fallback: boolean): boolean | null =>
  value === undefined ? fallback : typeof value === 'boolean' ? value : null
export const readAutoConfig = (name: string): AutoConfig | null =>
  parseAutoConfig(readJson(join(autoDir(name), AUTO_FILES.config)), name)
export const parseAutoConfig = (value: Json | null, name: string): AutoConfig | null => {
  const input = asObject(value)
  if (!input || input.version !== 1 || input.name !== name) return null
  if (['roles', 'limits', 'judge'].some((key) => input[key] !== undefined && !asObject(input[key]))) return null
  const rawRepos = asObject(input.repos)
  const rawSources = asArray(input.sources)
  if (!rawRepos || !rawSources) return null
  const repos: AutoConfig['repos'] = {}
  for (const [repo, value] of Object.entries(rawRepos)) {
    const r = asObject(value)
    const checkout = asString(r?.checkout)
    const verify = r?.verify === undefined ? [] : strings(r.verify)
    const infra = boolean(r?.infra, false)
    const verified = boolean(r?.verified, false)
    const ci = boolean(r?.ci, true)
    if (
      !/^[^/\s]+\/[^/\s]+$/.test(repo) ||
      !checkout ||
      !isAbsolute(checkout) ||
      !verify ||
      infra === null ||
      verified === null ||
      ci === null
    )
      return null
    repos[repo] = { checkout, verify, infra, verified, ci }
  }
  const sources: AutoConfig['sources'] = []
  for (const value of rawSources) {
    const s = asObject(value)
    const repo = asString(s?.repo)
    const related = strings(s?.related)
    const pick = s?.pick === undefined ? 'Ready' : asString(s.pick)
    const project = s?.project === undefined ? null : asObject(s.project)
    if (
      !repo ||
      !/^[^/\s]+\/[^/\s]+$/.test(repo) ||
      !related?.length ||
      related.some((r) => !repos[r]) ||
      !pick ||
      (s?.project !== undefined &&
        (!project ||
          !asString(project.owner) ||
          typeof project.number !== 'number' ||
          !Number.isInteger(project.number) ||
          project.number < 1))
    )
      return null
    sources.push({
      repo,
      related,
      pick,
      project: project ? { owner: project.owner as string, number: project.number as number } : null,
    })
  }
  const hosts = parseHosts(input.hosts, repos)
  if (!hosts.ok) return null
  const automation = input.automation == null ? null : asObject(input.automation)
  if (
    input.automation != null &&
    (!automation ||
      !asString(automation.id) ||
      (automation.acceptedFingerprint != null && !asString(automation.acceptedFingerprint)))
  )
    return null
  if (input.intakeConfigs !== undefined && input.intakeConfig !== undefined) return null
  const intakeConfigs =
    input.intakeConfigs !== undefined
      ? strings(input.intakeConfigs)
      : input.intakeConfig !== undefined
        ? strings([input.intakeConfig])
        : [join(homedir(), INTAKE_HOME_DIRNAME, 'config.json')]
  if (!intakeConfigs?.length) return null
  const rawRoles = asObject(input.roles)
  const review_mode = rawRoles?.review_mode ?? 'off'
  const phase_b = rawRoles?.phase_b ?? 'off'
  if ((review_mode !== 'off' && review_mode !== 'on') || (phase_b !== 'off' && phase_b !== 'on')) return null
  const limits = asObject(input.limits)
  const judge = asObject(input.judge)
  const result: AutoConfig = {
    version: 1,
    name,
    sources,
    repos,
    hosts: hosts.hosts,
    automation: automation
      ? { id: automation.id as string, acceptedFingerprint: asString(automation.acceptedFingerprint) }
      : null,
    intakeConfigs: [...new Set(intakeConfigs)],
    everyMinutes: count(input.everyMinutes, 5),
    lanes: count(input.lanes, 1),
    roles: { review_mode, phase_b },
    limits: {
      defaultMinutes: count(limits?.defaultMinutes, 60),
      maxMinutes: count(limits?.maxMinutes, 240),
      stallMinutes: count(limits?.stallMinutes, 30),
    },
    judge: {
      model: judge?.model === undefined ? OPUS_MODEL : (asString(judge.model) ?? ''),
      effort: judge?.effort === undefined ? 'high' : (asString(judge.effort) ?? ''),
    },
    minFreeMemoryMb: count(input.minFreeMemoryMb, 4096, 0),
    minFreeDiskMb: count(input.minFreeDiskMb, 10240, 0),
  }
  if (
    !result.judge.model ||
    !result.judge.effort ||
    [
      result.everyMinutes,
      result.lanes,
      result.minFreeMemoryMb,
      result.minFreeDiskMb,
      ...Object.values(result.limits),
    ].some(Number.isNaN) ||
    result.limits.defaultMinutes > result.limits.maxMinutes
  )
    return null
  return result
}
export const intakeRepoNames = (path: string): string[] | null => {
  const repos = asArray(asObject(readJson(path))?.repos)
  if (!repos) return null
  return repos.flatMap((row) => {
    const name = asString(asObject(row)?.name)
    return name && /^[^/\s]+\/[^/\s]+$/.test(name) ? [name] : []
  })
}
export const readIntakeRepos = (config: AutoConfig): { repos: string[]; unreadable: string[] } => {
  const repos = new Set<string>()
  const unreadable: string[] = []
  for (const path of config.intakeConfigs) {
    const names = intakeRepoNames(path)
    if (names === null) unreadable.push(path)
    else for (const name of names) repos.add(name)
  }
  return { repos: [...repos], unreadable }
}
export const pickSources = (config: AutoConfig): string[] =>
  readIntakeRepos(config).repos.filter((repo) => config.sources.some((source) => source.repo === repo))
