import { loadConfig } from '../lib/config.ts'
import { homePaths } from '../lib/paths.ts'
import { saveWebhook } from '../lib/secrets.ts'
import { runCli, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const APP_ROOT = join(import.meta.dirname, '..')
const FAKE_ORCA = join(import.meta.dirname, 'fixtures', 'fake-orca.ts')
const URL_SECRET = 'https://hooks.slack.com/services/T0/B0/secret-tail'
const INIT_ARGS = [
  'init',
  '--time',
  '07:30',
  '--trigger',
  'weekdays',
  '--jvn-min-severity',
  'critical',
  '--x-list',
  'https://x.com/i/lists/1',
  '--x-hashtags',
  '#AI,#LLM',
  '--devto-tags',
  'aws,ai',
]

type Setup = { home: string; claudeHome: string; orcaLog: string; env: Record<string, string> }

// 本物の ~/.claude と ~/.dev-digest に触れないよう、両方を一時ディレクトリに向ける
const setup = (): Setup => {
  const home = tempHome()
  const work = tempHome()
  dirs.push(home, work)
  const claudeHome = join(work, 'claude')
  mkdirSync(claudeHome)
  const orcaLog = join(work, 'orca.log')
  const orca = join(work, 'orca')
  writeFileSync(orca, `#!/bin/sh\nexec node "${FAKE_ORCA}" "$@"\n`, { mode: 0o755 })
  return {
    home,
    claudeHome,
    orcaLog,
    env: {
      DEV_DIGEST_HOME: home,
      DEV_DIGEST_CLAUDE_HOME: claudeHome,
      ORCA_BIN: orca,
      FAKE_ORCA_LOG: orcaLog,
      FAKE_ORCA_REPO_PATH: homePaths(home).runDir,
    },
  }
}

const orcaCalls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : []

const flagValue = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

test('IN1 init は設定・ランチャー・workspace・automation を作る', () => {
  const { home, orcaLog, env } = setup()
  const paths = homePaths(home)
  const result = runCli(INIT_ARGS, env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`^config=${paths.config}$`, 'm'))
  assert.match(result.stdout, new RegExp(`^launcher=${paths.launcher}$`, 'm'))
  assert.match(result.stdout, new RegExp(`^workspace=path:${paths.runDir}$`, 'm'))
  assert.match(result.stdout, /^automation=auto-1 \(created\)$/m)
  assert.match(result.stdout, /^webhook_global=missing$/m)

  assert.ok((statSync(paths.launcher).mode & 0o111) !== 0, 'launcher is executable')
  // init を走らせた node の絶対パスを焼き込み、実行できなければ PATH の node に落ちる
  const script = readFileSync(paths.launcher, 'utf8')
  const nodePath = /^NODE="(\/[^"]+)"$/m.exec(script)?.[1] ?? ''
  assert.ok((statSync(nodePath).mode & 0o111) !== 0, script)
  assert.equal(
    script,
    `#!/bin/sh\nNODE="${nodePath}"\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" "${paths.launcherScript}" "$@"\n`,
  )
  assert.ok(paths.launcherScript.endsWith('.mts'))
  assert.equal(readFileSync(paths.launcherScript, 'utf8'), readFileSync(join(APP_ROOT, 'bin', 'launch.ts'), 'utf8'))
  assert.ok(existsSync(paths.db))
  assert.ok(existsSync(paths.runDir))

  const config = loadConfig(home)
  assert.ok(config !== null)
  assert.equal(config.orca.workspaceSelector, `path:${paths.runDir}`)
  assert.equal(config.orca.automationId, 'auto-1')
  assert.equal(config.pluginRoot, APP_ROOT)
  assert.deepEqual(config.schedule, { trigger: 'weekdays', time: '07:30', timezone: 'Asia/Tokyo' })
  assert.equal(config.jvnMinSeverity, 'critical')
  assert.deepEqual(config.x, { listUrl: 'https://x.com/i/lists/1', hashtags: ['#AI', '#LLM'] })
  assert.deepEqual(config.devtoTags, ['aws', 'ai'])

  const calls = orcaCalls(orcaLog)
  const repoAdd = calls.find((args) => args[0] === 'repo' && args[1] === 'add')
  assert.deepEqual(repoAdd, ['repo', 'add', '--path', paths.runDir, '--kind', 'folder', '--json'])
  const create = calls.find((args) => args[0] === 'automations' && args[1] === 'create')
  assert.ok(create !== undefined)
  assert.equal(flagValue(create, '--timezone'), 'Asia/Tokyo')
  assert.equal(flagValue(create, '--provider'), 'claude')
  assert.equal(flagValue(create, '--workspace'), `path:${paths.runDir}`)
  assert.equal(flagValue(create, '--trigger'), 'weekdays')
  assert.equal(flagValue(create, '--time'), '07:30')
  assert.ok(create.includes('--fresh-session'))
  assert.ok(create.includes('--enabled'))
})

test('IN1b repo add が登録済みで失敗しても repo list から path で引いて続ける', () => {
  const { home, orcaLog, env } = setup()
  const result = runCli(INIT_ARGS, { ...env, FAKE_ORCA_REPO_ADD: 'exists' })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(orcaCalls(orcaLog).some((args) => args[0] === 'repo' && args[1] === 'list'))
  assert.equal(loadConfig(home)?.orca.workspaceSelector, `path:${homePaths(home).runDir}`)
})

test('IN1c 初回の init は全部のフラグを要する', () => {
  const { home, orcaLog, env } = setup()
  const result = runCli(['init', '--time', '07:30'], env)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--trigger/)
  assert.equal(loadConfig(home), null)
  assert.deepEqual(orcaCalls(orcaLog), [])
})

test('IN2 2 回目の init は edit になり create しない', () => {
  const { home, orcaLog, env } = setup()
  assert.equal(runCli(INIT_ARGS, env).code, 0)
  const result = runCli(['init', '--time', '09:15'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^automation=auto-1 \(updated\)$/m)

  const calls = orcaCalls(orcaLog)
  assert.equal(calls.filter((args) => args[0] === 'automations' && args[1] === 'create').length, 1)
  const edit = calls.find((args) => args[0] === 'automations' && args[1] === 'edit')
  assert.ok(edit !== undefined)
  assert.equal(edit[2], 'auto-1')
  assert.equal(flagValue(edit, '--time'), '09:15')
  assert.equal(flagValue(edit, '--trigger'), 'weekdays')
  assert.equal(flagValue(edit, '--timezone'), 'Asia/Tokyo')
  assert.equal(flagValue(edit, '--workspace'), `path:${homePaths(home).runDir}`)

  // 指定しなかったものと Orca の id は保つ
  const config = loadConfig(home)
  assert.ok(config !== null)
  assert.equal(config.schedule.time, '09:15')
  assert.equal(config.schedule.trigger, 'weekdays')
  assert.deepEqual(config.devtoTags, ['aws', 'ai'])
  assert.equal(config.orca.automationId, 'auto-1')
})

test('IN2b 記録した automation が Orca から消えていれば作り直して新しい id を記録する', () => {
  const { home, orcaLog, env } = setup()
  assert.equal(runCli(INIT_ARGS, env).code, 0)
  const result = runCli(['init', '--time', '09:15'], { ...env, FAKE_ORCA_EDIT: 'gone', FAKE_ORCA_NEW_ID: 'auto-2' })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^automation=auto-2 \(created\)$/m)
  assert.equal(loadConfig(home)?.orca.automationId, 'auto-2')
  const calls = orcaCalls(orcaLog)
  assert.ok(calls.some((args) => args[0] === 'automations' && args[1] === 'list'))
  assert.equal(calls.filter((args) => args[0] === 'automations' && args[1] === 'create').length, 2)
})

test('IN2c edit が別の理由で失敗したら作り直さずに exit 1', () => {
  const { home, orcaLog, env } = setup()
  assert.equal(runCli(INIT_ARGS, env).code, 0)
  const result = runCli(['init', '--time', '09:15'], { ...env, FAKE_ORCA_EDIT: 'fail', FAKE_ORCA_NEW_ID: 'auto-2' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /runtime unavailable/)
  assert.equal(loadConfig(home)?.orca.automationId, 'auto-1')
  assert.equal(orcaCalls(orcaLog).filter((args) => args[0] === 'automations' && args[1] === 'create').length, 1)
})

test('IN3 automation のプロンプトに secrets も Webhook も含まない', () => {
  const { home, orcaLog, env } = setup()
  saveWebhook(homePaths(home).secrets, 'global', URL_SECRET)
  const result = runCli(INIT_ARGS, env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^webhook_global=registered$/m)
  const log = readFileSync(orcaLog, 'utf8')
  assert.ok(!log.includes('hooks.slack.com'))
  assert.ok(!log.includes('secret-tail'))
  assert.ok(!`${result.stdout}${result.stderr}`.includes('hooks.slack.com'))

  const create = orcaCalls(orcaLog).find((args) => args[0] === 'automations' && args[1] === 'create')
  const prompt = create === undefined ? '' : (flagValue(create, '--prompt') ?? '')
  assert.ok(prompt.includes(`${homePaths(home).launcher} procedure`), prompt)
  assert.ok(!prompt.includes('~/.dev-digest'), prompt)
})

test('IN4 permissions --apply は既存の設定を保ち、重複を足さない', () => {
  const { home, claudeHome, env } = setup()
  const paths = homePaths(home)
  const projectFile = join(paths.runDir, '.claude', 'settings.json')
  const userFile = join(claudeHome, 'settings.json')
  mkdirSync(join(paths.runDir, '.claude'), { recursive: true })
  writeFileSync(projectFile, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { A: '1' } }))
  writeFileSync(userFile, JSON.stringify({ theme: 'dark', permissions: { deny: ['Read(./.env)'] } }), { mode: 0o600 })

  const shown = runCli(['permissions', '--show'], env)
  assert.equal(shown.code, 0, shown.stderr)
  assert.ok(shown.stdout.includes(projectFile))
  assert.ok(shown.stdout.includes(userFile))
  assert.ok(shown.stdout.includes(`Read(/${paths.secrets})`))

  const first = runCli(['permissions', '--apply'], env)
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /^added project=14 user=2$/m)

  const project = JSON.parse(readFileSync(projectFile, 'utf8'))
  assert.deepEqual(project.env, { A: '1' })
  const launcher = paths.launcher
  const runDir = `/${paths.runDir}`
  // 無人の実行に許すのは手順が使う操作だけ
  assert.deepEqual(project.permissions.allow, [
    'Bash(ls:*)',
    `Bash(${launcher} procedure)`,
    `Bash(${launcher} collect)`,
    `Bash(${launcher} pending)`,
    `Bash(${launcher} ingest-x:*)`,
    `Bash(${launcher} publish:*)`,
    'Bash(orca tab create --url https://x.com/:*)',
    'Bash(orca tab close:*)',
    'Bash(orca snapshot:*)',
    'Bash(orca scroll:*)',
    `Read(${runDir}/**)`,
    `Write(${runDir}/x.json)`,
    `Write(${runDir}/digest.json)`,
    `Edit(${runDir}/x.json)`,
    `Edit(${runDir}/digest.json)`,
  ])
  const allow: string[] = project.permissions.allow
  for (const sub of ['set-webhook', 'init', 'permissions']) {
    assert.ok(!allow.some((rule) => rule.startsWith(`Bash(${launcher} ${sub}`)), sub)
  }
  assert.ok(!allow.includes(`Bash(${launcher}:*)`))
  assert.ok(!allow.some((rule) => /^Bash\(orca (goto|get|wait|tab:|tab list|tab switch|tab profile)/.test(rule)))
  assert.ok(!allow.some((rule) => /^(Write|Edit)\(.*\*\*\)$/.test(rule)))
  assert.ok(allow.every((rule) => !rule.includes('///')))

  const user = JSON.parse(readFileSync(userFile, 'utf8'))
  assert.equal(user.theme, 'dark')
  assert.deepEqual(user.permissions.deny, ['Read(./.env)', `Read(/${paths.secrets})`, `Edit(/${paths.secrets})`])
  assert.equal(statSync(userFile).mode & 0o777, 0o600)

  const second = runCli(['permissions', '--apply'], env)
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /^added project=0 user=0$/m)
})

test('IN5 procedure は置き換え後に {{ が残らない（init が置いたランチャー経由）', () => {
  const { home, env } = setup()
  const paths = homePaths(home)
  assert.equal(runCli(INIT_ARGS, env).code, 0)
  // claudeHome に installed_plugins.json は無いので、config の pluginRoot に落ちる
  const result = spawnSync(paths.launcher, ['procedure'], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!result.stdout.includes('{{'), result.stdout)
  assert.ok(result.stdout.includes(`${paths.launcher} collect`))
  assert.ok(result.stdout.includes(`${paths.runDir}/digest.json`))
  // URL は引用符なしで、シェルの特殊文字だけバックスラッシュでエスケープした形（allow の接頭辞に一致させる）
  assert.ok(result.stdout.includes('orca tab create --url https://x.com/i/lists/1 --json'))
  assert.ok(result.stdout.includes('orca tab create --url https://x.com/search\\?q=%23LLM\\&f=live --json'))
  assert.ok(result.stdout.includes(`${paths.launcher} ingest-x --file ${paths.runDir}/x.json`))
  assert.ok(result.stdout.includes(`${paths.launcher} publish --file ${paths.runDir}/digest.json`))
  assert.ok(!result.stderr.includes('ランチャー'), result.stderr)
})

test('IN5b init は x.com 以外のリスト URL を拒む', () => {
  const { home, orcaLog, env } = setup()
  const args = [...INIT_ARGS]
  args[args.indexOf('--x-list') + 1] = 'https://example.com/i/lists/1'
  const result = runCli(args, env)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /https:\/\/x\.com\//)
  assert.equal(loadConfig(home), null)
  assert.deepEqual(orcaCalls(orcaLog), [])
})

test('IN6 ランチャーの版が違えば警告を 1 行出して続ける', () => {
  const { env } = setup()
  assert.equal(runCli(INIT_ARGS, env).code, 0)
  const result = runCli(['procedure'], { ...env, DEV_DIGEST_LAUNCHER_VERSION: '0' })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /ランチャーが古い版です。init を再実行してください/)
  assert.ok(result.stdout.includes('collect'))
})

test('IN7 --dry-run は何も書かず Orca も呼ばず、呼ぶはずの argv を出す', () => {
  const { home, orcaLog, env } = setup()
  const result = runCli([...INIT_ARGS, '--dry-run'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^orca: repo add --path \S+ --kind folder --json$/m)
  assert.match(result.stdout, /^orca: automations create --name dev-digest .*--timezone Asia\/Tokyo/m)
  assert.deepEqual(orcaCalls(orcaLog), [])
  assert.ok(!existsSync(homePaths(home).config))
  assert.ok(!existsSync(homePaths(home).launcher))
})
