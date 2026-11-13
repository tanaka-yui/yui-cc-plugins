import { AUTO_FILES, autoDir } from './auto-paths.ts'
import { OPUS_MODEL } from './config.ts'
import { readJson } from './fs.ts'
import { asArray, asObject, asString, type Json } from './json.ts'

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type AutoConfig = {
  version: 1
  name: string
  everyMinutes: number
  intakeConfig: string
  sources: Array<{ repo: string; related: string[]; pick: string }>
  repos: Record<string, { checkout: string; verify: string[]; infra: boolean; verified: boolean; ci: boolean }>
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
export const readAutoConfig = (name: string): AutoConfig | null => {
  const input = asObject(readJson(join(autoDir(name), AUTO_FILES.config)))
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
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !related?.length || related.some((r) => !repos[r]) || !pick)
      return null
    sources.push({ repo, related, pick })
  }
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
    intakeConfig:
      input.intakeConfig === undefined
        ? join(homedir(), '.slack-issue-intake/config.json')
        : (asString(input.intakeConfig) ?? ''),
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
    !result.intakeConfig ||
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
export const pickSources = (config: AutoConfig): string[] => {
  const intake = asArray(asObject(readJson(config.intakeConfig))?.repos)
  return (
    intake?.flatMap((r) => {
      const name = asString(asObject(r)?.name)
      return name && config.sources.some((s) => s.repo === name) ? [name] : []
    }) ?? []
  )
}
