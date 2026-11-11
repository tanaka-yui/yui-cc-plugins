import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
export const tempHome = (): string => mkdtempSync(join(tmpdir(), 'sii-test-'))
export type CliResult = { code: number; stdout: string; stderr: string; ms: number }
const cli = resolve(import.meta.dirname, '../bin/slack-issue-intake.ts')
export const runCli = (args: string[], env: Record<string, string>, input?: string): CliResult => {
  const start = Date.now()
  const c = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8' })
  return { code: c.status ?? -1, stdout: c.stdout, stderr: c.stderr, ms: Date.now() - start }
}
export const runCliAsync = (args: string[], env: Record<string, string>): Promise<CliResult> =>
  new Promise((done) => {
    const start = Date.now()
    const c = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    c.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    c.on('close', (code) => done({ code: code ?? -1, stdout, stderr, ms: Date.now() - start }))
  })
