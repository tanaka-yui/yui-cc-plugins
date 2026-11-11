import { assert, test } from 'orca/testing'

import {
  claudeTranscriptPath,
  findAgentProcess,
  parseClaudeSessionFile,
  parseCodexRollout,
  transcriptEndsWithRateLimit,
} from './agent-process.ts'

const profile = '/Users/x/Library/Application Support/orca/claude-profiles/u1/home'
const codexHome = '/Users/x/Library/Application Support/orca/codex-accounts/x1/home'

const psOutput = [
  '  100 -/bin/zsh -l TERM=xterm ORCA_TERMINAL_HANDLE=term_a HOME=/Users/x',
  `  101 claude TERM=xterm CLAUDE_CONFIG_DIR=${profile} ORCA_TERMINAL_HANDLE=term_a HOME=/Users/x`,
  '  200 claude --model opus ORCA_TERMINAL_HANDLE=term_b HOME=/Users/x',
  `  300 codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/x/Library/Application Support/orca' -m gpt-6 CODEX_HOME=${codexHome} ORCA_TERMINAL_HANDLE=term_c HOME=/Users/x`,
  `  301 /Users/x/.local/bin/codex-exec-server CODEX_HOME=${codexHome} ORCA_TERMINAL_HANDLE=term_c`,
  '  400 claude ORCA_TERMINAL_HANDLE=term_ab HOME=/Users/x',
].join('\n')

test('finds claude process by terminal handle', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_a', 'claude', '/Users/x'), {
    pid: 101,
    agent: 'claude',
    command: 'claude',
    home: profile,
    terminalHandle: 'term_a',
  })
})

test('defaults claude home when env is absent', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_b', 'claude', '/Users/x'), {
    pid: 200,
    agent: 'claude',
    command: 'claude --model opus',
    home: '/Users/x/.claude',
    terminalHandle: 'term_b',
  })
})

test('finds codex process and keeps quoted args in command', () => {
  assert.deepEqual(findAgentProcess(psOutput, 'term_c', 'codex', '/Users/x'), {
    pid: 300,
    agent: 'codex',
    command:
      "codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/x/Library/Application Support/orca' -m gpt-6",
    home: codexHome,
    terminalHandle: 'term_c',
  })
})

test('ignores processes of other agents and handles', () => {
  assert.equal(findAgentProcess(psOutput, 'term_a', 'codex', '/Users/x'), null)
  assert.equal(findAgentProcess(psOutput, 'term_z', 'claude', '/Users/x'), null)
})

test('prefers the newest process when several match', () => {
  const two = `${psOutput}\n  500 claude ORCA_TERMINAL_HANDLE=term_b HOME=/Users/x`
  assert.equal(findAgentProcess(two, 'term_b', 'claude', '/Users/x')?.pid, 500)
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
const rateLimit = entry({
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3:45pm" }] },
})

test('transcript ending with a rate limit error is a real limit', () => {
  const text = [entry({ type: 'user', message: { content: 'go' } }), rateLimit, entry({ type: 'system' }), ''].join(
    '\n',
  )
  assert.equal(transcriptEndsWithRateLimit(text), true)
})

test('transcript with a later message is not a limit', () => {
  const text = [rateLimit, entry({ type: 'user', message: { content: 'continue' } })].join('\n')
  assert.equal(transcriptEndsWithRateLimit(text), false)
})

test('printed limit text in a tool result is not a limit', () => {
  const printed = entry({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: "You've hit your session limit · resets 3:45pm" }] },
  })
  assert.equal(transcriptEndsWithRateLimit(printed), false)
  assert.equal(transcriptEndsWithRateLimit('{broken'), false)
})

test('finds the process when its prompt argument contains an apostrophe', () => {
  const line = `  600 claude --plugin-dir /Users/x/Library/Application Support/orca/agent-view --model haiku Reply: You've hit your limit ORCA_AGENT_PANE=p ORCA_TERMINAL_HANDLE=term_q HOME=/Users/x`
  const proc = findAgentProcess(line, 'term_q', 'claude', '/Users/x')
  assert.equal(proc?.pid, 600)
  assert.equal(
    proc?.command,
    "claude --plugin-dir /Users/x/Library/Application Support/orca/agent-view --model haiku Reply: You've hit your limit",
  )
})
