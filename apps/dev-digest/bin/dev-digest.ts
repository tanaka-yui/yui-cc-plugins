import { die, log } from '../lib/cli.ts'
import { LAUNCHER_VERSION, LAUNCHER_VERSION_ENV } from '../lib/defaults.ts'

type Command = { run: (argv: string[]) => Promise<void> | void }

// サブコマンドを足すときはここに 1 行足す
const COMMANDS: Record<string, () => Promise<Command>> = {
  collect: () => import('../lib/commands/collect.ts'),
  init: () => import('../lib/commands/init.ts'),
  'ingest-x': () => import('../lib/commands/ingest-x.ts'),
  pending: () => import('../lib/commands/pending.ts'),
  permissions: () => import('../lib/commands/permissions.ts'),
  procedure: () => import('../lib/commands/procedure.ts'),
  publish: () => import('../lib/commands/publish.ts'),
  'set-webhook': () => import('../lib/commands/set-webhook.ts'),
}

const NAME = 'dev-digest'
// ランチャー（~/.dev-digest/bin/launch.ts）は init がコピーした時点の版のまま残る。食い違えば知らせて続ける
const launched = process.env[LAUNCHER_VERSION_ENV]
if (launched !== undefined && launched !== String(LAUNCHER_VERSION)) {
  log(NAME, 'ランチャーが古い版です。init を再実行してください')
}
const [command, ...rest] = process.argv.slice(2)
const load = command === undefined || !Object.hasOwn(COMMANDS, command) ? undefined : COMMANDS[command]
if (load === undefined) {
  die(NAME, `使用法: ${NAME} <${Object.keys(COMMANDS).join('|')}> [options]`)
} else {
  await (await load()).run(rest)
}
