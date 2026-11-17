import { die, log } from '../lib/cli.ts'
import { LAUNCHER_VERSION, LAUNCHER_VERSION_ENV, MSG_NAME_HOME_CONFLICT, MSG_NAME_MISSING } from '../lib/defaults.ts'
import { HOME_ENV, homeForName, intakeNameProblem } from '../lib/paths.ts'
import { maskSecrets } from '../lib/secrets.ts'

type Command = { run: (argv: string[]) => Promise<void> | void }

// サブコマンドを足すときはここに 1 行足す
const COMMANDS: Record<string, () => Promise<Command>> = {
  setup: () => import('../lib/commands/setup.ts'),
  permissions: () => import('../lib/commands/permissions.ts'),
  enable: () => import('../lib/commands/enable.ts'),
  status: () => import('../lib/commands/status.ts'),
  retry: () => import('../lib/commands/retry.ts'),
  inspect: () => import('../lib/commands/inspect.ts'),
  init: () => import('../lib/commands/init.ts'),
  guide: () => import('../lib/commands/guide.ts'),
  form: () => import('../lib/commands/form.ts'),
  mention: () => import('../lib/commands/mention.ts'),
  report: () => import('../lib/commands/report.ts'),
  apply: () => import('../lib/commands/apply.ts'),
  collect: () => import('../lib/commands/collect.ts'),
  procedure: () => import('../lib/commands/procedure.ts'),
  poll: () => import('../lib/commands/poll.ts'),
  'slack-hook': () => import('../lib/commands/slack-hook.ts'),
  'set-token': () => import('../lib/commands/set-token.ts'),
}

const NAME = 'slack-issue-intake'
// ランチャー（~/.slack-issue-intake/bin/launch.ts）は init がコピーした時点の版のまま残る。食い違えば知らせて続ける
const launched = process.env[LAUNCHER_VERSION_ENV]
if (launched !== undefined && launched !== String(LAUNCHER_VERSION)) {
  log(NAME, 'ランチャーが古い版です。init を再実行してください')
}
const args = process.argv.slice(2)
if (args[0] === '--name' || args[0]?.startsWith('--name=')) {
  const option = args.shift()
  const name = (option === '--name' ? args.shift() : option?.slice('--name='.length)) ?? die(NAME, MSG_NAME_MISSING)
  const problem = intakeNameProblem(name)
  if (problem !== null) die(NAME, problem)
  if (process.env[HOME_ENV]) die(NAME, MSG_NAME_HOME_CONFLICT)
  process.env[HOME_ENV] = homeForName(name)
}
const [command, ...rest] = args
const load = command === undefined || !Object.hasOwn(COMMANDS, command) ? undefined : COMMANDS[command]
if (load === undefined) {
  die(NAME, `使用法: ${NAME} <${Object.keys(COMMANDS).join('|')}> [options]`)
} else {
  try {
    await (await load()).run(rest)
  } catch (error) {
    log(NAME, maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}
