import { assert, test } from 'orca/testing'

import { KILL_TIMEOUT_MS, MAX_FAILOVERS_PER_WINDOW, RESUME_PROMPT } from './config.ts'
import { createFailover, type Deps } from './failover.ts'

import type { AgentKind } from './types.ts'

const userData = '/Users/x/Library/Application Support/orca'
const homeDir = '/Users/x'
const claudeHome = (id: string) => `${userData}/claude-profiles/${id}/home`
const codexHome = (id: string) => `${userData}/codex-accounts/${id}/home`
const UUID = '01a1c8b4-a127-7183-b899-577b8c0acb39'
const START = new Date(2026, 10, 11, 10, 0).getTime()

const claudeLimit = (reset: string) => ['❯ do the work', `  ⎿  You've hit your session limit${reset}`, '❯ ']
const CLAUDE_SCREEN = claudeLimit(' · resets 3:45pm (Asia/Tokyo)')
const CODEX_SCREEN = [
  '› do the work',
  "■ You've hit your usage limit. Visit https://chatgpt.com/settings/usage or try again at 3:45 PM.",
  '› Ask Codex to do anything',
]
const rateLimit = (uuid: string) =>
  JSON.stringify({ type: 'assistant', uuid, isApiErrorMessage: true, error: 'rate_limit' })
const NORMAL_TAIL = JSON.stringify({ type: 'assistant', uuid: 'n1', message: { content: 'working' } })

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

const homeOf = (agent: AgentKind, id: string): string => {
  if (id === 'system') return `${homeDir}/${agent === 'claude' ? '.claude' : '.codex'}`
  return agent === 'claude' ? claudeHome(id) : codexHome(id)
}

type Fake = {
  deps: Deps
  calls: string[]
  notices: string[]
  screen: string[]
  agent: { kind: AgentKind; pid: number; home: string } | null
  alive: Set<number>
  survivesKill: boolean
  accepts: boolean
  resumeStarts: boolean
  selectFails: boolean
  clock: { t: number }
  timers: { ms: number; fn: () => void }[]
  transcriptFound: boolean
  transcriptTail: string
  setAgent(kind: AgentKind, pid: number, home: string): void
}

const PANE = [
  '   90   1 ttys001 /usr/bin/login -flpq x /bin/bash --noprofile --norc -p -c exec zsh -l',
  '  100  90 ttys001 -/bin/zsh -l HOME=/Users/x',
]

const makeFake = (kind: AgentKind): Fake => {
  const fake: Fake = {
    calls: [],
    notices: [],
    screen: kind === 'claude' ? CLAUDE_SCREEN : CODEX_SCREEN,
    agent: null,
    alive: new Set(),
    survivesKill: false,
    accepts: true,
    resumeStarts: true,
    selectFails: false,
    clock: { t: START },
    timers: [],
    transcriptFound: true,
    transcriptTail: rateLimit('u1'),
    setAgent: (k, pid, home) => {
      fake.agent = { kind: k, pid, home }
      fake.alive.add(pid)
    },
    deps: undefined as never,
  }
  fake.setAgent(kind, kind === 'claude' ? 101 : 301, kind === 'claude' ? claudeHome('c1') : codexHome('x1'))
  let selected = ''
  const rolloutIn = (home: string) => `${home}/sessions/2026/11/11/rollout-2026-11-11T10-00-00-${UUID}.jsonl`
  fake.deps = {
    readTerminal: async () => fake.screen,
    sendText: async (id, text) => {
      fake.calls.push(`send ${id} ${text}`)
      if (!fake.accepts) return false
      if (fake.resumeStarts && fake.agent)
        fake.setAgent(fake.agent.kind, fake.agent.pid + 1, homeOf(fake.agent.kind, selected))
      return true
    },
    listProcesses: async () => {
      const a = fake.agent
      if (!a || !fake.alive.has(a.pid)) return PANE.join('\n')
      const env = a.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
      const command = a.kind === 'claude' ? 'claude' : 'codex -m gpt-6'
      return [...PANE, `  ${a.pid} 100 ttys001 ${command} ${env}=${a.home} ORCA_TERMINAL_HANDLE=term_1`].join('\n')
    },
    readFile: async (path) =>
      fake.agent && path === `${fake.agent.home}/sessions/${fake.agent.pid}.json`
        ? JSON.stringify({ pid: fake.agent.pid, sessionId: 's1', cwd: '/repo' })
        : null,
    globTranscripts: async (home) => (fake.transcriptFound ? [`${home}/projects/-repo/s1.jsonl`] : []),
    readFileTail: async () => fake.transcriptTail,
    pathExists: () => false,
    lsof: async () => `p1\nn${rolloutIn(fake.agent?.home ?? '')}`,
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
      if (fake.selectFails) throw new Error('orca account select failed')
      selected = id
    },
    notify: async (title, body) => {
      fake.calls.push(`notify ${title}`)
      fake.notices.push(`${title}|${body}`)
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
const selects = (fake: Fake) => fake.calls.filter((c) => c.startsWith('select'))
const fire = async (fake: Fake, at: number) => {
  fake.clock.t = at
  const timer = fake.timers.shift()
  timer?.fn()
  await new Promise((r) => setTimeout(r, 10))
}

test('claude happy path', async () => {
  const fake = makeFake('claude')
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['select', 'signal', 'send', 'notify'])
  assert.equal(fake.calls[0], 'select claude system')
  assert.equal(
    fake.calls[2],
    `send term_1 claude --resume '${claudeHome('c1')}/projects/-repo/s1.jsonl' '${RESUME_PROMPT}'`,
  )
  assert.match(fake.notices[0] ?? '', /切り替えました/)
})

test('codex happy path copies rollout before resume', async () => {
  const fake = makeFake('codex')
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['select', 'signal', 'copy', 'send', 'notify'])
  assert.equal(fake.calls[0], 'select codex system')
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
  assert.equal(selects(fake).length, 1)
})

test('ignores the old claude limit redrawn by the resumed session', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.transcriptTail = NORMAL_TAIL
  await failover.onStatus(done)
  assert.equal(selects(fake).length, 1)
})

test('ignores the old codex limit once the resumed session answered', async () => {
  const fake = makeFake('codex')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.screen = [...CODEX_SCREEN.slice(0, 2), `› ${RESUME_PROMPT}`, '• Continuing the task']
  await failover.onStatus(done)
  assert.equal(selects(fake).length, 1)
})

test('ignores a claude limit message the agent merely printed', async () => {
  const fake = makeFake('claude')
  fake.transcriptTail = NORMAL_TAIL
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(fake.calls, [])
})

test('stops after max failovers in window', async () => {
  const fake = makeFake('claude')
  // 乗り換えのたびに空いているアカウントがあるよう、4 アカウントにする
  fake.deps.accountListJson = async () =>
    JSON.stringify({
      result: {
        claude: {
          accounts: ['c1', 'c2', 'c3'].map((id) => ({ id, home: claudeHome(id) })),
          systemDefaultHome: `${homeDir}/.claude`,
          systemDefaultEmail: 's@example.com',
        },
      },
    })
  const failover = createFailover(fake.deps)
  for (let i = 0; i <= MAX_FAILOVERS_PER_WINDOW; i++) {
    fake.screen = claudeLimit(` · resets ${i + 1}:00pm`)
    fake.transcriptTail = rateLimit(`u${i}`)
    await failover.onStatus(done)
  }
  assert.equal(selects(fake).length, MAX_FAILOVERS_PER_WINDOW)
  assert.match(fake.notices.at(-1) ?? '', /止めました/)

  // 上限に達した後でも、transcript に記録のない表示では通知しない
  const count = fake.notices.length
  fake.transcriptTail = NORMAL_TAIL
  await failover.onStatus(done)
  assert.equal(fake.notices.length, count)
})

test('waits until reset when all accounts cool down', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  // 乗り換え先の system でも limit になった（解除は 4:00pm）
  fake.screen = claudeLimit(' · resets 4:00pm')
  fake.transcriptTail = rateLimit('u2')
  await failover.onStatus(done)
  assert.equal(selects(fake).length, 1)
  assert.equal(fake.timers.length, 1)
  const resetAt = new Date(2026, 10, 11, 15, 45).getTime() + 60_000
  assert.equal(fake.timers[0]?.ms, resetAt - fake.clock.t)

  // 予約の発火時に limit が消えていれば何もしない
  fake.screen = ['❯ go', '⏺ done']
  await fire(fake, resetAt)
  assert.equal(selects(fake).length, 1)
})

test('resumes on the waited account when the timer fires and the limit remains', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.screen = claudeLimit(' · resets 4:00pm')
  fake.transcriptTail = rateLimit('u2')
  await failover.onStatus(done)
  await fire(fake, new Date(2026, 10, 11, 15, 47).getTime())
  assert.equal(selects(fake).at(-1), 'select claude c1')
})

test('resumes on the same account after waiting for its own reset', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  // system でも limit。解除は c1 より早い 3:00pm
  fake.screen = claudeLimit(' · resets 3:00pm')
  fake.transcriptTail = rateLimit('u2')
  await failover.onStatus(done)
  assert.equal(fake.timers.length, 1)
  await fire(fake, new Date(2026, 10, 11, 15, 2).getTime())
  assert.equal(fake.timers.length, 0)
  assert.equal(selects(fake).at(-1), 'select claude system')
})

test('does not stack timers for repeated events while waiting', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  fake.screen = claudeLimit(' · resets 4:00pm')
  fake.transcriptTail = rateLimit('u2')
  await failover.onStatus(done)
  await failover.onStatus(done)
  assert.equal(fake.timers.length, 1)
})

test('waits when limits without reset time hit every account', async () => {
  const fake = makeFake('claude')
  const failover = createFailover(fake.deps)
  fake.screen = claudeLimit('')
  await failover.onStatus(done)
  fake.transcriptTail = rateLimit('u2')
  await failover.onStatus(done)
  assert.equal(selects(fake).length, 1)
  assert.equal(fake.timers.length, 1)
})

test('does not resume when the process survives SIGKILL', async () => {
  const fake = makeFake('claude')
  fake.survivesKill = true
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['select', 'signal', 'signal', 'notify'])
  assert.ok(fake.clock.t - START >= 2 * KILL_TIMEOUT_MS)
})

test('does not stop the process when the account selection fails', async () => {
  const fake = makeFake('claude')
  fake.selectFails = true
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['select', 'notify'])
})

test('does not resume when the session cannot be resolved', async () => {
  const fake = makeFake('claude')
  fake.transcriptFound = false
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['notify'])
})

test('notifies once when the agent process is gone', async () => {
  const fake = makeFake('claude')
  fake.agent = null
  const failover = createFailover(fake.deps)
  await failover.onStatus(done)
  await failover.onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['notify'])
})

test('reports failure when the resume command is not accepted', async () => {
  const fake = makeFake('claude')
  fake.accepts = false
  await createFailover(fake.deps).onStatus(done)
  assert.deepEqual(kinds(fake.calls), ['select', 'signal', 'send', 'notify'])
  assert.match(fake.notices[0] ?? '', /中止/)
})

test('reports failure when no agent process starts after resume', async () => {
  const fake = makeFake('claude')
  fake.resumeStarts = false
  await createFailover(fake.deps).onStatus(done)
  assert.equal(fake.notices.length, 1)
  assert.match(fake.notices[0] ?? '', /中止/)
})

test('notifies when a trust dialog blocks the resumed session', async () => {
  const fake = makeFake('claude')
  const original = fake.deps.sendText
  fake.deps.sendText = async (id, text) => {
    fake.screen = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit']
    return original(id, text)
  }
  await createFailover(fake.deps).onStatus(done)
  assert.equal(fake.notices.length, 1)
  assert.match(fake.notices[0] ?? '', /確認/)
})
