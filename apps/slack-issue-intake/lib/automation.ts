import {
  ALLOWED_EVERY_MINUTES,
  AUTOMATION_NAME,
  AUTOMATION_PROMPT,
  AUTOMATION_PROVIDER,
  PRECHECK_TIMEOUT_SECONDS,
} from './defaults.ts'

import type { Config } from './config.ts'
import type { HomePaths } from './paths.ts'
export const cronFor = (everyMinutes: number): string =>
  everyMinutes === 60 ? '0 * * * *' : `*/${everyMinutes} * * * *`
export const isAllowedEvery = (n: number): boolean => Number.isInteger(n) && ALLOWED_EVERY_MINUTES.includes(n)
export const shellQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`
export const precheckCommand = (launcher: string): string => `${shellQuote(launcher)} poll`
export const automationPrompt = (launcher: string, home: string): string =>
  AUTOMATION_PROMPT.replaceAll('{{LAUNCHER}}', launcher).replaceAll('{{HOME}}', home)
export const repoAddArgs = (runDir: string): string[] => ['repo', 'add', '--path', runDir, '--kind', 'folder']
const common = (config: Config, paths: HomePaths, home: string): string[] => [
  '--trigger',
  cronFor(config.everyMinutes),
  '--workspace',
  `path:${paths.runDir}`,
  '--precheck',
  precheckCommand(paths.launcher),
  '--precheck-timeout',
  String(PRECHECK_TIMEOUT_SECONDS),
  '--prompt',
  automationPrompt(paths.launcher, home),
]
export const createArgs = (config: Config, paths: HomePaths, home: string): string[] => [
  'automations',
  'create',
  '--name',
  AUTOMATION_NAME,
  '--trigger',
  cronFor(config.everyMinutes),
  '--provider',
  AUTOMATION_PROVIDER,
  '--workspace',
  `path:${paths.runDir}`,
  '--fresh-session',
  '--disabled',
  '--precheck',
  precheckCommand(paths.launcher),
  '--precheck-timeout',
  String(PRECHECK_TIMEOUT_SECONDS),
  '--prompt',
  automationPrompt(paths.launcher, home),
]
export const editArgs = (id: string, config: Config, paths: HomePaths, home: string): string[] => [
  'automations',
  'edit',
  id,
  ...common(config, paths, home),
]
export const enableArgs = (id: string): string[] => ['automations', 'edit', id, '--enabled']
