import { SLACK_CLI_FINGERPRINT, SLACK_CLI_LOGGED_OUT_TEXT } from '../../lib/defaults.ts'
import { asObject, asString, get, parseJson } from '../../lib/json.ts'

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? ''
const cmd = args.slice(0, 2).join(' ')
const log = process.env.FAKE_SLACK_CLI_LOG ?? ''
const team = process.env.FAKE_SLACK_CLI_TEAM ?? 'T0FAKE001'
const triggerDef = args.includes('--trigger-def') ? readFileSync(value('--trigger-def'), 'utf8') : undefined
const record = (): void =>
  appendFileSync(
    log,
    `${JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      hadBotToken: Boolean(process.env.SLACK_BOT_TOKEN),
      ...(triggerDef === undefined ? {} : { triggerDef: parseJson(triggerDef) }),
    })}\n`,
  )
const hook = (name: string): string => {
  const hooks = parseJson(readFileSync(join('.slack', 'hooks.json'), 'utf8'))
  return asString(get(hooks, 'hooks', name)) ?? ''
}

if (args[0] === '_fingerprint') {
  console.log(SLACK_CLI_FINGERPRINT)
} else if (cmd === 'auth list') {
  record()
  console.log(process.env.FAKE_SLACK_CLI_LOGGED_OUT ? SLACK_CLI_LOGGED_OUT_TEXT : `acme ${team}`)
} else if (args[0] === 'deploy') {
  record()
  if (process.env.FAKE_SLACK_CLI_DEPLOY_FAIL) {
    console.error('manifest rejected')
    process.exit(1)
  }
  const manifest = spawnSync('/bin/sh', ['-c', hook('get-manifest')], { encoding: 'utf8' })
  if (manifest.status !== 0 || parseJson(manifest.stdout) === null) {
    console.error('get-manifest failed')
    process.exit(1)
  }
  const existing = existsSync('.slack/apps.json') ? parseJson(readFileSync('.slack/apps.json', 'utf8')) : null
  const known = asObject(get(existing ?? undefined, 'apps')) ?? {}
  const appId = asString(get(Object.values(known)[0], 'app_id')) ?? 'A0FAKE001'
  mkdirSync('.slack', { recursive: true })
  writeFileSync('.slack/apps.json', JSON.stringify({ apps: { [appId]: { app_id: appId, team_id: team } } }))
  const env = { ...process.env }
  if (process.env.FAKE_SLACK_CLI_NO_TOKEN) delete env.SLACK_BOT_TOKEN
  else env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-fake-deployed'
  const deployed = spawnSync('/bin/sh', ['-c', hook('deploy')], { env, stdio: 'inherit' })
  process.exit(deployed.status ?? 1)
} else if (cmd === 'trigger create') {
  record()
  if (process.env.FAKE_SLACK_CLI_TRIGGER_FAIL) {
    console.error(process.env.FAKE_SLACK_CLI_TRIGGER_FAIL)
    process.exit(1)
  }
  console.log('Trigger successfully created!\n   https://slack.com/shortcuts/Ft0FAKE001/abc123')
} else if (cmd === 'trigger access') {
  record()
} else {
  record()
  process.exit(1)
}
