import { loadConfig, saveConfig } from '../lib/config.ts'
import { getMeta, openDb } from '../lib/db.ts'
import { acquireLease, readLease } from '../lib/lease.ts'
import { homePaths } from '../lib/paths.ts'
import { saveToken } from '../lib/secrets.ts'
import { BOT_ID, BOT_USER, CHANNEL, NOW, NOW_SEC, TEAM_ID, TEAM_URL } from './fixtures/slack-messages.ts'
import { fakeGh, fakeOrca, ghCalls, orcaCalls, runCli, runCliAsync, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'

import type { SlackReply } from './helpers.ts'

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const orca = fakeOrca(tempHome())
  let team = TEAM_ID
  const slack = await startSlack(
    (r): SlackReply =>
      r.method === 'auth.test'
        ? { json: { ok: true, user_id: BOT_USER, bot_id: BOT_ID, team_id: team, url: TEAM_URL, team: 'acme' } }
        : { json: { ok: true, messages: [] } },
  )
  t.after(() => slack.close())
  saveToken(homePaths(home).secrets, 'xoxb-test-token')
  const env = {
    SLACK_ISSUE_INTAKE_HOME: home,
    SLACK_ISSUE_INTAKE_API_BASE: slack.url,
    ...gh.env,
    ...orca.env,
    PATH: `${dirname(gh.ghPath)}:${process.env.PATH}`,
  }
  const init = (args: string[] = [], extra: Record<string, string> = {}) =>
    runCliAsync(['init', '--channel', CHANNEL, '--repo', 'acme/app', '--now', NOW, ...args], { ...env, ...extra })
  return {
    home,
    gh,
    orca,
    slack,
    env,
    init,
    changeTeam: () => {
      team = 'TOTHER'
    },
  }
}
test('IN1 dry-runは通信も書き込みもせずargvだけを表示', () => {
  const home = tempHome()
  const r = runCli(['init', '--channel', CHANNEL, '--repo', 'acme/app', '--dry-run'], { SLACK_ISSUE_INTAKE_HOME: home })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout.split('\n')[1] ?? '', /orca: automations create .*--disabled.*--precheck/)
  assert.deepEqual(readdirSync(home), [])
})
test('IN2/IN3 初回は無効登録と受付境界を作り、再実行で境界・有効状態を保つ', async (t) => {
  const f = await setup(t)
  const r = await f.init([], { FAKE_GH_LABELS: 'bug' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /automation=auto-1 \(created\)/)
  const c = loadConfig(f.home)
  assert.equal(c?.github.login, 'intake-bot')
  assert.equal(c?.slack.botUserId, BOT_USER)
  assert.equal(c?.acceptedPermissions, null)
  const paths = homePaths(f.home)
  assert.equal(statSync(paths.launcher).mode & 0o777, 0o755)
  const db = openDb(paths.db)
  assert.equal(getMeta(db, 'accept_after_ts'), `${NOW_SEC}.000000`)
  assert.equal(getMeta(db, 'cursor_ts'), `${NOW_SEC}.000000`)
  assert.equal(readLease(db), null)
  db.close()
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv.slice(0, 2).join(' ') === 'label create').length, 7)
  assert.ok(orcaCalls(f.orca.log)[1]?.includes('--disabled'))
  const again = await f.init(['--every', '10'])
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /updated/)
  const last = orcaCalls(f.orca.log).at(-1) ?? []
  assert.ok(last.includes('edit'))
  assert.ok(!last.includes('--disabled') && !last.includes('--enabled'))
  assert.equal(loadConfig(f.home)?.everyMinutes, 10)
})
test('IN4/IN5/IN6 公開repo・トークン・フラグの検査を副作用前に行う', async (t) => {
  const f = await setup(t)
  const r = await f.init([], { FAKE_GH_VISIBILITY: 'PUBLIC' })
  assert.equal(r.code, 1)
  assert.ok(!existsSync(homePaths(f.home).config))
  assert.equal(orcaCalls(f.orca.log).length, 0)
  assert.equal(ghCalls(f.gh.log).filter((c) => c.argv[0] === 'label').length, 0)
  assert.equal((await f.init(['--allow-public'], { FAKE_GH_VISIBILITY: 'PUBLIC' })).code, 0)
  for (const args of [
    ['--channel', 'x', '--repo', 'a/b'],
    ['--channel', CHANNEL, '--repo', 'bad'],
    ['--channel', CHANNEL, '--repo', 'a/b', '--every', '7'],
  ])
    assert.equal(runCli(['init', ...args], { SLACK_ISSUE_INTAKE_HOME: tempHome() }).code, 2)
  assert.equal(runCli(['init', '--channel', CHANNEL, '--repo', 'a/b'], { SLACK_ISSUE_INTAKE_HOME: tempHome() }).code, 2)
})
test('IN7 Orca失敗時は設定を保ち、再実行で完了', async (t) => {
  const f = await setup(t)
  assert.equal((await f.init([], { FAKE_ORCA_CREATE: 'fail' })).code, 1)
  assert.ok(loadConfig(f.home))
  assert.equal((await f.init()).code, 0)
})
test('IN8 送り先・ワークスペース・アカウントを変更しない', async (t) => {
  const f = await setup(t)
  assert.equal((await f.init()).code, 0)
  const before = readFileSync(homePaths(f.home).config, 'utf8')
  for (const args of [
    ['--channel', 'C0999999999'],
    ['--repo', 'acme/other'],
  ])
    assert.equal((await f.init(args)).code, 1)
  assert.equal(readFileSync(homePaths(f.home).config, 'utf8'), before)
  assert.equal((await f.init([], { FAKE_GH_LOGIN: 'someone' })).code, 1)
  f.changeTeam()
  assert.equal((await f.init()).code, 1)
  assert.equal(readFileSync(homePaths(f.home).config, 'utf8'), before)
})
test('IN9 稼働中のリースがあれば設定を更新しない', async (t) => {
  const f = await setup(t)
  assert.equal((await f.init()).code, 0)
  const c = loadConfig(f.home)
  assert.ok(c)
  saveConfig(f.home, c)
  const db = openDb(homePaths(f.home).db)
  acquireLease(db, 'run', 'r', new Date(NOW), 100000)
  db.close()
  assert.equal((await f.init(['--every', '10'])).code, 1)
  assert.equal(loadConfig(f.home)?.everyMinutes, 5)
})
