import { shellQuote } from './automation.ts'
import {
  MANIFEST_HASH_FILE,
  SHORTCUT_URL_PATTERN,
  SLACK_APP_DIR_SUFFIX,
  SLACK_APP_ENVIRONMENT,
  SLACK_CLI_ENV,
  SLACK_CLI_FINGERPRINT,
  SLACK_CLI_LOGGED_OUT_TEXT,
  SLACK_CLI_PROBE_TIMEOUT_MS,
  SLACK_CLI_STANDARD_PATH,
  SLACK_CLI_TRIGGER_TIMEOUT_MS,
  SLACK_HOOK_COMMAND,
  SLACK_TOKEN_ENV_NAMES,
  TRIGGER_DEF_FILE,
} from './defaults.ts'
import { renderFormManifest, triggerDefinition } from './form.ts'
import { ensurePrivateDir, readJson, writeJson } from './fs.ts'
import { asObject, asString, get } from './json.ts'
import { pluginRoot } from './paths.ts'
import { maskSecrets } from './secrets.ts'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { JsonObject } from './json.ts'

export type SlackProject = {
  dir: string
  hooks: string
  config: string
  apps: string
  triggerDef: string
  manifestHash: string
}

// Slack CLI のプロジェクトはホームの隣に置く（ホームの中に置くと、無人の Claude の作業範囲に入る）
export const slackProject = (home: string): SlackProject => {
  const dir = resolve(home) + SLACK_APP_DIR_SUFFIX
  const slack = join(dir, '.slack')
  return {
    dir,
    hooks: join(slack, 'hooks.json'),
    config: join(slack, 'config.json'),
    apps: join(slack, 'apps.json'),
    triggerDef: join(dir, TRIGGER_DEF_FILE),
    manifestHash: join(dir, MANIFEST_HASH_FILE),
  }
}

// フックは絶対パスで書く。Slack CLI はプロジェクトの cwd で実行するので PATH やランチャーに頼らない
export const hooksInterface = (): JsonObject => {
  const entry = join(pluginRoot(), 'bin', 'slack-issue-intake.ts')
  const command = (name: string): string =>
    `${shellQuote(process.execPath)} ${shellQuote(entry)} ${SLACK_HOOK_COMMAND} ${name}`
  return {
    runtime: 'node',
    hooks: { 'get-hooks': command('get-hooks'), 'get-manifest': command('get-manifest'), deploy: command('deploy') },
  }
}

// hooks.json は毎回上書きする（プラグインの更新でパスが変わるため）。
// config.json は Slack CLI が書いた項目（project_id など）を残し、manifest は local（get-manifest フック）から取る
export const writeProject = (project: SlackProject): void => {
  ensurePrivateDir(project.dir)
  ensurePrivateDir(join(project.dir, '.slack'))
  writeJson(project.hooks, hooksInterface())
  const config = asObject(readJson(project.config)) ?? {}
  writeJson(project.config, { ...config, manifest: { ...(asObject(config.manifest) ?? {}), source: 'local' } })
}

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// 差し替え、標準の場所、PATH の順。PATH の slack は同名の別物がありうるので、指紋が合うときだけ使う
export const findSlackCli = (): string | null => {
  const override = process.env[SLACK_CLI_ENV]
  if (override && executable(override)) return override
  const standard = join(homedir(), ...SLACK_CLI_STANDARD_PATH)
  if (executable(standard)) return standard
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'slack')
    if (!executable(candidate)) continue
    const probe = spawnSync(candidate, ['_fingerprint'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SLACK_CLI_PROBE_TIMEOUT_MS,
    })
    if (probe.status === 0 && probe.stdout.trim() === SLACK_CLI_FINGERPRINT) return candidate
  }
  return null
}

export const slackLoggedIn = (bin: string): boolean => {
  const r = spawnSync(bin, ['auth', 'list', '--skip-update'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SLACK_CLI_PROBE_TIMEOUT_MS,
  })
  return r.status === 0 && !`${r.stdout}${r.stderr}`.includes(SLACK_CLI_LOGGED_OUT_TEXT)
}

export const deployedApp = (project: SlackProject): { appId: string; teamId: string } | null => {
  try {
    const apps = asObject(get(JSON.parse(readFileSync(project.apps, 'utf8')), 'apps'))
    const first = apps ? Object.values(apps)[0] : undefined
    const appId = asString(get(first, 'app_id'))
    const teamId = asString(get(first, 'team_id'))
    return appId && teamId ? { appId, teamId } : null
  } catch {
    return null
  }
}

export const manifestHash = (): string => createHash('sha256').update(renderFormManifest()).digest('hex')
export const readDeployedHash = (project: SlackProject): string | null => {
  try {
    return readFileSync(project.manifestHash, 'utf8').trim() || null
  } catch {
    return null
  }
}
export const saveDeployedHash = (project: SlackProject, hash: string): void => {
  ensurePrivateDir(project.dir)
  writeFileSync(project.manifestHash, `${hash}\n`, { mode: 0o600 })
}

// 手元のトークンを deploy に渡さない。フックが今のアプリのトークンを保存する
export const deployEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SLACK_TOKEN_ENV_NAMES.includes(name)))

// Slack CLI の質問（ログインや確認）に答えられるよう、端末につなぐ
export const runDeploy = (bin: string, project: SlackProject, teamId: string | null): number => {
  const args = ['deploy', '--app', SLACK_APP_ENVIRONMENT, '--skip-update', ...(teamId ? ['--team', teamId] : [])]
  const r = spawnSync(bin, args, { cwd: project.dir, stdio: 'inherit', env: deployEnv(process.env) })
  return r.status ?? 1
}

// 既存のアプリをプロジェクトにつなぐ（apps.json に書く）。チームが分からなければ Slack CLI が端末で聞く
export const runLink = (bin: string, project: SlackProject, appId: string, teamId: string | null): number => {
  const args = [
    'app',
    'link',
    '--app',
    appId,
    '--environment',
    SLACK_APP_ENVIRONMENT,
    '--skip-update',
    ...(teamId ? ['--team', teamId] : []),
  ]
  const r = spawnSync(bin, args, { cwd: project.dir, stdio: 'inherit', env: deployEnv(process.env) })
  return r.status ?? 1
}

export const writeTriggerDef = (project: SlackProject, channel: string): void => {
  ensurePrivateDir(project.dir)
  writeJson(project.triggerDef, triggerDefinition(channel), 0o600)
}

export const parseShortcutUrl = (output: string): { triggerId: string; url: string } | null => {
  const m = SHORTCUT_URL_PATTERN.exec(output)
  return m?.[1] ? { triggerId: m[1], url: m[0] } : null
}

type CliFailure = { ok: false; error: string }
const capture = (bin: string, project: SlackProject, args: string[]): { ok: true; stdout: string } | CliFailure => {
  const r = spawnSync(bin, args, {
    cwd: project.dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: deployEnv(process.env),
    timeout: SLACK_CLI_TRIGGER_TIMEOUT_MS,
  })
  if (r.status === 0) return { ok: true, stdout: r.stdout }
  const error = [r.stderr, r.stdout, `exit ${r.status ?? 'signal'}`]
    .map((t) => maskSecrets((t ?? '').trim()))
    .find(Boolean)
  return { ok: false, error: error ?? '' }
}

export const createTrigger = (
  bin: string,
  project: SlackProject,
  teamId: string,
): { ok: true; triggerId: string; url: string } | CliFailure => {
  const r = capture(bin, project, [
    'trigger',
    'create',
    '--trigger-def',
    project.triggerDef,
    '--app',
    SLACK_APP_ENVIRONMENT,
    '--team',
    teamId,
    '--skip-update',
    '--no-color',
  ])
  if (!r.ok) return r
  const found = parseShortcutUrl(r.stdout)
  return found ? { ok: true, ...found } : { ok: false, error: 'ボタンの URL を読み取れませんでした' }
}

export const grantTriggerAccess = (
  bin: string,
  project: SlackProject,
  teamId: string,
  triggerId: string,
  channel: string,
): { ok: true } | CliFailure => {
  const r = capture(bin, project, [
    'trigger',
    'access',
    '--trigger-id',
    triggerId,
    '--channels',
    channel,
    '--grant',
    '--include-app-collaborators=false',
    '--app',
    SLACK_APP_ENVIRONMENT,
    '--team',
    teamId,
    '--skip-update',
    '--no-color',
  ])
  return r.ok ? { ok: true } : r
}
