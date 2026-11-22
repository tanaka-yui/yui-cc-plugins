import { asArray, asObject, asString, get } from './json.ts'
import { orcaBin } from './orca.ts'

import { hostname } from 'node:os'

import type { AutoConfig } from './auto-config.ts'
import type { Json } from './json.ts'

export const LOCAL_HOST = 'local'
export type HostSpec = {
  cpus: number
  memoryTotalMb: number
  memoryFreeMb: number
  swapTotalMb: number
  diskFreeMb: number
  measuredAt: string
}
export type RepoMeasure = { peakMemoryMb: number; diskGrowthMb: number; measuredAt: string }
export type HostConfig = {
  spec: HostSpec | null
  id: string
  name: string
  lanes: number
  orcaBin: string
  repos: Record<string, { selector: string; verified: boolean; measure: RepoMeasure | null }>
}
export const parseHosts = (
  value: Json | undefined,
  repos: AutoConfig['repos'],
): { ok: true; hosts: HostConfig[] | null } | { ok: false } => {
  if (value === undefined) return { ok: true, hosts: null }
  const rows = asArray(value)
  if (!rows?.length) return { ok: false }
  const hosts: HostConfig[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const h = asObject(row)
    const id = asString(h?.id)
    const name = asString(h?.name)
    const bin = asString(h?.orcaBin)
    const lanes = h?.lanes
    const raw = asObject(h?.repos)
    if (
      !id ||
      seen.has(id) ||
      !name ||
      !bin ||
      typeof lanes !== 'number' ||
      !Number.isInteger(lanes) ||
      lanes < 1 ||
      !raw
    )
      return { ok: false }
    const spec = h?.spec == null ? null : asObject(h.spec)
    if (
      h?.spec != null &&
      (!spec ||
        ['cpus', 'memoryTotalMb', 'memoryFreeMb', 'swapTotalMb', 'diskFreeMb'].some((key) => {
          const n = spec[key]
          return (
            typeof n !== 'number' || !Number.isInteger(n) || n < (key === 'cpus' || key === 'memoryTotalMb' ? 1 : 0)
          )
        }) ||
        !asString(spec.measuredAt) ||
        Number.isNaN(Date.parse(String(spec.measuredAt))))
    )
      return { ok: false }
    const hostRepos: HostConfig['repos'] = {}
    for (const [repo, v] of Object.entries(raw)) {
      const r = asObject(v)
      const selector = asString(r?.selector)
      const verified = r?.verified === undefined ? false : r.verified
      if (!Object.hasOwn(repos, repo) || !selector || typeof verified !== 'boolean') return { ok: false }
      const measure = r?.measure == null ? null : asObject(r.measure)
      if (
        r?.measure != null &&
        (!measure ||
          ['peakMemoryMb', 'diskGrowthMb'].some((key) => {
            const n = measure[key]
            return typeof n !== 'number' || !Number.isInteger(n) || n < (key === 'peakMemoryMb' ? 1 : 0)
          }) ||
          !asString(measure.measuredAt) ||
          Number.isNaN(Date.parse(String(measure.measuredAt))))
      )
        return { ok: false }
      hostRepos[repo] = { selector, verified, measure: measure as RepoMeasure | null }
    }
    seen.add(id)
    hosts.push({ id, name, lanes, orcaBin: bin, repos: hostRepos, spec: spec as HostSpec | null })
  }
  return { ok: true, hosts }
}
export const hostsOf = (config: AutoConfig): HostConfig[] =>
  config.hosts ?? [
    {
      spec: null,
      id: LOCAL_HOST,
      name: hostname(),
      lanes: config.lanes,
      orcaBin: orcaBin(),
      repos: Object.fromEntries(
        Object.entries(config.repos).map(([repo, r]) => [
          repo,
          { selector: `path:${r.checkout}`, verified: r.verified, measure: null },
        ]),
      ),
    },
  ]
// `orca diagnostics memory [--environment <id>] --json` の result.host.availableMemory（バイト）。端末を作らずに読める
export const hostAvailableMemoryMb = (json: Json | null): number | null => {
  const bytes = get(json, 'result', 'host', 'availableMemory')
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / 1024 / 1024) : null
}
export const envArgs = (host: string): string[] => (host === LOCAL_HOST ? [] : ['--environment', host])
export const hostKey = (host: string, path: string): string => `${host}\t${path}`
