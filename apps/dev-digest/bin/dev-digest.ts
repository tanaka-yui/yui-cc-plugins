import { die } from '../lib/cli.ts'

type Command = { run: (argv: string[]) => Promise<void> | void }

// サブコマンドを足すときはここに 1 行足す
const COMMANDS: Record<string, () => Promise<Command>> = {
  collect: () => import('../lib/commands/collect.ts'),
  'ingest-x': () => import('../lib/commands/ingest-x.ts'),
  pending: () => import('../lib/commands/pending.ts'),
  publish: () => import('../lib/commands/publish.ts'),
  'set-webhook': () => import('../lib/commands/set-webhook.ts'),
}

const NAME = 'dev-digest'
const [command, ...rest] = process.argv.slice(2)
const load = command === undefined || !Object.hasOwn(COMMANDS, command) ? undefined : COMMANDS[command]
if (load === undefined) {
  die(NAME, `使用法: ${NAME} <${Object.keys(COMMANDS).join('|')}> [options]`)
} else {
  await (await load()).run(rest)
}
