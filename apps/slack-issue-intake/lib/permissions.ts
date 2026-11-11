import {
  APPLY_SUBCOMMAND,
  BYPASS_DISABLE_VALUE,
  CLAUDE_HOME_ENV,
  CLAUDE_SETTINGS_FILE,
  MANAGED_SETTINGS_BASENAME,
  MANAGED_SETTINGS_FILE,
  PROJECT_PERMISSION_MODE,
  RUN_DENY_RULES,
  RUN_EXACT_SUBCOMMANDS,
  SETTINGS_FILE_MODE,
} from './defaults.ts'
import { writeJson } from './fs.ts'
import { asArray, asObject, parseJson } from './json.ts'
import { claudeHome, homePaths } from './paths.ts'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Json, JsonObject } from './json.ts'
export type ProposedRules = {
  project: { file: string; allow: string[]; deny: string[]; defaultMode: string; disableBypassPermissionsMode: string }
  user: { file: string; deny: string[] }
}
export const proposedRules = (home: string): ProposedRules => {
  const paths = homePaths(home)
  return {
    project: {
      file: paths.projectSettings,
      allow: [
        ...RUN_EXACT_SUBCOMMANDS.map((command) => `Bash(${paths.launcher} ${command})`),
        `Bash(${paths.launcher} ${APPLY_SUBCOMMAND} *)`,
        `Read(/${paths.runDir}/**)`,
        `Write(/${paths.runsDir}/*/decisions.json)`,
        `Edit(/${paths.runsDir}/*/decisions.json)`,
      ],
      deny: [...RUN_DENY_RULES],
      defaultMode: PROJECT_PERMISSION_MODE,
      disableBypassPermissionsMode: BYPASS_DISABLE_VALUE,
    },
    user: {
      file: join(claudeHome(), CLAUDE_SETTINGS_FILE),
      deny: [`Read(/${paths.secrets})`, `Edit(/${paths.secrets})`],
    },
  }
}
const settings = (file: string, allowMissing = false): JsonObject => {
  if (allowMissing && !existsSync(file)) return {}
  const root = asObject(parseJson(readFileSync(file, 'utf8')))
  if (!root) throw new Error(`設定をJSONオブジェクトとして読めません: ${file}`)
  if (root.permissions !== undefined && !asObject(root.permissions))
    throw new Error(`permissions がオブジェクトではありません: ${file}`)
  return root
}
const permissions = (root: JsonObject): JsonObject => asObject(root.permissions) ?? {}
const strings = (value: Json | undefined): string[] => {
  if (value === undefined) return []
  const array = asArray(value)
  if (!array || array.some((v) => typeof v !== 'string')) throw new Error('許可ルールは文字列の配列にしてください')
  return array as string[]
}
const writeSettings = (file: string, root: JsonObject): void =>
  writeJson(file, root, existsSync(file) ? statSync(file).mode & 0o777 : SETTINGS_FILE_MODE)
export const applyProject = (rules: ProposedRules): void => {
  const { file, allow, deny, defaultMode, disableBypassPermissionsMode } = rules.project
  const root = settings(file, true)
  root.permissions = { ...permissions(root), allow, deny, defaultMode, disableBypassPermissionsMode }
  writeSettings(file, root)
}
export const applyUserDeny = (rules: ProposedRules): number => {
  const root = settings(rules.user.file, true)
  const p = permissions(root)
  const deny = strings(p.deny)
  const missing = rules.user.deny.filter((r) => !deny.includes(r))
  root.permissions = { ...p, deny: [...deny, ...missing] }
  writeSettings(rules.user.file, root)
  return missing.length
}
export const managedSettingsFile = (): string =>
  process.env[CLAUDE_HOME_ENV] ? join(claudeHome(), MANAGED_SETTINGS_BASENAME) : MANAGED_SETTINGS_FILE
const managed = (): JsonObject | null => (existsSync(managedSettingsFile()) ? settings(managedSettingsFile()) : null)
export const safetyProblems = (home: string): string[] => {
  const rules = proposedRules(home)
  const problems: string[] = []
  try {
    const p = permissions(settings(rules.project.file))
    if (
      JSON.stringify(p.allow) !== JSON.stringify(rules.project.allow) ||
      JSON.stringify(p.deny) !== JSON.stringify(rules.project.deny) ||
      p.defaultMode !== rules.project.defaultMode ||
      p.disableBypassPermissionsMode !== rules.project.disableBypassPermissionsMode
    )
      problems.push('project の許可・拒否・モードが必要な設定と一致しません。permissions --apply を確認してください')
  } catch {
    problems.push('project の設定を読めません。permissions --apply を確認してください')
  }
  if (existsSync(homePaths(home).projectLocalSettings))
    problems.push('settings.local.json があるため無人実行できません。内容を確認して取り除いてください')
  try {
    const m = managed()
    const mode = m ? permissions(m).defaultMode : undefined
    if (mode !== undefined && mode !== PROJECT_PERMISSION_MODE)
      problems.push('managed の defaultMode が dontAsk ではありません')
  } catch {
    problems.push('managed の設定を読めません')
  }
  try {
    const deny = strings(permissions(settings(rules.user.file)).deny)
    if (!rules.user.deny.every((r) => deny.includes(r)))
      problems.push('user の設定に secrets.json の読み取り・編集の拒否が揃っていません')
  } catch {
    problems.push('user の設定を読めません')
  }
  return problems
}
export type Inherited = { allow: string[]; dirs: string[] }
export const inheritedGrants = (): Inherited | null => {
  try {
    const user = settings(join(claudeHome(), CLAUDE_SETTINGS_FILE))
    const m = managed()
    const scopes = [permissions(user), ...(m ? [permissions(m)] : [])]
    return {
      allow: scopes.flatMap((p) => strings(p.allow)),
      dirs: scopes.flatMap((p) => strings(p.additionalDirectories)),
    }
  } catch {
    return null
  }
}
const canonical = (value: Json): Json =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key] ?? null)]),
        )
      : value
export const permissionFingerprint = (home: string): string | null => {
  try {
    const project = settings(homePaths(home).projectSettings)
    const user = permissions(settings(join(claudeHome(), CLAUDE_SETTINGS_FILE)))
    const m = managed()
    return createHash('sha256')
      .update(JSON.stringify(canonical({ project, user, managed: m ? permissions(m) : null })))
      .digest('hex')
  } catch {
    return null
  }
}
export const permissionStatus = (
  home: string,
  accepted: string | null,
): 'accepted' | 'changed' | 'unsafe' | 'not-accepted' =>
  safetyProblems(home).length
    ? 'unsafe'
    : !accepted
      ? 'not-accepted'
      : permissionFingerprint(home) === accepted
        ? 'accepted'
        : 'changed'
