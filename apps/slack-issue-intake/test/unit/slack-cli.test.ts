import { FORM_KINDS } from '../../lib/defaults.ts'
import { asObject, get, parseJson } from '../../lib/json.ts'
import { pluginRoot } from '../../lib/paths.ts'
import {
  createTrigger,
  deleteTrigger,
  deployEnv,
  deployedApp,
  grantTriggerAccess,
  parseShortcutUrl,
  slackProject,
  triggerDefPath,
  writeProject,
  writeTriggerDef,
} from '../../lib/slack-cli.ts'
import { fakeSlackCli, runCli, slackCliCalls, tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('SC1 parseShortcutUrl は前後の行があっても URL とボタンの ID を取り出し、無ければ null', () => {
  const out =
    '⚡ Trigger successfully created!\n   Issue を起票 Ft0ABC123 (shortcut)\n   https://slack.com/shortcuts/Ft0ABC123/0a1b2c\n'
  assert.deepEqual(parseShortcutUrl(out), {
    triggerId: 'Ft0ABC123',
    url: 'https://slack.com/shortcuts/Ft0ABC123/0a1b2c',
  })
  assert.equal(parseShortcutUrl('no url'), null)
})
test('SC2 deployEnv はトークンの環境変数だけを取り除く', () => {
  const env = deployEnv({
    PATH: '/bin',
    SLACK_BOT_TOKEN: 'xoxb-1',
    SLACK_APP_TOKEN: 'xapp-1',
    SLACK_USER_TOKEN: 'xoxp-1',
    SLACK_ISSUE_INTAKE_HOME: '/h',
  })
  assert.deepEqual(env, { PATH: '/bin', SLACK_ISSUE_INTAKE_HOME: '/h' })
})
test('SC3 Slack CLI のプロジェクトはホームの隣に置き、ホームの中には置かない', () => {
  const p = slackProject('/x/.slack-issue-intake/')
  assert.equal(p.dir, '/x/.slack-issue-intake-slack-app')
  assert.equal(p.apps, '/x/.slack-issue-intake-slack-app/.slack/apps.json')
  assert.equal(p.hooks, '/x/.slack-issue-intake-slack-app/.slack/hooks.json')
  assert.deepEqual(
    FORM_KINDS.map((k) => triggerDefPath(p, k)),
    ['bug', 'request', 'feature'].map((k) => `/x/.slack-issue-intake-slack-app/form-trigger-${k}.json`),
  )
  assert.equal(p.manifestHash, '/x/.slack-issue-intake-slack-app/manifest.sha256')
})
test('SC4 hooks.json は絶対パスのフックを書き、get-hooks の出力と同じになる', () => {
  const p = slackProject(tempHome())
  writeProject(p)
  const written = parseJson(readFileSync(p.hooks, 'utf8'))
  const deploy = String(get(written, 'hooks', 'deploy'))
  assert.ok(deploy.includes(process.execPath))
  assert.ok(deploy.includes(join(pluginRoot(), 'bin', 'slack-issue-intake.ts')))
  assert.ok(deploy.includes('slack-hook deploy'))
  assert.deepEqual(written, parseJson(runCli(['slack-hook', 'get-hooks'], {}).stdout))
  assert.deepEqual(parseJson(readFileSync(p.config, 'utf8')), { manifest: { source: 'local' } })
  assert.equal(statSync(p.dir).mode & 0o777, 0o700)
})
test('SC4b config.json は Slack CLI が書いた項目を残し、manifest.source だけを local にする', () => {
  const p = slackProject(tempHome())
  writeProject(p)
  writeFileSync(p.config, JSON.stringify({ project_id: 'P-1', manifest: { source: 'remote', extra: 1 } }))
  writeProject(p)
  assert.deepEqual(parseJson(readFileSync(p.config, 'utf8')), {
    project_id: 'P-1',
    manifest: { source: 'local', extra: 1 },
  })
  writeFileSync(p.config, 'not json')
  writeProject(p)
  assert.deepEqual(parseJson(readFileSync(p.config, 'utf8')), { manifest: { source: 'local' } })
})
test('SC5 deployedApp は apps.json のアプリを返し、無いか壊れていれば null', () => {
  const p = slackProject(tempHome())
  assert.equal(deployedApp(p), null)
  mkdirSync(join(p.dir, '.slack'), { recursive: true })
  writeFileSync(p.apps, '{broken')
  assert.equal(deployedApp(p), null)
  writeFileSync(p.apps, JSON.stringify({ apps: { A0X: { app_id: 'A0X', team_id: 'T0X' } } }))
  assert.deepEqual(deployedApp(p), { appId: 'A0X', teamId: 'T0X' })
  assert.equal(asObject(get(parseJson(readFileSync(p.apps, 'utf8')) ?? undefined, 'apps')) !== null, true)
})
test('SC6 createTrigger / grantTriggerAccess / deleteTrigger は決まった引数で Slack CLI を呼び、失敗は理由を返す', () => {
  const dir = tempHome()
  const cli = fakeSlackCli(dir)
  process.env.FAKE_SLACK_CLI_LOG = cli.log
  const p = slackProject(tempHome())
  writeProject(p)
  const kind = FORM_KINDS[0]
  if (!kind) throw new Error('no form kind')
  const defPath = writeTriggerDef(p, 'C0TARGET01', kind)
  assert.equal(defPath, triggerDefPath(p, kind))
  const created = createTrigger(cli.path, p, 'T0TEAM001', defPath)
  assert.deepEqual(created, {
    ok: true,
    triggerId: 'Ft0FAKEBUG',
    url: 'https://slack.com/shortcuts/Ft0FAKEBUG/abc123',
  })
  assert.deepEqual(grantTriggerAccess(cli.path, p, 'T0TEAM001', 'Ft0FAKEBUG', 'C0TARGET01'), { ok: true })
  assert.deepEqual(deleteTrigger(cli.path, p, 'T0TEAM001', 'Ft0FAKEFOR'), { ok: true })
  const [create, access, remove] = slackCliCalls(cli.log)
  assert.deepEqual(create?.argv, [
    'trigger',
    'create',
    '--trigger-def',
    defPath,
    '--app',
    'deployed',
    '--team',
    'T0TEAM001',
    '--skip-update',
    '--no-color',
  ])
  assert.deepEqual(access?.argv, [
    'trigger',
    'access',
    '--trigger-id',
    'Ft0FAKEBUG',
    '--channels',
    'C0TARGET01',
    '--grant',
    '--include-app-collaborators=false',
    '--app',
    'deployed',
    '--team',
    'T0TEAM001',
    '--skip-update',
    '--no-color',
  ])
  assert.deepEqual(remove?.argv, [
    'trigger',
    'delete',
    '--trigger-id',
    'Ft0FAKEFOR',
    '--app',
    'deployed',
    '--team',
    'T0TEAM001',
    '--skip-update',
    '--no-color',
  ])
  process.env.FAKE_SLACK_CLI_TRIGGER_FAIL = 'boom'
  process.env.FAKE_SLACK_CLI_DELETE_FAIL = 'gone'
  try {
    const failed = createTrigger(cli.path, p, 'T0TEAM001', defPath)
    assert.deepEqual(failed, { ok: false, error: 'boom' })
    assert.deepEqual(deleteTrigger(cli.path, p, 'T0TEAM001', 'Ft0FAKEFOR'), { ok: false, error: 'gone' })
  } finally {
    delete process.env.FAKE_SLACK_CLI_TRIGGER_FAIL
    delete process.env.FAKE_SLACK_CLI_DELETE_FAIL
    delete process.env.FAKE_SLACK_CLI_LOG
  }
})
