import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

export const fakeGh = (dir: string): { ghPath: string; log: string; state: string; env: Record<string, string> } => {
  const { ghPath, log, state } = {
    ghPath: join(dir, 'gh'),
    log: join(dir, 'gh.jsonl'),
    state: join(dir, 'issues.json'),
  }
  const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(
    ghPath,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dirname, 'fixtures/fake-gh.ts'))} "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(log, '')
  writeFileSync(state, '[]')
  return { ghPath, log, state, env: { FAKE_GH_LOG: log, FAKE_GH_STATE: state } }
}
export const ghCalls = (log: string): Array<{ argv: string[]; body: string | null; pid: number }> =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as { argv: string[]; body: string | null; pid: number })
export const seedIssues = (state: string, issues: object[]): void => writeFileSync(state, JSON.stringify(issues))
export const startIdleProcess = async (): Promise<{
  pid: number
  identity: import('../lib/types.ts').ProcessIdentity
  stop: () => Promise<void>
}> => {
  const { identityOf } = await import('../lib/process.ts')
  const p = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/idle-process.ts')], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  await new Promise<void>((done) => p.stdout.once('data', () => done()))
  if (!p.pid) throw new Error('プロセスを開始できません')
  const identity = identityOf(p.pid)
  if (!identity) throw new Error('プロセスの身元がありません')
  return {
    pid: p.pid,
    identity,
    stop: () =>
      new Promise<void>((done) => {
        if (p.exitCode !== null || p.signalCode !== null) {
          done()
          return
        }
        p.once('close', () => done())
        p.kill('SIGKILL')
      }),
  }
}

export const setupHome = async (
  home: string,
  opts: { apiBase: string; ghPath: string; ghState: string; cursor?: string; acceptAfter?: string },
): Promise<Record<string, string>> => {
  const { saveConfig } = await import('../lib/config.ts')
  const { saveToken } = await import('../lib/secrets.ts')
  const { homePaths, pluginRoot } = await import('../lib/paths.ts')
  const { openDb, setMeta } = await import('../lib/db.ts')
  const f = await import('./fixtures/slack-messages.ts')
  saveConfig(home, {
    version: 1,
    channel: f.CHANNEL,
    repo: 'acme/app',
    everyMinutes: 5,
    ghPath: opts.ghPath,
    pluginRoot: pluginRoot(),
    slack: { teamId: f.TEAM_ID, teamUrl: f.TEAM_URL, botUserId: f.BOT_USER, botId: f.BOT_ID },
    github: { login: 'intake-bot' },
    orca: { workspaceSelector: null, automationId: null },
    acceptedPermissions: null,
  })
  saveToken(homePaths(home).secrets, 'xoxb-test-token')
  const db = openDb(homePaths(home).db)
  setMeta(db, 'cursor_ts', opts.cursor ?? f.tsAt(3600, 0))
  setMeta(db, 'accept_after_ts', opts.acceptAfter ?? opts.cursor ?? f.tsAt(3600, 0))
  db.close()
  const { proposedRules, applyProject, applyUserDeny, permissionFingerprint } = await import('../lib/permissions.ts')
  const { loadConfig } = await import('../lib/config.ts')
  const previous = process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
  const ch = join(home, 'claude-home')
  process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = ch
  try {
    const rules = proposedRules(home)
    applyProject(rules)
    applyUserDeny(rules)
    const c = loadConfig(home)
    if (c) {
      c.acceptedPermissions = permissionFingerprint(home)
      saveConfig(home, c)
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
    else process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = previous
  }
  return {
    SLACK_ISSUE_INTAKE_HOME: home,
    SLACK_ISSUE_INTAKE_CLAUDE_HOME: ch,
    SLACK_ISSUE_INTAKE_API_BASE: opts.apiBase,
    FAKE_GH_STATE: opts.ghState,
  }
}
export const seedSubmission = async (
  home: string,
  patch: Partial<import('../lib/db.ts').Submission> & { ts: string; state: import('../lib/types.ts').State },
): Promise<number> => {
  const { openDb, insertSubmission, transition } = await import('../lib/db.ts')
  const { acquireLease, releaseLease } = await import('../lib/lease.ts')
  const { homePaths } = await import('../lib/paths.ts')
  const { parseSubmission } = await import('../lib/parse.ts')
  const f = await import('./fixtures/slack-messages.ts')
  const db = openDb(homePaths(home).db)
  const parsed = parseSubmission(f.templateText(), null)
  if (parsed.kind !== 'ok') throw new Error('fixtureが不正です')
  const id = insertSubmission(
    db,
    {
      channel: f.CHANNEL,
      ts: patch.ts,
      permalink: `${f.TEAM_URL}archives/${f.CHANNEL}/p${patch.ts.replace('.', '')}`,
      raw: f.textMessage(patch.ts, f.templateText()),
      fields: parsed.fields,
      problems: [],
      reporterId: f.REPORTER,
      state: 'new',
    },
    f.NOW,
  )
  if (!id) throw new Error('挿入できません')
  const lease = acquireLease(db, 'admin', null, new Date(f.NOW), 300000)
  if (!lease.ok) throw new Error('リースを取得できません')
  transition(db, lease.token, id, 'new', patch, f.NOW)
  releaseLease(db, lease.token)
  db.close()
  return id
}
export const fakeOrca = (dir: string): { path: string; log: string; env: Record<string, string> } => {
  const path = join(dir, 'orca')
  const log = join(dir, 'orca.jsonl')
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(import.meta.dirname, 'fixtures/fake-orca.ts'))} "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(log, '')
  return { path, log, env: { ORCA_BIN: path, FAKE_ORCA_LOG: log } }
}
export const orcaCalls = (log: string): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as string[])
export const fakeSlackCli = (dir: string): { path: string; log: string; env: Record<string, string> } => {
  const path = join(dir, 'slack')
  const log = join(dir, 'slack-cli.jsonl')
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(import.meta.dirname, 'fixtures/fake-slack-cli.ts'))} "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(log, '')
  return { path, log, env: { SLACK_ISSUE_INTAKE_SLACK_CLI: path, FAKE_SLACK_CLI_LOG: log } }
}
export const slackCliCalls = (
  log: string,
): Array<{ argv: string[]; cwd: string; hadBotToken: boolean; triggerDef?: import('../lib/json.ts').Json }> =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s))
// タスク 3 のテスト用。Slack CLI のプロジェクトを作り、デプロイ済みのアプリを置く
export const seedSlackApp = async (home: string, teamId: string): Promise<void> => {
  const { slackProject, writeProject } = await import('../lib/slack-cli.ts')
  const project = slackProject(home)
  writeProject(project)
  writeFileSync(project.apps, JSON.stringify({ apps: { A0FAKE001: { app_id: 'A0FAKE001', team_id: teamId } } }))
}
