import { AUTO_FILES, autoDir } from './auto-paths.ts'
import { configHome } from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asObject } from './json.ts'
import { receiptArray, receiptOk, runOrca } from './orca.ts'

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AutoConfig } from './auto-config.ts'
import type { Json, JsonObject } from './json.ts'

export const PLUGIN_ID = 'orca-team-dispatch-task@yui-cc-plugins'
export const LAUNCHER_ENV = 'ORCA_AUTO_LAUNCHER_VERSION'
export const LAUNCHER_VERSION = 1
export const CLAUDE_HOME_ENV = 'ORCA_AUTO_CLAUDE_HOME'
export const CONFIG_HOME_ENV = 'ORCA_DISPATCH_CONFIG_HOME'
export const PLUGIN_ROOT_FILE = 'plugin-root.json'
export const ENTRY_FILE = 'bin/orca-auto.ts'
export const LAUNCHER_SOURCE = 'bin/orca-auto-launch.ts'
export const AUTO_PRECHECK_TIMEOUT_SECONDS = 300
export const ALLOWED_EVERY_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]
export const pluginRoot = (): string => dirname(import.meta.dirname)
export const claudeHome = (): string => process.env[CLAUDE_HOME_ENV] || join(homedir(), '.claude')
export const launcherPaths = (): { dir: string; launcher: string; script: string; pluginRootFile: string } => {
  const dir = join(configHome(), 'bin')
  return {
    dir,
    launcher: join(dir, 'orca-auto'),
    script: join(dir, 'launch.mts'),
    pluginRootFile: join(dir, PLUGIN_ROOT_FILE),
  }
}
export const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
export const installLauncher = (): boolean => {
  try {
    const paths = launcherPaths()
    mkdirSync(paths.dir, { recursive: true })
    copyFileSync(join(pluginRoot(), LAUNCHER_SOURCE), paths.script)
    if (!writeAtomic(paths.pluginRootFile, JSON.stringify({ pluginRoot: pluginRoot() }))) return false
    if (
      !writeAtomic(
        paths.launcher,
        `#!/bin/sh\nNODE=${shellQuote(process.execPath)}\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" ${shellQuote(paths.script)} "$@"\n`,
      )
    )
      return false
    chmodSync(paths.launcher, 0o755)
    return true
  } catch {
    return false
  }
}
const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
export const registerWorkspace = (name: string): boolean => {
  const present = () =>
    receiptArray(runOrca(['repo', 'list', '--json']), 'repos')?.some((row) => {
      const path = asObject(row)?.path
      return typeof path === 'string' && realPath(path) === realPath(autoDir(name))
    }) ?? false
  return (
    present() || receiptOk(runOrca(['repo', 'add', '--path', autoDir(name), '--kind', 'folder', '--json'])) || present()
  )
}
export const cronFor = (minutes: number): string => (minutes === 60 ? '0 * * * *' : `*/${minutes} * * * *`)
export const isAllowedEvery = (minutes: number): boolean =>
  Number.isInteger(minutes) && ALLOWED_EVERY_MINUTES.includes(minutes)
export const automationName = (name: string): string => `orca-auto-${name}`
export const precheckCommand = (launcher: string, name: string): string => `${shellQuote(launcher)} tick --name ${name}`
export const automationPrompt = (launcher: string, name: string): string =>
  `Run \`${launcher} judge-doc --name ${name}\` and follow the printed instructions exactly. If it reports nothing to judge, stop.`
const commonArgs = (config: AutoConfig, launcher: string, workspace: string): string[] => [
  '--trigger',
  cronFor(config.everyMinutes),
  '--provider',
  'claude',
  '--workspace',
  `path:${workspace}`,
  '--fresh-session',
  '--precheck',
  precheckCommand(launcher, config.name),
  '--precheck-timeout',
  String(AUTO_PRECHECK_TIMEOUT_SECONDS),
  `--extra-agent-args=--model ${config.judge.model} --effort ${config.judge.effort}`,
  '--prompt',
  automationPrompt(launcher, config.name),
  '--json',
]
export const createAutomationArgs = (config: AutoConfig, launcher: string, workspace: string): string[] => [
  'automations',
  'create',
  '--name',
  automationName(config.name),
  '--disabled',
  ...commonArgs(config, launcher, workspace),
]
export const editAutomationArgs = (id: string, config: AutoConfig, launcher: string, workspace: string): string[] => [
  'automations',
  'edit',
  id,
  ...commonArgs(config, launcher, workspace),
]
export const enableAutomationArgs = (id: string): string[] => ['automations', 'edit', id, '--enabled', '--json']
export type JudgeRules = {
  file: string
  allow: string[]
  deny: string[]
  defaultMode: 'dontAsk'
  disableBypassPermissionsMode: 'disable'
}
// slack-issue-intake の RUN_DENY_RULES の写し。
const RUN_DENY_RULES = [
  'WebFetch',
  'WebSearch',
  'Bash(gh *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(git *)',
  'Bash(orca *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(rsync *)',
  'Bash(nc *)',
]
const pathForms = (path: string): string[] => {
  const real = realPath(path)
  return real === path ? [path] : [path, real]
}
export const judgeRules = (config: AutoConfig, launcher: string): JudgeRules => {
  const dir = autoDir(config.name),
    file = join(dir, AUTO_FILES.decisions)
  return {
    file: join(dir, '.claude/settings.json'),
    allow: [
      `Bash(${launcher} judge-doc --name ${config.name})`,
      `Bash(${launcher} judge-list --name ${config.name})`,
      `Bash(${launcher} judge-apply --name ${config.name} --file ${file})`,
      ...pathForms(dir).map((path) => `Read(/${path}/**)`),
      ...Object.values(config.repos).flatMap((repo) => pathForms(repo.checkout).map((path) => `Read(/${path}/**)`)),
      ...pathForms(dir).flatMap((path) => [
        `Write(/${join(path, AUTO_FILES.decisions)})`,
        `Edit(/${join(path, AUTO_FILES.decisions)})`,
      ]),
    ],
    deny: [...RUN_DENY_RULES],
    defaultMode: 'dontAsk',
    disableBypassPermissionsMode: 'disable',
  }
}
const settings = (file: string, optional = false): JsonObject => {
  if (optional && !existsSync(file)) return {}
  const root = asObject(readJson(file))
  if (!root || (root.permissions !== undefined && !asObject(root.permissions)))
    throw new Error(`設定を読めません: ${file}`)
  return root
}
const permissions = (root: JsonObject): JsonObject => asObject(root.permissions) ?? {}
const managedFile = (): string =>
  process.env[CLAUDE_HOME_ENV]
    ? join(claudeHome(), 'managed-settings.json')
    : '/Library/Application Support/ClaudeCode/managed-settings.json'
export const applyJudgeRules = (rules: JudgeRules): boolean => {
  try {
    const root = settings(rules.file, true)
    const mode = existsSync(rules.file) ? statSync(rules.file).mode & 0o777 : 0o644
    root.permissions = {
      ...permissions(root),
      allow: rules.allow,
      deny: rules.deny,
      defaultMode: rules.defaultMode,
      disableBypassPermissionsMode: rules.disableBypassPermissionsMode,
    }
    mkdirSync(dirname(rules.file), { recursive: true })
    if (!writeAtomic(rules.file, `${JSON.stringify(root, null, 2)}\n`)) return false
    chmodSync(rules.file, mode)
    return true
  } catch {
    return false
  }
}
export const judgeRulesProblems = (config: AutoConfig, launcher: string): string[] => {
  const rules = judgeRules(config, launcher),
    problems: string[] = []
  try {
    const p = permissions(settings(rules.file))
    if (
      ['allow', 'deny', 'defaultMode', 'disableBypassPermissionsMode'].some(
        (key) =>
          JSON.stringify(p[key]) !==
          JSON.stringify(rules[key as 'allow' | 'deny' | 'defaultMode' | 'disableBypassPermissionsMode']),
      )
    )
      problems.push('判定の許可・拒否・モードが必要な設定と一致しません')
  } catch {
    problems.push('判定の設定を読めません')
  }
  if (existsSync(join(autoDir(config.name), '.claude/settings.local.json')))
    problems.push('settings.local.json があるため無人実行できません。内容を確認して取り除いてください')
  try {
    const mode = permissions(settings(managedFile(), true)).defaultMode
    if (mode !== undefined && mode !== 'dontAsk') problems.push('managed の defaultMode が dontAsk ではありません')
  } catch {
    problems.push('managed の設定を読めません')
  }
  return problems
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
export const judgeFingerprint = (config: AutoConfig): string | null => {
  try {
    const project = settings(judgeRules(config, launcherPaths().launcher).file)
    const user = permissions(settings(join(claudeHome(), 'settings.json'), true))
    const managed = existsSync(managedFile()) ? permissions(settings(managedFile())) : null
    return createHash('sha256')
      .update(JSON.stringify(canonical({ project, user, managed })))
      .digest('hex')
  } catch {
    return null
  }
}
