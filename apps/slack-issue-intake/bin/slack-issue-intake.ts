import { die, log } from '../lib/cli.ts'
import {
  ASK_NAME_OPTION,
  LAUNCHER_VERSION,
  LAUNCHER_VERSION_ENV,
  MSG_NAME_HOME_CONFLICT,
  MSG_NAME_MISSING,
  MSG_NAME_REQUIRED,
  MSG_NAME_UNREAD,
  NAME_PLACEHOLDER,
} from '../lib/defaults.ts'
import { HOME_ENV, homeForName, homeOfSlackProject, intakeNameProblem, listIntakeNames } from '../lib/paths.ts'
import { createPrompter } from '../lib/prompt.ts'
import { maskSecrets } from '../lib/secrets.ts'
import { askWorkspaceName, commandWithName, legacyHomeNotice, nameRequiredMessage } from '../lib/workspace.ts'

import { homedir } from 'node:os'
import { relative } from 'node:path'

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
  knowledge: () => import('../lib/commands/knowledge.ts'),
  mention: () => import('../lib/commands/mention.ts'),
  report: () => import('../lib/commands/report.ts'),
  relink: () => import('../lib/commands/relink.ts'),
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
let askTarget: string | null = null
if (args[0]?.startsWith(`${ASK_NAME_OPTION}=`)) {
  askTarget = args.shift()?.slice(ASK_NAME_OPTION.length + 1) ?? ''
  if (!askTarget) die(NAME, '使用法: --ask-name=<make の対象>')
}
const [command, ...rest] = args
const load = command === undefined || !Object.hasOwn(COMMANDS, command) ? undefined : COMMANDS[command]
if (load === undefined) {
  die(NAME, `使用法: ${NAME} <${Object.keys(COMMANDS).join('|')}> [options]`)
} else {
  if (!process.env[HOME_ENV] && command === 'slack-hook') {
    const home = homeOfSlackProject(process.cwd())
    if (home !== null) process.env[HOME_ENV] = home
  }
  if (!process.env[HOME_ENV]) {
    const names = listIntakeNames(homedir())
    if (askTarget !== null) {
      const name = askWorkspaceName(
        createPrompter(
          0,
          (text) => {
            process.stderr.write(text)
          },
          1,
        ),
        names,
        (text) => {
          process.stderr.write(`${text}\n`)
        },
      )
      if (name === null) {
        const example = (n: string): string => `make ${askTarget} ${n}`
        die(
          NAME,
          nameRequiredMessage(
            MSG_NAME_UNREAD.replace('{command}', example(NAME_PLACEHOLDER)),
            example,
            names,
            legacyHomeNotice(),
          ),
        )
      }
      process.env[HOME_ENV] = homeForName(name)
    } else {
      const exampleRest = rest.filter(
        (arg, index) => arg !== '--name' && !arg.startsWith('--name=') && rest[index - 1] !== '--name',
      )
      die(
        NAME,
        nameRequiredMessage(
          MSG_NAME_REQUIRED,
          (n) => commandWithName(relative(process.cwd(), process.argv[1] ?? ''), [command ?? '', ...exampleRest], n),
          names,
          legacyHomeNotice(),
        ),
      )
    }
  }
  try {
    await (await load()).run(rest)
  } catch (error) {
    log(NAME, maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}
