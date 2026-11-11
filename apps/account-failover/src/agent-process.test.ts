import { assert, test } from 'orca/testing'

import {
  claudeTranscriptPath,
  findAgentProcess,
  lastRateLimitId,
  parseClaudeSessionFile,
  parseCodexRollout,
} from './agent-process.ts'

const profile = '/Users/x/Library/Application Support/orca/claude-profiles/u1/home'
const codexHome = '/Users/x/Library/Application Support/orca/codex-accounts/x1/home'

// ペインごとに login → ログインシェル → エージェント、の並び（ps -E -Ao pid,ppid,tty,command）
const pane = (tty: string, loginPid: number, shellPid: number) => [
  `  ${loginPid}  1 ${tty} /usr/bin/login -flpq x /bin/bash --noprofile --norc -p -c exec zsh -l`,
  `  ${shellPid} ${loginPid} ${tty} -/bin/zsh -l TERM=xterm HOME=/Users/x`,
]

const psOutput = [
  ...pane('ttys001', 90, 100),
  `  101 100 ttys001 claude TERM=xterm CLAUDE_CONFIG_DIR=${profile} ORCA_TERMINAL_HANDLE=term_a HOME=/Users/x`,
  ...pane('ttys002', 190, 200),
  '  201 200 ttys002 claude --model opus ORCA_TERMINAL_HANDLE=term_b HOME=/Users/x',
  ...pane('ttys003', 290, 300),
  `  301 300 ttys003 codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/x/Library/Application Support/orca' -m gpt-6 CODEX_HOME=${codexHome} ORCA_TERMINAL_HANDLE=term_c HOME=/Users/x`,
  `  302 301 ttys003 /Users/x/.local/bin/codex-exec-server CODEX_HOME=${codexHome} ORCA_TERMINAL_HANDLE=term_c`,
  `  303 301 ttys003 codex app-server CODEX_HOME=${codexHome} ORCA_TERMINAL_HANDLE=term_c`,
  ...pane('ttys004', 390, 400),
  '  401 400 ttys004 claude ORCA_TERMINAL_HANDLE=term_ab HOME=/Users/x',
].join('\n')

test('finds claude process by terminal handle', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_a', '/Users/x'), {
    pid: 101,
    agent: 'claude',
    command: 'claude',
    home: profile,
    terminalHandle: 'term_a',
  })
})

test('defaults claude home when env is absent', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_b', '/Users/x'), {
    pid: 201,
    agent: 'claude',
    command: 'claude --model opus',
    home: '/Users/x/.claude',
    terminalHandle: 'term_b',
  })
})

test('finds codex process and ignores its child processes', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_c', '/Users/x'), {
    pid: 301,
    agent: 'codex',
    command:
      "codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/x/Library/Application Support/orca' -m gpt-6",
    home: codexHome,
    terminalHandle: 'term_c',
  })
})

test('ignores other handles', () => {
  assert.equal(findAgentProcess(psOutput, 'term_z', '/Users/x'), null)
  assert.equal(findAgentProcess(psOutput, 'term_a', '/Users/x')?.pid, 101)
})

test('refuses an agent on a tty without the pane login (tmux, nvim terminal)', () => {
  const tmux = [
    ...pane('ttys001', 90, 100),
    '  500 1 ?? tmux new-session ORCA_TERMINAL_HANDLE=term_t',
    '  501 500 ttys009 -zsh ORCA_TERMINAL_HANDLE=term_t',
    '  502 501 ttys009 claude ORCA_TERMINAL_HANDLE=term_t',
  ].join('\n')
  assert.equal(findAgentProcess(tmux, 'term_t', '/Users/x'), null)
})

test('refuses when several agents in the pane are children of shells', () => {
  const nested = [
    ...pane('ttys001', 90, 100),
    '  101 100 ttys001 codex ORCA_TERMINAL_HANDLE=term_n',
    '  110 101 ttys001 /bin/zsh -c run ORCA_TERMINAL_HANDLE=term_n',
    '  111 110 ttys001 claude -p hi ORCA_TERMINAL_HANDLE=term_n',
  ].join('\n')
  assert.equal(findAgentProcess(nested, 'term_n', '/Users/x'), null)
})

test('refuses an agent whose parent is not a shell', () => {
  const odd = [...pane('ttys001', 90, 100), '  101 90 ttys001 claude ORCA_TERMINAL_HANDLE=term_o'].join('\n')
  assert.equal(findAgentProcess(odd, 'term_o', '/Users/x'), null)
})

test('finds the process when its prompt argument contains an apostrophe', () => {
  const line = [
    ...pane('ttys001', 90, 100),
    `  600 100 ttys001 claude --plugin-dir /Users/x/Library/Application Support/orca/agent-view --model haiku Reply: You've hit your limit ORCA_AGENT_PANE=p ORCA_TERMINAL_HANDLE=term_q HOME=/Users/x`,
  ].join('\n')
  const proc = findAgentProcess(line, 'term_q', '/Users/x')
  assert.equal(proc?.pid, 600)
  assert.equal(
    proc?.command,
    "claude --plugin-dir /Users/x/Library/Application Support/orca/agent-view --model haiku Reply: You've hit your limit",
  )
})

test('parses claude session file', () => {
  const json = JSON.stringify({ pid: 101, sessionId: '0d9a-1', cwd: '/repo', kind: 'interactive' })
  assert.deepEqual(parseClaudeSessionFile(json, 101), { sessionId: '0d9a-1', cwd: '/repo' })
  assert.equal(parseClaudeSessionFile(json, 102), null)
  assert.equal(parseClaudeSessionFile('broken', 101), null)
})

test('transcript path requires exactly one match under home', () => {
  const one = `${profile}/projects/-repo/s1.jsonl`
  assert.equal(claudeTranscriptPath([one], profile, 's1'), one)
  assert.equal(claudeTranscriptPath([], profile, 's1'), null)
  assert.equal(claudeTranscriptPath([one, `${profile}/projects/-other/s1.jsonl`], profile, 's1'), null)
  assert.equal(claudeTranscriptPath(['/elsewhere/projects/-repo/s1.jsonl'], profile, 's1'), null)
})

test('parses codex rollout from lsof', () => {
  const uuid = '01a1c8b4-a127-7183-b899-577b8c0acb39'
  const rollout = `${codexHome}/sessions/2026/11/11/rollout-2026-11-11T12-44-03-${uuid}.jsonl`
  const lsof = [
    'p300',
    'f10',
    `n${codexHome}/state_5.sqlite`,
    'f11',
    `n${rollout}`,
    `n${codexHome}/thread-writer-locks/${uuid}.lock`,
  ].join('\n')
  assert.deepEqual(parseCodexRollout(lsof, codexHome), { sessionId: uuid, rolloutPath: rollout })
  assert.equal(parseCodexRollout(`p300\nn${codexHome}/state_5.sqlite`, codexHome), null)
})

const entry = (value: object) => JSON.stringify(value)
const rateLimit = (uuid: string) =>
  entry({
    type: 'assistant',
    uuid,
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3:45pm" }] },
  })

test('returns the id of a rate limit error at the end of the transcript', () => {
  const text = [
    entry({ type: 'user', message: { content: 'go' } }),
    rateLimit('u1'),
    entry({ type: 'system' }),
    '',
  ].join('\n')
  assert.equal(lastRateLimitId(text), 'u1')
})

test('transcript with a later message has no rate limit', () => {
  assert.equal(
    lastRateLimitId([rateLimit('u1'), entry({ type: 'user', message: { content: 'continue' } })].join('\n')),
    null,
  )
})

test('printed limit text in a tool result is not a rate limit', () => {
  const printed = entry({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: "You've hit your session limit · resets 3:45pm" }] },
  })
  assert.equal(lastRateLimitId(printed), null)
  assert.equal(lastRateLimitId('{broken'), null)
})

test('tolerates extra spaces before the command as ps -E prints for login shells', () => {
  const real = [
    '38166  2826 ttys006 /usr/bin/login -flpq x /bin/bash --noprofile --norc -p -c exec zsh -l',
    '38168 38166 ttys006  -/bin/zsh -l',
    '38467 38168 ttys006 claude ORCA_TERMINAL_HANDLE=term_r HOME=/Users/x',
  ].join('\n')
  assert.equal(findAgentProcess(real, 'term_r', '/Users/x')?.pid, 38467)
})
