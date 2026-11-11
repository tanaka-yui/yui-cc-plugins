import { loadConfig, saveConfig } from '../lib/config.ts'
import { writeJson } from '../lib/fs.ts'
import { homePaths } from '../lib/paths.ts'
import { applyProject, applyUserDeny, permissionFingerprint, proposedRules } from '../lib/permissions.ts'
import { NOW } from './fixtures/slack-messages.ts'
import { fakeGh, fakeOrca, orcaCalls, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const orca = fakeOrca(tempHome())
  const server = await startSlack(() => ({ json: { ok: true, messages: [] } }))
  t.after(() => server.close())
  const env = {
    ...gh.env,
    ...orca.env,
    ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })),
  }
  const ch = tempHome()
  process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = ch
  env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = ch
  const rules = proposedRules(home)
  const c = loadConfig(home)
  assert.ok(c)
  c.orca.automationId = 'auto-1'
  c.acceptedPermissions = null
  saveConfig(home, c)
  const cli = (args: string[]) => runCliAsync(args, env)
  const prepare = () => {
    applyProject(rules)
    applyUserDeny(rules)
  }
  return { home, server, orca, env, rules, cli, prepare }
}
test('EN1/EN4 起動してよい設定になる前は有効化せず、local設定も拒否', async (t) => {
  const f = await setup(t)
  assert.equal((await f.cli(['enable', '--now', NOW])).code, 1)
  assert.equal(orcaCalls(f.orca.log).length, 0)
  f.prepare()
  writeJson(homePaths(f.home).projectLocalSettings, { permissions: { defaultMode: 'bypassPermissions' } })
  assert.equal((await f.cli(['enable', '--now', NOW])).code, 1)
  assert.equal(loadConfig(f.home)?.acceptedPermissions, null)
})
test('EN2 継承した許可の一覧を見せ、明示承認時だけ有効化', async (t) => {
  const f = await setup(t)
  f.prepare()
  writeJson(f.rules.user.file, {
    permissions: { deny: f.rules.user.deny, allow: ['Bash(git status)'], additionalDirectories: ['/tmp/x'] },
  })
  const r = await f.cli(['enable', '--now', NOW])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /inherited-allow Bash\(git status\)/)
  assert.match(r.stdout, /inherited-dir \/tmp\/x/)
  assert.equal(orcaCalls(f.orca.log).length, 0)
  assert.equal((await f.cli(['enable', '--accept-inherited', '--now', NOW])).code, 0)
  assert.deepEqual(orcaCalls(f.orca.log).at(-1), ['automations', 'edit', 'auto-1', '--enabled', '--json'])
  assert.equal(loadConfig(f.home)?.acceptedPermissions, permissionFingerprint(f.home))
})
test('EN3/PG1/PG2 継承なしは承認でき、承認前のpollは通信しない', async (t) => {
  const f = await setup(t)
  f.prepare()
  const before = await f.cli(['poll', '--now', NOW])
  assert.equal(before.code, 1)
  assert.match(before.stdout, /result=permissions reason=changed/)
  assert.equal(f.server.requests.length, 0)
  assert.equal((await f.cli(['enable', '--now', NOW])).code, 0)
  assert.match((await f.cli(['poll', '--now', NOW])).stdout, /result=idle/)
})
test('PG3–PG6 承認後のallow・deny・managed・localの変化で起動停止', async (t) => {
  const f = await setup(t)
  f.prepare()
  assert.equal((await f.cli(['enable', '--now', NOW])).code, 0)
  for (const mode of ['allow', 'deny', 'remove-deny', 'managed', 'local']) {
    f.prepare()
    rmSync(`${f.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME}/managed-settings.json`, { force: true })
    rmSync(homePaths(f.home).projectLocalSettings, { force: true })
    writeJson(f.rules.user.file, { permissions: { deny: f.rules.user.deny } })
    assert.equal((await f.cli(['enable', '--now', NOW])).code, 0)
    if (mode === 'allow') writeJson(f.rules.user.file, { permissions: { deny: f.rules.user.deny, allow: ['Bash(*)'] } })
    if (mode === 'deny') writeJson(f.rules.user.file, { permissions: { deny: [...f.rules.user.deny, 'Read(/x)'] } })
    if (mode === 'remove-deny') writeJson(f.rules.user.file, { permissions: { deny: [] } })
    if (mode === 'managed')
      writeFileSync(
        `${f.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME}/managed-settings.json`,
        JSON.stringify({ permissions: { defaultMode: 'dontAsk' } }),
      )
    if (mode === 'local')
      writeJson(homePaths(f.home).projectLocalSettings, { permissions: { defaultMode: 'bypassPermissions' } })
    const n = f.server.requests.length
    const r = await f.cli(['poll', '--now', NOW])
    assert.equal(r.code, 1)
    assert.match(
      r.stdout,
      new RegExp(`result=permissions reason=${['remove-deny', 'local'].includes(mode) ? 'unsafe' : 'changed'}`),
    )
    assert.equal(f.server.requests.length, n)
  }
})
