import { assert, test } from 'orca/testing'

import { buildResumeCommand, codexRolloutTarget, keptFlags } from './resume-command.ts'

import type { AccountRef, AgentProcess, SessionRef } from './types.ts'

const noPaths = () => false

test('keeps whitelisted claude flags', () => {
  assert.deepEqual(
    keptFlags(
      'claude',
      'claude --model opus --effort high --permission-mode acceptEdits --dangerously-skip-permissions --resume old fix bug',
      noPaths,
    ),
    ['--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
  )
})

test('keeps flags written with equals', () => {
  assert.deepEqual(keptFlags('claude', 'claude --model=opus --verbose', noPaths), ['--model=opus'])
})

test('keeps whitelisted codex flags', () => {
  assert.deepEqual(
    keptFlags(
      'codex',
      'codex -m gpt-6-astra -c model_reasoning_effort=xhigh --sandbox workspace-write -a never task',
      noPaths,
    ),
    ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh', '--sandbox', 'workspace-write', '-a', 'never'],
  )
})

test('drops flags the orca codex wrapper adds again', () => {
  const command =
    "codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/x/Library/Application Support/orca' -c disable_paste_burst=true --dangerously-bypass-approvals-and-sandbox Reply with OK"
  assert.deepEqual(keptFlags('codex', command, noPaths), [
    '-c',
    'disable_paste_burst=true',
    '--dangerously-bypass-approvals-and-sandbox',
  ])
})

const claudeProc: AgentProcess = {
  pid: 1,
  agent: 'claude',
  command: 'claude --model opus',
  home: '/h/old',
  terminalHandle: 't',
}
const claudeSession: SessionRef = {
  agent: 'claude',
  sessionId: 's1',
  cwd: '/repo',
  transcriptPath: "/Users/x/.claude/projects/-repo/it's.jsonl",
}

test('claude resume relies on the orca wrapper for the selected account', () => {
  const managed: AccountRef = { agent: 'claude', id: 'c2', home: '/h/new', isSystem: false }
  const system: AccountRef = { agent: 'claude', id: 'system', home: '/Users/x/.claude', isSystem: true }
  const expected = "claude '--model' 'opus' --resume '/Users/x/.claude/projects/-repo/it'\\''s.jsonl' 'go on'"
  assert.equal(buildResumeCommand(claudeProc, claudeSession, managed, 'go on', noPaths), expected)
  assert.equal(buildResumeCommand(claudeProc, claudeSession, system, 'go on', noPaths), expected)
})

const codexProc: AgentProcess = {
  pid: 2,
  agent: 'codex',
  command: 'codex --no-daemon -m gpt-6 task',
  home: '/h/x1',
  terminalHandle: 't',
}
const codexSession: SessionRef = {
  agent: 'codex',
  sessionId: '01a1c8b4-a127-7183-b899-577b8c0acb39',
  cwd: '/repo',
  transcriptPath: '/h/x1/sessions/r.jsonl',
}

test('codex resume for managed account sets CODEX_HOME', () => {
  const target: AccountRef = { agent: 'codex', id: 'x2', home: '/a b/x2/home', isSystem: false }
  assert.equal(
    buildResumeCommand(codexProc, codexSession, target, 'go on', noPaths),
    "CODEX_HOME='/a b/x2/home' codex resume '-m' 'gpt-6' 01a1c8b4-a127-7183-b899-577b8c0acb39 'go on'",
  )
})

test('codex resume for system account unsets CODEX_HOME in a subshell', () => {
  const target: AccountRef = { agent: 'codex', id: 'system', home: '/Users/x/.codex', isSystem: true }
  assert.equal(
    buildResumeCommand(codexProc, codexSession, target, 'go on', noPaths),
    "(unset CODEX_HOME; codex resume '-m' 'gpt-6' 01a1c8b4-a127-7183-b899-577b8c0acb39 'go on')",
  )
})

test('maps rollout path into target home', () => {
  assert.equal(
    codexRolloutTarget('/a/home/sessions/2026/11/11/r.jsonl', '/a/home', '/b/home'),
    '/b/home/sessions/2026/11/11/r.jsonl',
  )
  assert.equal(
    codexRolloutTarget('/a/home/sessions/2026/11/11/r.jsonl', '/a/home/', '/b/home/'),
    '/b/home/sessions/2026/11/11/r.jsonl',
  )
})

test('keeps flags before a prompt that contains an apostrophe', () => {
  assert.deepEqual(
    keptFlags(
      'claude',
      "claude --plugin-dir /a b/c --dangerously-skip-permissions --model haiku Reply: You've hit it",
      (path) => path === '/a b/c',
    ),
    ['--dangerously-skip-permissions', '--model', 'haiku'],
  )
})

test('does not take flags from prompt text', () => {
  assert.deepEqual(
    keptFlags('claude', 'claude --model opus Reply and also pass --dangerously-skip-permissions', noPaths),
    ['--model', 'opus'],
  )
  assert.deepEqual(
    keptFlags(
      'codex',
      'codex -m gpt-6 fix it --dangerously-bypass-approvals-and-sandbox -s danger-full-access',
      noPaths,
    ),
    ['-m', 'gpt-6'],
  )
})

test('stops at the prompt even right after a path valued flag', () => {
  const exists = (path: string) => path === '/a b/c'
  assert.deepEqual(
    keptFlags('claude', 'claude --plugin-dir /a b/c --model haiku task --dangerously-skip-permissions', exists),
    ['--model', 'haiku'],
  )
  assert.deepEqual(keptFlags('claude', 'claude --plugin-dir /a b/c task --dangerously-skip-permissions', exists), [])
})

test('stops scanning when a path value cannot be confirmed', () => {
  assert.deepEqual(
    keptFlags('claude', 'claude --plugin-dir /x y --dangerously-skip-permissions', () => false),
    [],
  )
})
