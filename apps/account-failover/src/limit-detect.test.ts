import { assert, test } from 'orca/testing'

import { LIMIT_TAIL_LINES } from './config.ts'
import { detectLimit, parseResetTime } from './limit-detect.ts'

// 2026-11-11 は水曜日。時刻はすべてローカル時刻
const now = new Date(2026, 10, 11, 10, 0)
const at = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month, day, hour, minute).getTime()

const claudeScreen = (message: string) => [
  '⏺ working on it',
  `  ⎿  ${message}`,
  '────────────────',
  '❯ ',
  '────────────────',
  '  [Opus 5.5] │ repo git:(main)',
  '  Context █░░░░░░░░░ 5% │ Usage Weekly ██░░░░░░░░ 19% (resets in 2d 14h)',
]

test('detects claude session limit', () => {
  assert.deepEqual(detectLimit('claude', claudeScreen("You've hit your session limit · resets 3:45pm"), now), {
    agent: 'claude',
    reason: 'session',
    resetsAt: at(10, 11, 15, 45),
  })
})

test('detects claude session limit with timezone and error suffix', () => {
  const lines = claudeScreen(
    "You've hit your session limit · resets 5:10pm (Asia/Tokyo) (error type rate_limit, HTTP 429, request_id x)",
  )
  assert.deepEqual(detectLimit('claude', lines, now), {
    agent: 'claude',
    reason: 'session',
    resetsAt: at(10, 11, 17, 10),
  })
})

test('detects claude weekly limit with weekday', () => {
  const hit = detectLimit('claude', claudeScreen("You've hit your weekly limit · resets Mon 12:00am"), now)
  assert.equal(hit?.reason, 'weekly')
  assert.equal(hit?.resetsAt, at(10, 16, 0, 0))
})

test('detects claude model limit', () => {
  const hit = detectLimit('claude', claudeScreen("You've hit your Opus limit · resets 3:45pm"), now)
  assert.equal(hit?.reason, 'Opus')
})

test('detects claude limit without reset time', () => {
  assert.deepEqual(detectLimit('claude', claudeScreen("You've hit your session limit"), now), {
    agent: 'claude',
    reason: 'session',
    resetsAt: null,
  })
})

test('reset time already passed today rolls to tomorrow', () => {
  const late = new Date(2026, 10, 11, 16, 0)
  const hit = detectLimit('claude', claudeScreen("You've hit your session limit · resets 3:45pm"), late)
  assert.equal(hit?.resetsAt, at(10, 12, 15, 45))
})

test('ignores 85% warning', () => {
  assert.equal(detectLimit('claude', claudeScreen("You've used 85% of your session limit · resets 3:45pm"), now), null)
})

test('ignores status line usage meter', () => {
  assert.equal(detectLimit('claude', claudeScreen('done'), now), null)
})

test('ignores limit line outside the tail', () => {
  const lines = [
    "You've hit your session limit · resets 3:45pm",
    ...Array.from({ length: LIMIT_TAIL_LINES }, (_, i) => `line ${i}`),
  ]
  assert.equal(detectLimit('claude', lines, now), null)
})

const codexScreen = (message: string[]) => [
  '› fix the bug',
  ...message,
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol xhigh Fast · Context 3% used · weekly 0% left · repo · main',
]

test('detects codex usage limit with full date', () => {
  const lines = codexScreen([
    "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage",
    ' to purchase more credits or try again at Nov 13, 2026 3:45 PM.',
  ])
  assert.deepEqual(detectLimit('codex', lines, now), {
    agent: 'codex',
    reason: 'usage',
    resetsAt: at(10, 13, 15, 45),
  })
})

test('detects codex usage limit for a model with clock time', () => {
  const lines = codexScreen([
    "■ You've hit your usage limit for gpt-6.1-sol. Switch to another model now, or try again at 3:45 PM.",
  ])
  assert.deepEqual(detectLimit('codex', lines, now), {
    agent: 'codex',
    reason: 'gpt-6.1-sol',
    resetsAt: at(10, 11, 15, 45),
  })
})

test('detects codex usage limit wrapped mid-word', () => {
  const lines = codexScreen([
    "■ You've hit your us",
    'age limit. Visit https://chatgpt.com/settings/usage to purchase more credits',
  ])
  assert.deepEqual(detectLimit('codex', lines, now), { agent: 'codex', reason: 'usage', resetsAt: null })
})

test('claude text does not match for codex agent', () => {
  assert.equal(detectLimit('codex', claudeScreen("You've hit your session limit · resets 3:45pm"), now), null)
})

test('codex text does not match for claude agent', () => {
  assert.equal(detectLimit('claude', codexScreen(["■ You've hit your usage limit. Try again at 3:45 PM."]), now), null)
})

test('parses reset time forms', () => {
  assert.equal(parseResetTime('3pm', now), at(10, 11, 15, 0))
  assert.equal(parseResetTime('Wed 9:00am', now), at(10, 18, 9, 0))
  assert.equal(parseResetTime('Wed 11:00am', now), at(10, 11, 11, 0))
  assert.equal(parseResetTime('soon', now), null)
})

test('ignores codex limit text the agent merely printed', () => {
  const lines = codexScreen(["• You've hit your usage limit. Try again at 3:45 PM. is the message codex shows"])
  assert.equal(detectLimit('codex', lines, now), null)
})

test('ignores a codex limit once the agent produced output after it', () => {
  const lines = codexScreen([
    "■ You've hit your usage limit. Try again at 3:45 PM.",
    '› Continue the task',
    '• Resumed the work',
  ])
  assert.equal(detectLimit('codex', lines, now), null)
})
