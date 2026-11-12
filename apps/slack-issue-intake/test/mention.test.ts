import { loadConfig } from '../lib/config.ts'
import { fakeGh, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SlackReply, SlackRequest } from './helpers.ts'

const GROUPS = [
  { id: 'S0DEV0001', handle: 'dev-member', name: 'Dev Member' },
  { id: 'S0OPS0001', handle: 'ops', name: 'Operations' },
]
const fixture = async (
  t: { after: (fn: () => Promise<void>) => void },
  reply: (r: SlackRequest) => SlackReply = () => ({ json: { ok: true, usergroups: GROUPS } }),
) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const server = await startSlack(reply)
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  return {
    home,
    server,
    mention: (args: string[]) => runCliAsync(['mention', ...args], env),
  }
}
test('ME1 handle（@ 付きも可）と name で usergroups.list から ID を引いて保存する', async (t) => {
  for (const group of ['@dev-member', 'Dev Member', 'DEV-MEMBER']) {
    const f = await fixture(t)
    const r = await f.mention(['--group', group])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /mention=S0DEV0001/)
    assert.deepEqual(loadConfig(f.home)?.mention, { asked: true, groupId: 'S0DEV0001', handle: 'dev-member' })
    assert.deepEqual(
      f.server.requests.map((q) => q.method),
      ['usergroups.list'],
    )
  }
})
test('ME2 S で始まる ID は一覧を呼ばずに保存し、--none は asked:true でグループ無し', async (t) => {
  const f = await fixture(t)
  const r = await f.mention(['--group', 'S0ABC12345'])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(loadConfig(f.home)?.mention, { asked: true, groupId: 'S0ABC12345', handle: null })
  assert.equal(f.server.requests.length, 0)
  const none = await f.mention(['--none'])
  assert.equal(none.code, 0, none.stderr)
  assert.match(none.stdout, /mention=none/)
  assert.deepEqual(loadConfig(f.home)?.mention, { asked: true, groupId: null, handle: null })
  assert.equal((await f.mention([])).code, 2)
})
test('ME3 missing_scope や見つからないときは exit 1 で、ID を入れる案内を出し、config を変えない', async (t) => {
  const scope = await fixture(t, () => ({ json: { ok: false, error: 'missing_scope' } }))
  const a = await scope.mention(['--group', 'dev-member'])
  assert.equal(a.code, 1)
  assert.match(a.stderr, /usergroups:read/)
  assert.match(a.stderr, /S で始まる/)
  assert.deepEqual(loadConfig(scope.home)?.mention, { asked: false, groupId: null, handle: null })
  const missing = await fixture(t)
  const b = await missing.mention(['--group', 'nobody'])
  assert.equal(b.code, 1)
  assert.match(b.stderr, /nobody/)
  assert.match(b.stderr, /S で始まる/)
  assert.equal(loadConfig(missing.home)?.mention.asked, false)
})
