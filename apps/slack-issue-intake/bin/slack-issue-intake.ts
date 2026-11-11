import { die, log } from '../lib/cli.ts'
import { LAUNCHER_VERSION, LAUNCHER_VERSION_ENV } from '../lib/defaults.ts'
import { maskSecrets } from '../lib/secrets.ts'

type Command = { run: (argv: string[]) => Promise<void> | void }

// サブコマンドを足すときはここに 1 行足す
const COMMANDS: Record<string, () => Promise<Command>> = {
  apply: () => import('../lib/commands/apply.ts'),
  collect: () => import('../lib/commands/collect.ts'),
  procedure: () => import('../lib/commands/procedure.ts'),
  poll: () => import('../lib/commands/poll.ts'),
  'set-token': () => import('../lib/commands/set-token.ts'),
}

const NAME = 'slack-issue-intake'
// ランチャー（~/.slack-issue-intake/bin/launch.ts）は init がコピーした時点の版のまま残る。食い違えば知らせて続ける
const launched = process.env[LAUNCHER_VERSION_ENV]
if (launched !== undefined && launched !== String(LAUNCHER_VERSION)) {
  log(NAME, 'ランチャーが古い版です。init を再実行してください')
}
const [command, ...rest] = process.argv.slice(2)
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
