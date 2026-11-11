import { assert, test } from 'orca/testing'

import { cooldownFor, parseAccountList, pickNextAccount } from './accounts.ts'
import { RESET_GRACE_MS, UNKNOWN_RESET_COOLDOWN_MS } from './config.ts'

import type { AccountRef } from './types.ts'

const userData = '/Users/x/Library/Application Support/orca'
const claudeHome = (id: string) => `${userData}/claude-profiles/${id}/home`

const listJson = (codexSystemAuth: boolean) =>
  JSON.stringify({
    ok: true,
    result: {
      claude: {
        accounts: [
          { id: 'c1', email: 'a@example.com', home: claudeHome('c1') },
          { id: 'c2', email: 'b@example.com', home: claudeHome('c2') },
        ],
        activeAccountId: 'c1',
        systemDefaultHome: '/Users/x/.claude',
        systemDefaultEmail: 'c@example.com',
      },
      codex: {
        accounts: [{ id: 'x1', email: 'a@example.com' }],
        activeAccountId: 'x1',
        systemDefault: { hasAuth: codexSystemAuth, authKind: 'oauth' },
      },
    },
  })

test('lists managed accounts then system for claude', () => {
  assert.deepEqual(parseAccountList(listJson(true), 'claude', userData, '/Users/x'), [
    { agent: 'claude', id: 'c1', home: claudeHome('c1'), isSystem: false },
    { agent: 'claude', id: 'c2', home: claudeHome('c2'), isSystem: false },
    { agent: 'claude', id: 'system', home: '/Users/x/.claude', isSystem: true },
  ])
})

test('derives codex homes', () => {
  assert.deepEqual(parseAccountList(listJson(true), 'codex', userData, '/Users/x'), [
    { agent: 'codex', id: 'x1', home: `${userData}/codex-accounts/x1/home`, isSystem: false },
    { agent: 'codex', id: 'system', home: '/Users/x/.codex', isSystem: true },
  ])
})

test('omits system when it has no auth', () => {
  assert.deepEqual(
    parseAccountList(listJson(false), 'codex', userData, '/Users/x').map((a) => a.id),
    ['x1'],
  )
})

test('returns no accounts for malformed json', () => {
  assert.deepEqual(parseAccountList('{"ok":false}', 'claude', userData, '/Users/x'), [])
  assert.deepEqual(parseAccountList('not json', 'claude', userData, '/Users/x'), [])
})

const accounts: AccountRef[] = parseAccountList(listJson(true), 'claude', userData, '/Users/x')
const [a0, a1, a2] = accounts as [AccountRef, AccountRef, AccountRef]
const now = 1_000_000

test('picks the account after the current one', () => {
  assert.deepEqual(pickNextAccount(accounts, a0.home, [], now), { kind: 'switch', account: a1 })
  assert.deepEqual(pickNextAccount(accounts, `${a2.home}/`, [], now), { kind: 'switch', account: a0 })
})

test('skips accounts on cooldown', () => {
  const cooldowns = [{ agent: 'claude' as const, accountId: a1.id, until: now + 1 }]
  assert.deepEqual(pickNextAccount(accounts, a0.home, cooldowns, now), { kind: 'switch', account: a2 })
})

test('ignores expired cooldowns and other agents', () => {
  const cooldowns = [
    { agent: 'claude' as const, accountId: a1.id, until: now },
    { agent: 'codex' as const, accountId: a1.id, until: now + 10 },
  ]
  assert.deepEqual(pickNextAccount(accounts, a0.home, cooldowns, now), { kind: 'switch', account: a1 })
})

test('waits for earliest reset when all are cooling', () => {
  const cooldowns = [
    { agent: 'claude' as const, accountId: a0.id, until: now + 300 },
    { agent: 'claude' as const, accountId: a1.id, until: now + 100 },
    { agent: 'claude' as const, accountId: a2.id, until: now + 200 },
  ]
  assert.deepEqual(pickNextAccount(accounts, a0.home, cooldowns, now), { kind: 'wait', until: now + 100, account: a1 })
})

test('waits on the current account when it is the only one left', () => {
  const only = [a0, a1]
  const cooldowns = [
    { agent: 'claude' as const, accountId: a0.id, until: now + 50 },
    { agent: 'claude' as const, accountId: a1.id, until: now + 100 },
  ]
  assert.deepEqual(pickNextAccount(only, a0.home, cooldowns, now), { kind: 'wait', until: now + 50, account: a0 })
})

test('returns none when there is only one account', () => {
  assert.deepEqual(pickNextAccount([a0], a0.home, [], now), { kind: 'none' })
})

test('cooldown uses reset time plus grace', () => {
  assert.deepEqual(cooldownFor({ agent: 'claude', reason: 'session', resetsAt: now + 10 }, 'c1', now), {
    agent: 'claude',
    accountId: 'c1',
    until: now + 10 + RESET_GRACE_MS,
  })
})

test('unknown reset time uses default cooldown', () => {
  assert.equal(
    cooldownFor({ agent: 'codex', reason: 'usage', resetsAt: null }, 'x1', now).until,
    now + UNKNOWN_RESET_COOLDOWN_MS,
  )
})
