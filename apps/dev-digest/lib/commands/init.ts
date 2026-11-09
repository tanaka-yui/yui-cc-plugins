import { die, log, parseFlags } from '../cli.ts'
import { loadConfig, saveConfig } from '../config.ts'
import { openDb } from '../db.ts'
import {
  AUTOMATION_NAME,
  AUTOMATION_PROMPT,
  AUTOMATION_PROVIDER,
  DEFAULT_TIMEZONE,
  LAUNCHER_FILE_MODE,
} from '../defaults.ts'
import { asArray, asString, get } from '../json.ts'
import { orcaArgv, runOrca } from '../orca.ts'
import { digestHome, HOME_DIRNAME, homePaths, pluginRoot } from '../paths.ts'
import { loadSecrets, webhookFor } from '../secrets.ts'
import { parseSeverity } from '../severity.ts'

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '../config.ts'
import type { HomePaths } from '../paths.ts'

const NAME = 'dev-digest init'
const DIR_MODE = 0o700
const EXIT_FAILED = 1
const NONE = 'none'
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
// 初回はすべて要る。2 回目以降は指定したものだけ更新する
const FLAGS = ['time', 'trigger', 'jvn-min-severity', 'x-list', 'x-hashtags', 'devto-tags'] as const
// AUTOMATION_PROMPT に書いた `~/.dev-digest` を実パスに置き換える
const PROMPT_HOME = `~/${HOME_DIRNAME}`

type Flags = Partial<Record<(typeof FLAGS)[number], string>>

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

const parseTrigger = (value: string): Config['schedule']['trigger'] =>
  value === 'daily' || value === 'weekdays'
    ? value
    : die(NAME, `--trigger は daily か weekdays にしてください: ${value}`)

const parseListUrl = (value: string): string | null => {
  if (value === NONE) return null
  return URL.canParse(value) ? value : die(NAME, `--x-list は URL か ${NONE} にしてください: ${value}`)
}

// 既存の設定に指定分を重ねる。orca の id は保ち、pluginRoot はいつも今のプラグインにする
const buildConfig = (flags: Flags, base: Config | null): Config => {
  if (base === null) {
    const missing = FLAGS.filter((flag) => flags[flag] === undefined)
    if (missing.length > 0) die(NAME, `初回は ${missing.map((flag) => `--${flag}`).join(' ')} を指定してください`)
  }
  const pick = <T>(flag: (typeof FLAGS)[number], parse: (value: string) => T, current: T | undefined): T => {
    const value = flags[flag]
    if (value !== undefined) return parse(value)
    return current === undefined ? die(NAME, `--${flag} を指定してください`) : current
  }
  const time = pick(
    'time',
    (v) => (TIME_PATTERN.test(v) ? v : die(NAME, `--time は HH:MM にしてください: ${v}`)),
    base?.schedule.time,
  )
  return {
    version: 1,
    schedule: {
      trigger: pick('trigger', parseTrigger, base?.schedule.trigger),
      time,
      timezone: base?.schedule.timezone ?? DEFAULT_TIMEZONE,
    },
    jvnMinSeverity: pick(
      'jvn-min-severity',
      (v) => parseSeverity(v) ?? die(NAME, `--jvn-min-severity は low|medium|high|critical にしてください: ${v}`),
      base?.jvnMinSeverity,
    ),
    devtoTags: pick('devto-tags', csv, base?.devtoTags),
    x: {
      listUrl: pick('x-list', parseListUrl, base?.x.listUrl),
      hashtags: pick('x-hashtags', csv, base?.x.hashtags),
    },
    orca: base?.orca ?? { workspaceSelector: null, automationId: null },
    pluginRoot: pluginRoot(),
  }
}

// --dry-run で argv を読める形にする（空白や引用符を含むものだけ JSON の文字列にする）
const quote = (arg: string): string => (/^[\w@%+=:,./#-]+$/.test(arg) ? arg : JSON.stringify(arg))

const automationArgs = (config: Config, selector: string, prompt: string): string[] => {
  const schedule = ['--trigger', config.schedule.trigger, '--time', config.schedule.time]
  const timezone = ['--timezone', config.schedule.timezone]
  const id = config.orca.automationId
  if (id !== null) return ['automations', 'edit', id, ...schedule, ...timezone, '--prompt', prompt]
  return [
    'automations',
    'create',
    '--name',
    AUTOMATION_NAME,
    ...schedule,
    ...timezone,
    '--provider',
    AUTOMATION_PROVIDER,
    '--workspace',
    selector,
    '--fresh-session',
    '--enabled',
    '--prompt',
    prompt,
  ]
}

const repoAddArgs = (runDir: string): string[] => ['repo', 'add', '--path', runDir, '--kind', 'folder']

// repo add は冪等（spec §13）。登録済みの失敗が返る版に備えて、repo list に path があれば登録済みとみなす
const registerRunDir = (runDir: string): string | null => {
  const added = runOrca(repoAddArgs(runDir))
  if (added.ok && asString(get(added.json ?? undefined, 'result', 'repo', 'id'))) return null
  const listed = runOrca(['repo', 'list'])
  const repos = asArray(get(listed.json ?? undefined, 'result', 'repos')) ?? []
  if (listed.ok && repos.some((repo) => get(repo, 'path') === runDir)) return null
  return `orca repo add に失敗しました: ${added.stderr.trim() || listed.stderr.trim()}`
}

// ランチャーの本体をコピーし、安定パスの sh を置く
const installLauncher = (paths: HomePaths): void => {
  copyFileSync(join(pluginRoot(), 'bin', 'launch.ts'), paths.launcherScript)
  writeFileSync(paths.launcher, `#!/bin/sh\nexec node "${paths.launcherScript}" "$@"\n`, { mode: LAUNCHER_FILE_MODE })
  chmodSync(paths.launcher, LAUNCHER_FILE_MODE)
}

// runDir を Orca に登録し、automation を作るか更新する。id は得たその場で config に残す。失敗は理由を返す
const registerOrca = (home: string, config: Config, selector: string, prompt: string, out: string[]): string | null => {
  const registerError = registerRunDir(homePaths(home).runDir)
  if (registerError !== null) return registerError
  config.orca.workspaceSelector = selector
  saveConfig(home, config)
  out.push(`workspace=${selector}`)

  const existing = config.orca.automationId
  const result = runOrca(automationArgs(config, selector, prompt))
  if (!result.ok) {
    const action = existing === null ? 'create' : `edit ${existing}`
    return `orca automations ${action} に失敗しました: ${result.stderr.trim()}`
  }
  if (existing === null) {
    const id = asString(get(result.json ?? undefined, 'result', 'automation', 'id'))
    if (!id) return 'orca automations create の応答に result.automation.id がありません'
    config.orca.automationId = id
    saveConfig(home, config)
  }
  out.push(`automation=${config.orca.automationId} (${existing === null ? 'created' : 'updated'})`)
  return null
}

export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: {
      time: { type: 'string' },
      trigger: { type: 'string' },
      'jvn-min-severity': { type: 'string' },
      'x-list': { type: 'string' },
      'x-hashtags': { type: 'string' },
      'devto-tags': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  const home = digestHome()
  const paths = homePaths(home)
  const config = buildConfig(values, loadConfig(home))
  const selector = `path:${paths.runDir}`
  const prompt = AUTOMATION_PROMPT.replaceAll(PROMPT_HOME, home)

  // --dry-run は何も書かず Orca も呼ばない。呼ぶはずの argv だけを出す
  if (values['dry-run']) {
    const calls = [repoAddArgs(paths.runDir), automationArgs(config, selector, prompt)]
    process.stdout.write(calls.map((args) => `orca: ${orcaArgv(args).map(quote).join(' ')}\n`).join(''))
    return
  }

  for (const dir of [home, paths.binDir, paths.reposDir, paths.runDir]) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  }
  saveConfig(home, config)
  openDb(paths.db).close()
  installLauncher(paths)

  const out = [`config=${paths.config}`, `launcher=${paths.launcher}`]
  const error = registerOrca(home, config, selector, prompt, out)
  // Webhook は登録の有無だけを出す（値は読み出して比べるだけで、どこにも書かない）
  out.push(`webhook_global=${webhookFor(loadSecrets(paths.secrets), null) === null ? 'missing' : 'registered'}`)
  process.stdout.write(`${out.join('\n')}\n`)
  if (error !== null) {
    log(NAME, error)
    process.exitCode = EXIT_FAILED
  }
}
