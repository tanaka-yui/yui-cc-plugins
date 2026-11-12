import { SLACK_CLI_FINGERPRINT } from '../lib/defaults.ts'
import { homePaths } from '../lib/paths.ts'
import { loadToken } from '../lib/secrets.ts'
import { slackProject } from '../lib/slack-cli.ts'
import { fakeSlackCli, slackCliCalls, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const probe = resolve(import.meta.dirname, 'fixtures/slack-cli-probe.ts')
const runProbe = (mode: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [probe, mode], { env: { PATH: '', ...env }, encoding: 'utf8' })

test('SC6 runDeploy は手元の SLACK_BOT_TOKEN を渡さず、フックが今のアプリのトークンを保存する', () => {
  const home = tempHome()
  const fake = fakeSlackCli(tempHome())
  const r = runProbe('deploy', { ...fake.env, SLACK_ISSUE_INTAKE_HOME: home, SLACK_BOT_TOKEN: 'xoxb-from-shell' })
  assert.equal(r.status, 0, r.stderr)
  const deploy = slackCliCalls(fake.log).find((c) => c.argv[0] === 'deploy')
  assert.ok(deploy)
  assert.equal(deploy.hadBotToken, false)
  assert.deepEqual(deploy.argv, ['deploy', '--app', 'deployed', '--skip-update'])
  assert.equal(realpathSync(deploy.cwd), realpathSync(slackProject(home).dir))
  assert.equal(loadToken(homePaths(home).secrets), 'xoxb-fake-deployed')
  assert.ok(existsSync(slackProject(home).apps))
  assert.ok(!`${r.stdout}${r.stderr}`.includes('from-shell'))
})
test('SC7 findSlackCli は差し替え、標準の場所、PATH の順に探し、PATH の slack は指紋が合うときだけ使う', () => {
  const emptyHome = tempHome()
  const fake = fakeSlackCli(tempHome())
  const base = { HOME: emptyHome }
  // (a) 差し替えあり
  assert.equal(runProbe('find', { ...base, ...fake.env }).stdout.trim(), fake.path)
  // (b) 差し替えなし。PATH の slack の指紋が違えば使わない
  const wrongDir = tempHome()
  writeFileSync(join(wrongDir, 'slack'), '#!/bin/sh\necho not-the-slack-cli\n', { mode: 0o755 })
  assert.equal(runProbe('find', { ...base, PATH: wrongDir }).stdout.trim(), 'null')
  // (c) 指紋が合う slack
  const rightDir = tempHome()
  writeFileSync(join(rightDir, 'slack'), `#!/bin/sh\necho ${SLACK_CLI_FINGERPRINT}\n`, { mode: 0o755 })
  assert.equal(runProbe('find', { ...base, PATH: rightDir }).stdout.trim(), join(rightDir, 'slack'))
  // 標準の場所は指紋を確かめずに使う
  const stdHome = tempHome()
  mkdirSync(join(stdHome, '.slack', 'bin'), { recursive: true })
  writeFileSync(join(stdHome, '.slack', 'bin', 'slack'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(runProbe('find', { HOME: stdHome }).stdout.trim(), join(stdHome, '.slack', 'bin', 'slack'))
})
