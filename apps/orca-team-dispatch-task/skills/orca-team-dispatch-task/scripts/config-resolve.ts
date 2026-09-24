// global / project / コマンドラインの設定をロール単位で解決し JSON で出す（config-resolve.sh の移植）。
//
// Usage: node config-resolve.ts --project-root <path> [--review-mode <on|off>] [--phase-b <on|off>]
//                               [--integration <merge|pr>] [--setup <skip|run>]
//                               [--design-mode <direct|plan|brainstorm>]
//                               [--set <role>.<field>=<value>]...
// Exit:  0 = 解決した / 1 = 設定が読めない / 2 = 使用法エラー
//
// 優先順位は override > project > global > ロール既定（lib/config.ts の DEFAULT_TUPLES）。
// **設定ファイルが 1 つも無いのは正常**で、その場合は各ロールが既定 tuple で走る。
//
// ★ **model と effort の既定は、agent が既定 agent と一致するときだけ使う。**agent を別のものに
//   変えた設定では未設定のまま出さず、worker-start は Orca 側の既定を使う。
import { die, log } from '../../../lib/cli.ts'
import {
  configHome,
  DEFAULT_TUPLES,
  globalConfigFile,
  integrationRole,
  isRole,
  knownAgent,
  modelAgent,
  normalizeEffort,
  projectConfigFile,
  type Role,
  roleNames,
  TOGGLE_KEYS,
  TOGGLES,
  type Toggle,
  validAgent,
  validEffort,
  validModel,
  validToggle,
} from '../../../lib/config.ts'
import { asObject, get, type JsonObject, parseJson } from '../../../lib/json.ts'

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'

const NAME = 'config-resolve'
const warn = (message: string): void => {
  process.stderr.write(`[warn] ${NAME}: ${message}\n`)
}

type Source = 'override' | 'project' | 'global'
type Field = 'agent' | 'model' | 'effort'
type Candidate = { present: boolean; value: string }
const ABSENT: Candidate = { present: false, value: '' }

// ★ **壊れた設定を「無い」と読まない。**握り潰すと、利用者が書いたはずの model が黙って効かない
//   まま dispatch が走る。無ければ null、読めなければ exit 1
const readLayer = (file: string, label: string): JsonObject | null | 'unreadable' => {
  if (!existsSync(file)) return null
  try {
    accessSync(file, constants.R_OK)
  } catch {
    log(NAME, `${label} is not readable at ${file}`)
    return 'unreadable'
  }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // ディレクトリなど。下の「object ではない」に落とす
  }
  const layer = asObject(parseJson(text) ?? undefined)
  if (layer === null) {
    log(NAME, `${label} is not a JSON object at ${file}`)
    return 'unreadable'
  }
  return layer
}

// ★ **「ファイルが在る」と「設定されている」は別。**第三者キーだけを持つ config.json は未設定である
const hasOurs = (layer: JsonObject | null): boolean => {
  if (layer === null) return false
  const roles = asObject(layer.roles)
  if (roles !== null && Object.keys(roles).length > 0) return true
  return TOGGLE_KEYS.some((key) => typeof layer[key] === 'string')
}

const main = (argv: string[]): number => {
  let projectRoot = ''
  const toggleOverrides: { [key in Toggle]?: string } = {}
  const overrides = new Map<string, string>()
  const flagToToggle: { [flag: string]: Toggle } = {
    '--review-mode': 'review_mode',
    '--phase-b': 'phase_b',
    '--integration': 'integration',
    '--setup': 'setup',
    '--design-mode': 'design_mode',
  }
  const requirement: { [key in Toggle]: string } = {
    review_mode: 'on or off',
    phase_b: 'on or off',
    integration: 'merge or pr',
    setup: 'skip or run',
    design_mode: 'direct, plan or brainstorm',
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? ''
    const value = argv[index + 1]
    const toggle = flagToToggle[flag]
    if (flag === '--project-root') {
      if (value === undefined) return die(NAME, '--project-root requires a directory')
      projectRoot = value
    } else if (flag === '--set') {
      if (value === undefined) return die(NAME, '--set requires <role>.<field>=<value>')
      const at = value.indexOf('=')
      if (at < 0) return die(NAME, `invalid --set '${value}'`)
      const key = value.slice(0, at)
      const dot = key.indexOf('.')
      if (dot < 0) return die(NAME, `invalid --set '${value}'`)
      const role = key.slice(0, dot)
      const field = key.slice(dot + 1)
      if (!isRole(role)) return die(NAME, `unknown role in --set: ${role}`)
      if (field !== 'agent' && field !== 'model' && field !== 'effort') {
        return die(NAME, `unknown field in --set: ${field}`)
      }
      overrides.set(`${role}.${field}`, value.slice(at + 1))
    } else if (toggle !== undefined) {
      if (value === undefined) return die(NAME, `${flag} requires ${requirement[toggle]}`)
      if (!validToggle(toggle, value)) return die(NAME, `invalid ${flag}: ${value}`)
      toggleOverrides[toggle] = value
    } else {
      return die(NAME, `unknown argument '${flag}'`)
    }
  }
  if (projectRoot === '') return die(NAME, '--project-root is required')
  let isDirectory = false
  try {
    isDirectory = statSync(projectRoot).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) return die(NAME, `project root is not a directory: ${projectRoot}`)

  const globalFile = globalConfigFile()
  const projectFile = projectConfigFile(projectRoot)
  const globalLayer = readLayer(globalFile, 'global config.json')
  if (globalLayer === 'unreadable') return 1
  const projectLayer = readLayer(projectFile, 'project config.json')
  if (projectLayer === 'unreadable') return 1
  const layers: { source: Source; layer: JsonObject | null }[] = [
    { source: 'project', layer: projectLayer },
    { source: 'global', layer: globalLayer },
  ]

  // 型違いは「その層に無い」ではなく「その層が無効」である。警告して次の層へ落とす
  const candidate = (source: Source, layer: JsonObject | null, role: Role, field: Field): Candidate => {
    if (source === 'override') {
      const value = overrides.get(`${role}.${field}`)
      return value === undefined ? ABSENT : { present: true, value }
    }
    const record = asObject(get(layer ?? undefined, 'roles', role))
    if (record === null || !Object.hasOwn(record, field)) return ABSENT
    const value = record[field] ?? null
    if (typeof value !== 'string') {
      warn(`ignoring non-string ${field} for role '${role}' in ${source} config`)
      return ABSENT
    }
    return { present: true, value }
  }
  // 候補は override → project → global の順に 1 つずつ見る（警告の順も bash 版と同じ）
  const firstValid = (
    role: Role,
    field: Field,
    accept: (source: Source, value: string) => string | null,
  ): string | null => {
    for (const source of ['override', 'project', 'global'] as const) {
      const layer = source === 'override' ? null : source === 'project' ? projectLayer : globalLayer
      const next = candidate(source, layer, role, field)
      if (!next.present) continue
      const accepted = accept(source, next.value)
      if (accepted !== null) return accepted
    }
    return null
  }

  const resolveAgent = (role: Role): string =>
    firstValid(role, 'agent', (source, value) => {
      if (!validAgent(value)) {
        warn(`ignoring invalid agent for role '${role}' in ${source} config`)
        return null
      }
      if (!knownAgent(value)) {
        warn(`agent '${value}' for role '${role}' is not one this version knows; passing it to Orca as-is`)
      }
      return value
    }) ?? DEFAULT_TUPLES[role].agent

  const resolveModel = (role: Role, agent: string): string =>
    firstValid(role, 'model', (source, value) => {
      if (!validModel(value)) {
        warn(`ignoring invalid model for role '${role}' in ${source} config`)
        return null
      }
      // ★ agent と食い違う model は使わない。層をまたぐと codex + sonnet が成立しうる
      const owner = modelAgent(value)
      if (owner !== null && knownAgent(agent) && owner !== agent) {
        warn(`ignoring ${owner} model '${value}' for role '${role}' running agent '${agent}' in ${source} config`)
        return null
      }
      return value
    }) ?? (agent === DEFAULT_TUPLES[role].agent ? DEFAULT_TUPLES[role].model : '')

  const resolveEffort = (role: Role, agent: string): string =>
    firstValid(role, 'effort', (source, value) => {
      const normalized = normalizeEffort(value)
      if (knownAgent(agent)) {
        if (!validEffort(normalized, agent)) {
          warn(`ignoring invalid effort for role '${role}' in ${source} config`)
          return null
        }
        return normalized
      }
      // 未知の agent の許容値は分からない。shell-safe であることだけ確かめて素通しし、判定は Orca に委ねる
      if (!validModel(normalized)) {
        warn(`ignoring invalid effort for role '${role}' in ${source} config`)
        return null
      }
      warn(`cannot validate effort for unknown agent '${agent}'; Orca will validate it at worker-start`)
      return normalized
    }) ?? (agent === DEFAULT_TUPLES[role].agent ? DEFAULT_TUPLES[role].effort : '')

  // on/off などのトグル。override → project → global → 既定
  const resolveToggle = (key: Toggle): string => {
    const override = toggleOverrides[key]
    if (override !== undefined && override !== '') return override
    for (const { source, layer } of layers) {
      if (layer === null || !Object.hasOwn(layer, key)) continue
      const value = layer[key] ?? null
      if (typeof value !== 'string') {
        warn(`ignoring non-string ${key} in ${source} config`)
        continue
      }
      if (validToggle(key, value)) return value
      warn(`ignoring invalid ${key} '${value}' in ${source} config`)
    }
    return TOGGLES[key].fallback
  }

  const reviewMode = resolveToggle('review_mode')
  const phaseB = resolveToggle('phase_b')
  const integration = resolveToggle('integration')
  const setup = resolveToggle('setup')
  const designMode = resolveToggle('design_mode')

  const roles: JsonObject = {}
  for (const role of roleNames(reviewMode, phaseB)) {
    const agent = resolveAgent(role)
    const model = resolveModel(role, agent)
    let effort = resolveEffort(role, agent)
    // ★ Orca の制約: `--effort requires --model`。model 無しの effort は渡せないので落とし、黙らずに言う
    if (effort !== '' && model === '') {
      warn(`role '${role}' sets effort but no model; Orca requires --model with --effort, so effort is dropped`)
      effort = ''
    }
    const tuple: JsonObject = { agent }
    if (model !== '') tuple.model = model
    if (effort !== '') tuple.effort = effort
    roles[role] = tuple
  }

  const resolved: JsonObject = {
    config_home: configHome(),
    global_config: globalFile,
    project_config: projectFile,
    global_present: globalLayer !== null,
    project_present: projectLayer !== null,
    configured: hasOurs(globalLayer) || hasOurs(projectLayer),
    review_mode: reviewMode,
    phase_b: phaseB,
    integration_role: integrationRole(phaseB),
    integration,
    setup,
    design_mode: designMode,
    roles,
  }
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
