import { type Config, saveConfig } from '../lib/config.ts'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Route = { status: number; body: string; type?: string }
export type RecordedRequest = { path: string; body: string }
export type TestServer = { url: string; requests: RecordedRequest[]; close(): Promise<void> }
export type CliResult = { code: number; stdout: string; stderr: string }

const BIN = join(import.meta.dirname, '..', 'bin', 'dev-digest.ts')
const FAKE_ORCA = join(import.meta.dirname, 'fixtures', 'fake-orca.ts')

// 偽の orca を dir に置き、ORCA_BIN と呼び出しの記録先を返す。ORCA_BIN は 1 つの実行ファイルしか取らないので
// `node <fake-orca.ts>` を sh の wrapper で包む
export const fakeOrca = (dir: string): { ORCA_BIN: string; FAKE_ORCA_LOG: string } => {
  const orca = join(dir, 'orca')
  writeFileSync(orca, `#!/bin/sh\nexec node "${FAKE_ORCA}" "$@"\n`, { mode: 0o755 })
  return { ORCA_BIN: orca, FAKE_ORCA_LOG: join(dir, 'orca.log') }
}

// 偽の orca が受け取った argv（1 回 1 配列）
export const orcaCalls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : []

export const tempHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'dev-digest-test-')))

// path（query を除く）で引く。無い path は 404
export const startServer = async (routes: Record<string, Route>): Promise<TestServer> => {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      requests.push({ path, body: Buffer.concat(chunks).toString('utf8') })
      const route = routes[path]
      if (route === undefined) {
        response.writeHead(404).end('not found')
        return
      }
      response.writeHead(route.status, { 'Content-Type': route.type ?? 'application/xml' }).end(route.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

export const runCli = (args: string[], env: Record<string, string>): CliResult => {
  const result = spawnSync('node', [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

// spawnSync は同じプロセスの HTTP サーバの応答も止めてしまうので、サーバに繋ぐ呼び出しはこちらを使う
export const runCliAsync = (args: string[], env: Record<string, string>): Promise<CliResult> =>
  new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

export const writeConfig = (home: string, overrides: Partial<Config> = {}): Config => {
  const config: Config = {
    version: 1,
    schedule: { trigger: 'daily', time: '08:00', timezone: 'Asia/Tokyo' },
    jvnMinSeverity: 'high',
    jvnKeywords: [],
    devtoTags: [],
    x: { listUrl: null, hashtags: ['#AI'] },
    orca: { workspaceSelector: null, automationId: null },
    pluginRoot: '/plugin',
    ...overrides,
  }
  saveConfig(home, config)
  return config
}
