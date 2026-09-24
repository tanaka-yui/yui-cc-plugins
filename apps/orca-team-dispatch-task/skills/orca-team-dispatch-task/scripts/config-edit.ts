// config.json を原子的に読み書きする（旧版の設定編集から移植）。**手で JSON を組み立ててはならない。**
//
// Usage: node config-edit.ts (--config <path> | --layer <global|project> [--project-root <dir>])
//                            [--set <key>=<value>]... [--unset <key>]...
//        node config-edit.ts (--config <path> | --layer ...) --get <key>
//        node config-edit.ts (--config <path> | --layer ...) --show
//
// --layer は層のファイルを lib/config.ts から決める（global = 設定ホームの config.json、project = <root>/.dispatch/config.json）。
// project の --project-root の既定は git rev-parse --show-toplevel。SKILL.md の S1 / S4 / R は層の path を block で運ばない
//
// 扱えるキー:
//   review_mode / phase_b / integration / setup / design_mode   set / unset
//   roles.<role>.agent | .model | .effort                          set / unset
//   roles.<role> / roles                                           unset 専用
//
// 複数の変更は 1 回の置き換え（同じディレクトリの一時ファイル + rename）で反映する。
// **未知の第三者キーは保持する。**
//
// ★ cmux 版にあった `--runners` / `--engine` は無い。engine は agent そのものなので、effort の検証に
//   要る agent は「同一バッチの agent → 既存 config の agent → 既定」の順で必ず決まる

import {
  DEFAULT_TUPLES,
  globalConfigFile,
  isRole,
  isToggle,
  knownAgent,
  normalizeEffort,
  projectConfigFile,
  type Role,
  type Toggle,
  validAgent,
  validEffort,
  validModel,
  validToggle,
} from '../../../lib/config.ts'
import { writeAtomic } from '../../../lib/fs.ts'
import { asObject, asString, get, type Json, type JsonObject, parseJson } from '../../../lib/json.ts'
import { run } from '../../../lib/sys.ts'

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const NAME = 'config-edit'
const USAGE = [
  'Usage: config-edit.ts (--config <path> | --layer <global|project> [--project-root <dir>]) [--set <key>=<value>]... [--unset <key>]...',
  '       config-edit.ts (--config <path> | --layer ...) --get <key>',
  '       config-edit.ts (--config <path> | --layer ...) --show',
]

// 使用法の誤りは理由と Usage を出して exit 2（旧版の die_usage と同じ）
const dieUsage = (message: string): never => {
  process.stderr.write(`${NAME}: ${message}\n${USAGE.join('\n')}\n`)
  process.exit(2)
}
const fail = (message: string): number => {
  process.stderr.write(`${NAME}: ${message}\n`)
  return 1
}

type Op = { op: 'set' | 'unset'; key: string; value: string }

type Key =
  | { kind: 'toggle'; toggle: Toggle }
  | { kind: 'field'; role: Role; field: 'agent' | 'model' | 'effort' }
  | { kind: 'role'; role: Role }
  | { kind: 'roles' }

// `roles.<role>.<field>` / `roles.<role>` / `roles` / トグル名。それ以外は null（未知のキー）
const parseKey = (key: string): Key | null => {
  if (isToggle(key)) return { kind: 'toggle', toggle: key }
  if (key === 'roles') return { kind: 'roles' }
  if (!key.startsWith('roles.')) return null
  const parts = key.slice('roles.'.length).split('.')
  const role = parts[0] ?? ''
  if (!isRole(role)) return null
  if (parts.length === 1) return { kind: 'role', role }
  const field = parts[1]
  if (parts.length !== 2 || (field !== 'agent' && field !== 'model' && field !== 'effort')) return null
  return { kind: 'field', role, field }
}

const pathOf = (key: Key): string[] => {
  if (key.kind === 'toggle') return [key.toggle]
  if (key.kind === 'roles') return ['roles']
  if (key.kind === 'role') return ['roles', key.role]
  return ['roles', key.role, key.field]
}

// jq の `.a.b // empty`。途中が null なら「無い」。object でも null でもない値を辿ろうとしたら jq と同じく
// 失敗（ok: false）
type Found = { ok: true; value: Json | undefined } | { ok: false }
const lookup = (root: Json, path: string[]): Found => {
  let current: Json | undefined = root
  for (const segment of path) {
    if (current === undefined || current === null) return { ok: true, value: undefined }
    const object = asObject(current)
    if (object === null) return { ok: false }
    current = object[segment]
  }
  return { ok: true, value: current }
}

// jq の `.a.b = $v` と `del(.a.b)`。途中が無ければ set は object を作り、unset は何もしない。
// 途中に object でも null でもない値があれば jq と同じく失敗（false）
const apply = (root: JsonObject, op: Op['op'], path: string[], value: string): boolean => {
  let current = root
  for (const segment of path.slice(0, -1)) {
    const next = current[segment]
    if (next === undefined || next === null) {
      if (op === 'unset') return true
      const created: JsonObject = {}
      current[segment] = created
      current = created
      continue
    }
    const object = asObject(next)
    if (object === null) return false
    current = object
  }
  const last = path[path.length - 1] ?? ''
  if (op === 'set') current[last] = value
  else Reflect.deleteProperty(current, last)
  return true
}

const readConfig = (file: string): Json | null => {
  try {
    return parseJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const main = (argv: string[]): number => {
  let config = ''
  let layer = ''
  let projectRoot = ''
  let getKey = ''
  let show = false
  const ops: Op[] = []
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index] ?? ''
    const value = argv[index + 1]
    if (flag === '--show') {
      show = true
      index += 1
      continue
    }
    if (flag === '--config') {
      if (value === undefined) return dieUsage('--config requires a value')
      config = value
    } else if (flag === '--layer') {
      if (value === undefined) return dieUsage('--layer requires global or project')
      layer = value
    } else if (flag === '--project-root') {
      if (value === undefined) return dieUsage('--project-root requires a directory')
      projectRoot = value
    } else if (flag === '--set') {
      if (value === undefined) return dieUsage('--set requires <key>=<value>')
      const at = value.indexOf('=')
      if (at < 0) return dieUsage(`--set must be <key>=<value>: ${value}`)
      ops.push({ op: 'set', key: value.slice(0, at), value: value.slice(at + 1) })
    } else if (flag === '--unset') {
      if (value === undefined) return dieUsage('--unset requires a key')
      ops.push({ op: 'unset', key: value, value: '' })
    } else if (flag === '--get') {
      if (value === undefined) return dieUsage('--get requires a key')
      if (getKey !== '') return dieUsage('--get may be specified once')
      getKey = value
    } else {
      return dieUsage(`unknown argument: ${flag}`)
    }
    index += 2
  }
  if (config !== '' && layer !== '') return dieUsage('specify --config or --layer, not both')
  if (projectRoot !== '' && layer !== 'project') return dieUsage('--project-root goes with --layer project')
  if (layer === 'global') config = globalConfigFile()
  else if (layer === 'project') {
    if (projectRoot === '') {
      const found = run('git', ['rev-parse', '--show-toplevel'])
      if (found.rc !== 0) return dieUsage('not in a git repo')
      projectRoot = found.stdout.trim()
    }
    config = projectConfigFile(projectRoot)
  } else if (layer !== '') return dieUsage(`--layer must be global or project: ${layer}`)
  if (config === '') return dieUsage('--config or --layer is required')
  const modes = (ops.length > 0 ? 1 : 0) + (show ? 1 : 0) + (getKey !== '' ? 1 : 0)
  if (modes !== 1) return dieUsage('specify exactly one of --set/--unset, --get, or --show')
  const unreadable = `cannot read ${config} (invalid JSON?)`

  if (getKey !== '') {
    const key = parseKey(getKey)
    if (key === null) return dieUsage(`unknown key: ${getKey}`)
    if (key.kind === 'role' || key.kind === 'roles') return dieUsage(`key is unset-only: ${getKey}`)
    if (!existsSync(config)) return 0
    const json = readConfig(config)
    if (json === null) return fail(unreadable)
    const lookedUp = lookup(json, pathOf(key))
    if (!lookedUp.ok) return fail(unreadable)
    const found = lookedUp.value
    // jq -r の `// empty`: null と false は何も出さない。文字列は生のまま、それ以外は JSON
    if (found === undefined || found === null || found === false) return 0
    const text = asString(found) ?? JSON.stringify(found, null, 2)
    process.stdout.write(`${text}\n`)
    return 0
  }

  if (show) {
    if (!existsSync(config)) {
      process.stdout.write('{}\n')
      return 0
    }
    const json = readConfig(config)
    if (json === null) return fail(unreadable)
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
    return 0
  }

  const existing = existsSync(config) ? asObject(readConfig(config) ?? undefined) : {}
  if (existing === null) return fail(unreadable)

  // 第 1 巡: キーと値を検証し、同一バッチの agent を覚える
  const batchAgents = new Map<Role, string>()
  const keys: Key[] = []
  for (const { op, key, value } of ops) {
    const parsed = parseKey(key)
    if (parsed === null) return dieUsage(`unknown key: ${key}`)
    keys.push(parsed)
    if (op !== 'set') continue
    if (parsed.kind === 'role' || parsed.kind === 'roles') return dieUsage(`key is unset-only: ${key}`)
    if (parsed.kind === 'toggle') {
      if (!validToggle(parsed.toggle, value)) return dieUsage(`invalid value for ${key}: ${value}`)
      continue
    }
    if (parsed.field === 'agent') {
      if (!validAgent(value)) return dieUsage(`invalid value for ${key}: ${value}`)
      batchAgents.set(parsed.role, value)
    }
    if (parsed.field === 'model' && !validModel(value)) return dieUsage(`invalid value for ${key}: ${value}`)
  }

  // 第 2 巡: effort は agent が決まってからでないと検証できないので、別巡で正規化する
  const values = ops.map(({ value }) => value)
  for (const [index, { op, key, value }] of ops.entries()) {
    const parsed = keys[index]
    if (op !== 'set' || parsed === undefined || parsed.kind !== 'field' || parsed.field !== 'effort') continue
    const agent =
      batchAgents.get(parsed.role) ||
      asString(get(existing, 'roles', parsed.role, 'agent')) ||
      DEFAULT_TUPLES[parsed.role].agent
    const effort = normalizeEffort(value)
    if (knownAgent(agent)) {
      if (!validEffort(effort, agent)) return dieUsage(`invalid value for ${key}: ${value}`)
    } else {
      // 未知の agent の許容値は分からない。shell-safe だけ確かめ、判定は Orca に委ねる
      if (!validModel(effort)) return dieUsage(`invalid value for ${key}: ${value}`)
      process.stderr.write(`${NAME}: cannot validate effort for unknown agent '${agent}'; storing it as-is\n`)
    }
    values[index] = effort
  }

  // 反映は 1 回。途中で既存の形が壊れていれば（object であるべき所に別の値）、何も書かない
  const updated: JsonObject = structuredClone(existing)
  for (const [index, { op }] of ops.entries()) {
    const parsed = keys[index]
    if (parsed === undefined) continue
    if (!apply(updated, op, pathOf(parsed), values[index] ?? '')) {
      return fail(`write failed (existing config broken?); ${config} is unchanged`)
    }
  }
  try {
    mkdirSync(dirname(config), { recursive: true })
  } catch {
    return fail('mktemp failed; nothing was written')
  }
  if (!writeAtomic(config, `${JSON.stringify(updated, null, 2)}\n`)) return fail('mktemp failed; nothing was written')
  return 0
}

process.exitCode = main(process.argv.slice(2))
