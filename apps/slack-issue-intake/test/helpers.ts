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

export type SlackRequest = { method: string; path: string; params: Record<string, string>; auth: string | null }
export type SlackReply = {
  status?: number
  headers?: Record<string, string>
  json?: import('../lib/json.ts').Json
  bytes?: Uint8Array
  delayMs?: number
}
export type FakeSlack = { url: string; requests: SlackRequest[]; close: () => Promise<void> }
export const startSlack = async (handler: (req: SlackRequest) => SlackReply): Promise<FakeSlack> => {
  const { createServer } = await import('node:http')
  const requests: SlackRequest[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const b of req) body += String(b)
    const path = (req.url ?? '').split('?')[0] ?? ''
    const request = {
      method: path.startsWith('/api/') ? path.slice(5) : '',
      path,
      params: Object.fromEntries(new URLSearchParams(body)),
      auth: req.headers.authorization ?? null,
    }
    requests.push(request)
    const reply = handler(request)
    if (reply.delayMs) await new Promise((done) => setTimeout(done, reply.delayMs))
    if (res.destroyed) return
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers })
    res.end(reply.bytes ?? JSON.stringify(reply.json ?? { ok: true }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('サーバーを開始できません')
  return {
    url: `http://127.0.0.1:${addr.port}/api`,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}
export const historyHandler =
  (messages: import('../lib/json.ts').JsonObject[], pageSize: number): ((req: SlackRequest) => SlackReply) =>
  (req): SlackReply => {
    const micro = (ts: string): number => {
      const [s = '0', f = ''] = ts.split('.')
      return Number(s) * 1000000 + Number(f.padEnd(6, '0'))
    }
    const oldest = micro(req.params.oldest ?? '0')
    const latest = micro(req.params.latest ?? '9999999999')
    const inclusive = req.params.inclusive === 'true'
    const found = messages
      .filter((m) => {
        const ts = micro(String(m.ts))
        return (inclusive ? ts >= oldest : ts > oldest) && (inclusive ? ts <= latest : ts < latest)
      })
      .sort((a, b) => micro(String(b.ts)) - micro(String(a.ts)))
    const limit = Math.min(pageSize, Number(req.params.limit ?? pageSize))
    return { json: { ok: true, messages: found.slice(0, limit), has_more: found.length > limit } }
  }
export const repliesHandler =
  (threads: Record<string, import('../lib/json.ts').JsonObject[]>): ((req: SlackRequest) => SlackReply) =>
  (req): SlackReply => {
    const messages = threads[req.params.ts ?? '']
    if (messages) return { json: { ok: true, messages, response_metadata: { next_cursor: '' } } }
    return { json: { ok: false, error: 'thread_not_found' } }
  }
