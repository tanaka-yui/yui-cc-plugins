import { shellQuote } from '../../lib/setup-automation.ts'

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const writeClaudeStub = (
  dir: string,
  stdout: string,
  options: { rc?: number; sleepSeconds?: number } = {},
): string => {
  const file = join(dir, 'claude-stub.sh')
  const lines = [
    '#!/bin/sh',
    `pwd -P > ${shellQuote(join(dir, 'claude-stub.pwd'))}`,
    `printf '%s\\037' "$@" > ${shellQuote(join(dir, 'claude-stub.argv'))}`,
    ...(options.sleepSeconds ? [`sleep ${options.sleepSeconds}`] : []),
    `printf '%s' ${shellQuote(stdout)}`,
    `exit ${options.rc ?? 0}`,
    '',
  ]
  writeFileSync(file, lines.join('\n'), { mode: 0o755 })
  return file
}
export const readClaudeStubArgs = (dir: string): string[] =>
  readFileSync(join(dir, 'claude-stub.argv'), 'utf8').split('\x1f').slice(0, -1)
export const readClaudeStubPwd = (dir: string): string => readFileSync(join(dir, 'claude-stub.pwd'), 'utf8').trim()
