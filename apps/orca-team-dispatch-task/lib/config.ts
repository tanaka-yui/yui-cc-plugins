// 設定のパスと値の検証を 1 箇所に集める（旧版の設定共通部品から移植）。
//
// ★ cmux 版との最大の差: **runner という次元が無い。**Orca には「同じ engine で別アカウント」を作る口が
//   無い（`worker-start` に account の指定口が無く、`account` は add / list だけ）ので、
//   **`--agent <id>` がそのまま runner 兼 engine** になる。レジストリ (`runners.json`) は移植しない。
//
// import する側: config-resolve.ts / config-edit.ts
import { homedir } from 'node:os'

// ★ **「この版が知っているロール」と「今そのタスクで動くロール」は別。**前者は設定できる集合であり、
//   後者は review_mode が決める。混ぜると review_mode=off の間は design_review を設定できない
export const ALL_ROLES = ['design', 'design_review', 'exec', 'exec_review'] as const
export type Role = (typeof ALL_ROLES)[number]
export const isRole = (value: string): value is Role => ALL_ROLES.some((role) => role === value)

export const configHome = (): string =>
  process.env.ORCA_DISPATCH_CONFIG_HOME || `${homedir()}/.claude/config/orca-team-dispatch-task`
export const globalConfigFile = (): string => `${configHome()}/config.json`
export const projectConfigFile = (projectRoot: string): string => `${projectRoot}/.dispatch/config.json`

// dispatch が実際に起動するロールの集合（起動順は呼び出し側が持つ）。
// ★ `exec_review` は review_mode と phase_b が **両方 on のときだけ**。phase_b が off ならレビューする実装役が居ない
export const roleNames = (reviewMode: string, phaseB: string): Role[] => {
  const roles: Role[] = ['design']
  if (reviewMode === 'on') roles.push('design_review')
  if (phaseB === 'on') roles.push('exec')
  if (reviewMode === 'on' && phaseB === 'on') roles.push('exec_review')
  return roles
}

// ★ **成果がどのブランチに載るかを設定から決める。**merge も PR もこの 1 箇所を読む
export const integrationRole = (phaseB: string): Role => (phaseB === 'on' ? 'exec' : 'design')

// トグルの値と既定。既定はどれも「その設定が生まれる前の dispatch と同じ」
//   review_mode … off（頼まれていないロールを勝手に起こさない）
//   integration … merge（pr は push して pull request を作る。**どちらか一方である**）
//   setup       … skip（run は repo の setup hook を走らせ、**失敗したら worker を起こさない**）
//   design_mode … direct（plan は先に手順を記録、brainstorm は superpowers の brainstorming を先に通す。
//                 **brainstorm は人が答える前提**なので、無人の `--issue` は呼び出し側が plan へ落とす）
//   ask_via     … terminal（brainstorm の design は自分の端末で尋ね、ターンを終えて答えを待つ。parent は
//                 `orchestration ask` で親に取り次がせる。**既定だけ例外** — 設定より前のコードは parent だったが、
//                 文書が意図していた terminal を既定にする）
export const TOGGLES = {
  review_mode: { values: ['on', 'off'], fallback: 'off' },
  phase_b: { values: ['on', 'off'], fallback: 'off' },
  integration: { values: ['merge', 'pr'], fallback: 'merge' },
  setup: { values: ['skip', 'run'], fallback: 'skip' },
  design_mode: { values: ['direct', 'plan', 'brainstorm'], fallback: 'direct' },
  ask_via: { values: ['terminal', 'parent'], fallback: 'terminal' },
} as const
export type Toggle = keyof typeof TOGGLES
export const TOGGLE_KEYS: Toggle[] = ['review_mode', 'phase_b', 'integration', 'setup', 'design_mode', 'ask_via']
export const isToggle = (key: string): key is Toggle => TOGGLE_KEYS.some((toggle) => toggle === key)
export const validToggle = (key: Toggle, value: string): boolean =>
  TOGGLES[key].values.some((allowed) => allowed === value)

const SPACES = ' \t\n\v\f\r'
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

// 空・前後の空白・シェルメタ文字（' " ` $ \ !）・制御文字を拒否する。内部の空白は許容する。
// 前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ので、トリムせず弾く
export const validShellValue = (value: string): boolean => {
  if (value === '') return false
  if (SPACES.includes(value.charAt(0)) || SPACES.includes(value.charAt(value.length - 1))) return false
  if (/['"`$\\!]/.test(value)) return false
  return ![...value].some(isControl)
}
export const validAgent = validShellValue
export const validModel = validShellValue

// ★ **agent の allowlist は閉じない。**知っているかどうかは既定値を埋められるかの判定にだけ使い、拒否には使わない
export const knownAgent = (agent: string): boolean => agent === 'claude' || agent === 'codex'

export const normalizeEffort = (effort: string): string => effort.toLowerCase()

// ★ 知らない agent の effort は **検証できないので検証しない**（呼び出し側が knownAgent で分岐する）
export const validEffort = (effort: string, agent: string): boolean => {
  if (agent === 'claude') return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
  if (agent === 'codex') return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)
  return false
}

// ★ `opus[1m]` の alias は provider によって Opus 5.5 より古い版を指すので、フルネームで固定する
export const OPUS_MODEL = 'claude-opus-5-5[1m]'

// ★ **ロールごとの既定 tuple。**model と effort は **解決した agent が既定 agent と一致するときだけ**使う
export type Tuple = { agent: string; model: string; effort: string }
export const DEFAULT_TUPLES: { [role in Role]: Tuple } = {
  design: { agent: 'claude', model: OPUS_MODEL, effort: 'max' },
  design_review: { agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
  exec: { agent: 'codex', model: 'gpt-6-sol', effort: 'high' },
  exec_review: { agent: 'claude', model: OPUS_MODEL, effort: 'max' },
}

// ★ **層をまたいだ agent と model の食い違いを塞ぐ。**綴りから所属 agent が分かるものだけを答え、
//   分からない綴りには null（allowlist ではないので、知らない model 名は通す）
export const modelAgent = (model: string): string | null => {
  if (['opus', 'opus[1m]', 'sonnet', 'haiku', 'fable'].includes(model) || model.startsWith('claude-')) return 'claude'
  if (['gpt-', 'codex-', 'o1', 'o3', 'o4'].some((prefix) => model.startsWith(prefix))) return 'codex'
  return null
}

// setup が尋ねるときの候補。**どれも allowlist ではない**（旧版の設定共通部品にあったものを写した。
// 2026-09-24 の時点で呼び出し元は無い）
export const AGENT_CHOICES = ['claude', 'codex']
export const MODEL_CHOICES: { [agent: string]: string[] } = {
  codex: ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'],
  claude: [OPUS_MODEL, 'sonnet'],
}
export const EFFORT_CHOICES: { [agent: string]: string[] } = {
  claude: ['xhigh', 'high', 'medium', 'low', 'max'],
  codex: ['xhigh', 'high', 'medium', 'low', 'minimal'],
}
