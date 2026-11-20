// Issue ごとの向き先ブランチを、ラベルと設定の候補から解く（純粋な部品）。
export const BASE_LABEL_PREFIX = 'base:'

// `AutoConfig['repos'][repo]` に足す 2 欄と同じ形。branches が空なら候補 1 つ（既定）。
export type RepoBranches = { baseBranch: string | null; branches: string[] }

// null は「GitHub の既定ブランチ」。
export type BaseResolution =
  | { kind: 'ok'; bases: Record<string, string | null> }
  | { kind: 'judge' }
  | { kind: 'ask'; why: string }

type Repos = Record<string, RepoBranches>

export const baseLabels = (labels: string[]): string[] =>
  labels
    .filter((label) => label.toLowerCase().startsWith(BASE_LABEL_PREFIX))
    .map((label) => label.slice(BASE_LABEL_PREFIX.length).trim())

// 対象の候補。branches が空なら baseBranch だけ（未設定なら空＝GitHub の既定ブランチ 1 つ）。
const candidates = (repo: string, repos: Repos): string[] => {
  const r = repos[repo]
  return r?.branches.length ? r.branches : r?.baseBranch ? [r.baseBranch] : []
}

export const candidatesOf = (targets: string[], repos: Repos): string[] => [
  ...new Set(targets.flatMap((target) => candidates(target, repos))),
]

export const needsChoice = (targets: string[], repos: Repos): boolean =>
  targets.some((target) => candidates(target, repos).length >= 2)

export const applyFlow = (flow: string, targets: string[], repos: Repos): Record<string, string | null> | null =>
  targets.some((target) => candidates(target, repos).includes(flow))
    ? Object.fromEntries(
        targets.map((target) => [
          target,
          candidates(target, repos).includes(flow) ? flow : (repos[target]?.baseBranch ?? null),
        ]),
      )
    : null

export const resolveBases = (labels: string[], targets: string[], repos: Repos): BaseResolution => {
  const names = baseLabels(labels)
  if (names.length >= 2) return { kind: 'ask', why: `base ラベルが複数あります: ${names.join(', ')}` }
  const [flow] = names
  if (flow === undefined)
    return needsChoice(targets, repos)
      ? { kind: 'judge' }
      : { kind: 'ok', bases: Object.fromEntries(targets.map((t) => [t, repos[t]?.baseBranch ?? null])) }
  const bases = applyFlow(flow, targets, repos)
  return bases ? { kind: 'ok', bases } : { kind: 'ask', why: `base:${flow} はどの対象の候補にもありません` }
}

export const restrictedBase = (repo: string, base: string, repos: Repos): boolean => {
  const configured = repos[repo]?.baseBranch
  return Boolean(configured) && configured !== base
}
