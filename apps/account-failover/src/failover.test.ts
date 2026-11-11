import { assert, test } from 'orca/testing'

import { KILL_TIMEOUT_MS, LOOP_WINDOW_MS, MAX_FAILOVERS_PER_WINDOW, RESUME_PROMPT } from './config.ts'
import { createFailover, type Deps } from './failover.ts'

const userData = '/Users/x/Library/Application Support/orca'
const homeDir = '/Users/x'
const claudeHome = (id: string) => `${userData}/claude-profiles/${id}/home`
const codexHome = (id: string) => `${userData}/codex-accounts/${id}/home`
const UUID = '01a1c8b4-a127-7183-b899-577b8c0acb39'
const START = new Date(2026, 10, 11, 10, 0).getTime()

const CLAUDE_LIMIT = "  ⎿  You've hit your session limit · resets 3:45pm (Asia/Tokyo)"
const CODEX_LIMIT = "■ You've hit your usage limit. Visit https://chatgpt.com/settings/usage or try again at 3:45 PM."

const accountsJson = JSON.stringify({
  result: {
    claude: {
      accounts: [{ id: 'c1', home: claudeHome('c1') }],
      systemDefaultHome: `${homeDir}/.claude`,
      systemDefaultEmail: 's@example.com',
    },
    codex: { accounts: [{ id: 'x1' }], systemDefault: { hasAuth: true } },
  },
})

type Fake = {
  deps: Deps
  calls: string[]
  screen: string[]
  ps: string
  alive: Set<number>
  survivesKill: boolean
  clock: { t: number }
  timers: { ms: number; fn: () => void }[]
  transcripts: string[]
  transcriptTail: string
}

const makeFake = (agent: 'claude' | 'codex'): Fake => {
  const fake: Fake = {
    calls: [],
    screen: ['❯ do the work', agent === 'claude' ? CLAUDE_LIMIT : CODEX_LIMIT, '❯ '],
    ps:
      agent === 'claude'
        ? `  101 claude CLAUDE_CONFIG_DIR=${claudeHome('c1')} ORCA_TERMINAL_HANDLE=term_1`
        : `  301 codex -m gpt-6 CODEX_HOME=${codexHome('x1')} ORCA_TERMINAL_HANDLE=term_1`,
    alive: new Set([101, 301]),
    survivesKill: false,
    clock: { t: START },
    timers: [],
    transcripts: [`${claudeHome('c1')}/projects/-repo/s1.jsonl`],
    transcriptTail: JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit' }),
    deps: undefined as never,
  }
  const rollout = `${codexHome('x1')}/sessions/2026/11/11/rollout-2026-11-11T10-00-00-${UUID}.jsonl`
  fake.deps = {
    readTerminal: async () => fake.screen,
    sendText: async (id, text) => {
      fake.calls.push(`send ${id} ${text}`)
      return true
    },
    listProcesses: async () => fake.ps,
    readFile: async (path) =>
      path === `${claudeHome('c1')}/sessions/101.json`
        ? JSON.stringify({ pid: 101, sessionId: 's1', cwd: '/repo' })
        : null,
    globTranscripts: async () => fake.transcripts,
    readFileTail: async () => fake.transcriptTail,
    lsof: async () => `p301\nn${rollout}`,
    copyFile: async (from, to) => {
      fake.calls.push(`copy ${from} -> ${to}`)
    },
    signal: (pid, sig) => {
      fake.calls.push(`signal ${pid} ${sig}`)
      if (!fake.survivesKill) fake.alive.delete(pid)
    },
    isAlive: (pid) => fake.alive.has(pid),
    accountListJson: async () => accountsJson,
    selectAccount: async (a, id) => {
      fake.calls.push(`select ${a} ${id}`)
    },
    notify: async (title) => {
      fake.calls.push(`notify ${title}`)
    },
    status: async () => {},
    log: () => {},
    now: () => fake.clock.t,
    sleep: async (ms) => {
      fake.clock.t += ms
    },
    schedule: (ms, fn) => {
      fake.timers.push({ ms, fn })
    },
    homeDir,
    orcaUserData: userData,
  }
  return fake
}

const done = { terminalId: 'term_1', state: 'done' as const }
const kinds = (calls: string[]) => calls.map((c) => c.split(' ')[0])

test('claude happy path', async () => {
  const fake = makeFake('claude')
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['signal', 'select', 'send', 'notify'])
  assert.equal(fake.calls[1], 'select claude system')
  assert.equal(
    fake.calls[2],
    `send term_1 claude --resume '${claudeHome('c1')}/projects/-repo/s1.jsonl' '${RESUME_PROMPT}'`,
  )
})

test('codex happy path copies rollout before resume', async () => {
  const fake = makeFake('codex')
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['signal', 'select', 'copy', 'send', 'notify'])
  assert.equal(fake.calls[1], 'select codex system')
  assert.ok(
    fake.calls[2]?.endsWith(`-> ${homeDir}/.codex/sessions/2026/11/11/rollout-2026-11-11T10-00-00-${UUID}.jsonl`),
  )
  assert.ok(fake.calls[3]?.startsWith(`send term_1 (unset CODEX_HOME; codex resume '-m' 'gpt-6' ${UUID} `))
})

test('ignores working state and non-limit screens', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus({ terminalId: 'term_1', state: 'working' })
  fake.screen = ['❯ done', '  Usage Weekly ██░░ 19% (resets in 2d 14h)']
  await failover.onStatus(done)
  await failover.onStatus({ state: 'done' })
  assert.deepEqual(fake.calls, [])
})

test('handles duplicate events for one terminal once', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await Promise.all([failover.onStatus(done), failover.onStatus(done)])
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, 1)
})

test('ignores the old limit message redrawn by the resumed session', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  await failover.onStatus(done)
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, 1)
})

test('stops after max failovers in window', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  for (let i = 0; i <= MAX_FAILOVERS_PER_WINDOW; i++) {
    fake.screen = ['❯ go', `  ⎿  You've hit your session limit · resets ${i + 1}:00pm`]
    fake.ps = `  ${200 + i} claude CLAUDE_CONFIG_DIR=${claudeHome('c1')} ORCA_TERMINAL_HANDLE=term_1`
    fake.alive.add(200 + i)
    fake.transcripts = [`${claudeHome('c1')}/projects/-repo/s1.jsonl`]
    fake.deps.readFile = async () => JSON.stringify({ pid: 200 + i, sessionId: 's1', cwd: '/repo' })
    await failover.onStatus(done)
  }
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, MAX_FAILOVERS_PER_WINDOW)
  assert.ok(fake.calls.at(-1)?.startsWith('notify'))
  assert.ok(fake.clock.t - START < LOOP_WINDOW_MS)
})

test('waits until reset when all accounts cool down', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  // 乗り換え先の system でも limit になった（解除は 4:00pm）
  fake.screen = ['❯ go', "  ⎿  You've hit your session limit · resets 4:00pm"]
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  fake.transcripts = [`${homeDir}/.claude/projects/-repo/s1.jsonl`]
  fake.deps.readFile = async () => JSON.stringify({ pid: 102, sessionId: 's1', cwd: '/repo' })
  fake.calls.length = 0
  await failover.onStatus(done)
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, 0)
  assert.equal(fake.timers.length, 1)
  const resetAt = new Date(2026, 10, 11, 15, 45).getTime() + 60_000
  assert.equal(fake.timers[0]?.ms, resetAt - fake.clock.t)

  // 予約の発火時に limit が消えていれば何もしない
  fake.screen = ['❯ go', '⏺ done']
  fake.clock.t = resetAt
  fake.timers[0]?.fn()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, 0)
})

test('resumes on the waited account when the timer fires and the limit remains', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.screen = ['❯ go', "  ⎿  You've hit your session limit · resets 4:00pm"]
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  fake.transcripts = [`${homeDir}/.claude/projects/-repo/s1.jsonl`]
  fake.deps.readFile = async () => JSON.stringify({ pid: 102, sessionId: 's1', cwd: '/repo' })
  await failover.onStatus(done)
  fake.calls.length = 0
  fake.clock.t = new Date(2026, 10, 11, 15, 47).getTime()
  fake.timers[0]?.fn()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(
    fake.calls.find((c) => c.startsWith('select')),
    'select claude c1',
  )
})

test('does not resume when the process survives SIGKILL', async () => {
  const fake = makeFake('claude')
  fake.survivesKill = true
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['signal', 'signal', 'notify'])
  assert.ok(fake.clock.t - START >= 2 * KILL_TIMEOUT_MS)
})

test('does not resume when the session cannot be resolved', async () => {
  const fake = makeFake('claude')
  fake.transcripts = []
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['notify'])
})

test('does nothing when the agent process is gone', async () => {
  const fake = makeFake('claude')
  fake.ps = '  100 -/bin/zsh -l ORCA_TERMINAL_HANDLE=term_1'
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['notify'])
})

test('notifies when a trust dialog blocks the resumed session', async () => {
  const fake = makeFake('claude')
  const original = fake.deps.sendText
  fake.deps.sendText = async (id, text) => {
    fake.screen = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit']
    return original(id, text)
  }
  const titles: string[] = []
  fake.deps.notify = async (title, body) => {
    titles.push(`${title}|${body}`)
  }
  await createFailover(fake.deps).onStatus(done)
  assert.equal(titles.length, 1)
  assert.match(titles[0] ?? '', /確認/)
})

test('resumes on the same account after waiting for its own reset', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  // c1 は 3:45pm に解除。system に乗り換える
  await failover.onStatus(done)
  // system でも limit。解除は c1 より早い 3:00pm
  fake.screen = ['❯ go', "  ⎿  You've hit your session limit · resets 3:00pm"]
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  fake.transcripts = [`${homeDir}/.claude/projects/-repo/s1.jsonl`]
  fake.deps.readFile = async () => JSON.stringify({ pid: 102, sessionId: 's1', cwd: '/repo' })
  await failover.onStatus(done)
  assert.equal(fake.timers.length, 1)
  fake.calls.length = 0
  fake.clock.t = new Date(2026, 10, 11, 15, 2).getTime()
  fake.timers[0]?.fn()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(fake.timers.length, 1)
  assert.equal(
    fake.calls.find((c) => c.startsWith('select')),
    'select claude system',
  )
})

test('does not stack timers for repeated events while waiting', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.screen = ['❯ go', "  ⎿  You've hit your session limit · resets 4:00pm"]
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  fake.transcripts = [`${homeDir}/.claude/projects/-repo/s1.jsonl`]
  fake.deps.readFile = async () => JSON.stringify({ pid: 102, sessionId: 's1', cwd: '/repo' })
  await failover.onStatus(done)
  await failover.onStatus(done)
  assert.equal(fake.timers.length, 1)
})

test('ignores the redrawn old message even after its reset time passed', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.ps = `  102 claude CLAUDE_CONFIG_DIR=${homeDir}/.claude ORCA_TERMINAL_HANDLE=term_1`
  fake.alive.add(102)
  fake.transcripts = [`${homeDir}/.claude/projects/-repo/s1.jsonl`]
  fake.deps.readFile = async () => JSON.stringify({ pid: 102, sessionId: 's1', cwd: '/repo' })
  fake.clock.t = new Date(2026, 10, 11, 16, 0).getTime()
  await failover.onStatus(done)
  assert.equal(fake.calls.filter((c) => c.startsWith('select')).length, 1)
})

test('ignores a claude limit message the agent merely printed', async () => {
  const fake = makeFake('claude')
  fake.transcriptTail = JSON.stringify({ type: 'assistant', message: { content: 'the limit text looks like this' } })
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(fake.calls, [])
})
