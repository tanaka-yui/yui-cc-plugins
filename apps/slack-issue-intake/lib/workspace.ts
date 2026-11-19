import { shellQuote } from './automation.ts'
import {
  AUTOMATION_NAME,
  CLI_COMMAND,
  INTAKE_HOME_DIRNAME,
  MSG_LEGACY_HOME,
  MSG_NAME_ASK,
  MSG_NAME_EXAMPLE,
  MSG_NAME_LIST,
  MSG_NAME_LIST_EMPTY,
  MSG_NAME_NONE,
  MSG_NO_AUTOMATION,
  MSG_NO_CONFIG,
  MSG_NO_TOKEN,
  NAME_PLACEHOLDER,
} from './defaults.ts'
import { homeForName, intakeNameProblem, nameOfHome } from './paths.ts'

import { existsSync } from 'node:fs'

import type { Prompter } from './prompt.ts'

export const legacyHomeNotice = (): string | null =>
  existsSync(homeForName(null))
    ? MSG_LEGACY_HOME.replace('{dir}', INTAKE_HOME_DIRNAME).replace('{automation}', AUTOMATION_NAME)
    : null

export const commandWithName = (script: string, args: readonly string[], name: string): string => {
  const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : shellQuote(value))
  return ['node', quote(script), '--name', name, ...args.map(quote)].join(' ')
}

export const nameRequiredMessage = (
  lead: string,
  example: (name: string) => string,
  names: readonly string[],
  legacy: string | null,
): string => {
  const lines = [lead]
  if (names.length > 0) {
    lines.push(
      MSG_NAME_LIST.replace('{names}', names.join(', ')),
      MSG_NAME_EXAMPLE.replace(
        '{command}',
        example(names.length === 1 ? (names[0] ?? NAME_PLACEHOLDER) : NAME_PLACEHOLDER),
      ),
    )
  } else lines.push(MSG_NAME_NONE)
  if (legacy !== null) lines.push(legacy)
  return lines.join('\n')
}

export const askWorkspaceName = (p: Prompter, names: readonly string[], say: (text: string) => void): string | null => {
  say(names.length > 0 ? MSG_NAME_LIST.replace('{names}', names.join(', ')) : MSG_NAME_LIST_EMPTY)
  for (;;) {
    const name = p.ask(MSG_NAME_ASK)
    if (name === null) return null
    if (!name) continue
    const problem = intakeNameProblem(name)
    if (problem !== null) {
      say(problem)
      continue
    }
    return name
  }
}

export const hintName = (home: string): string => nameOfHome(home) ?? NAME_PLACEHOLDER
export const makeCommand = (home: string, target: string): string => `make ${target} ${hintName(home)}`
export const cliCommand = (home: string, subcommand: string): string =>
  `${CLI_COMMAND} --name ${hintName(home)} ${subcommand}`
export const noConfigReason = (home: string): string =>
  MSG_NO_CONFIG.replace('{home}', home).replace('{setup}', makeCommand(home, 'setup'))
export const noTokenReason = (home: string): string =>
  MSG_NO_TOKEN.replace('{home}', home)
    .replace('{setup}', makeCommand(home, 'setup'))
    .replace('{setToken}', cliCommand(home, 'set-token'))
export const noAutomationReason = (home: string): string =>
  MSG_NO_AUTOMATION.replace('{home}', home).replace('{setup}', makeCommand(home, 'setup'))
