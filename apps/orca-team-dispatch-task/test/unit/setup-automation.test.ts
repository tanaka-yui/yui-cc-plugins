import * as launch from '../../bin/orca-auto-launch.ts'
import { readAutoConfig } from '../../lib/auto-config.ts'
import { autoDir, decisionsFile } from '../../lib/auto-paths.ts'
import {
  AUTO_PRECHECK_TIMEOUT_SECONDS,
  applyJudgeRules,
  CLAUDE_HOME_ENV,
  CONFIG_HOME_ENV,
  createAutomationArgs,
  ENTRY_FILE,
  editAutomationArgs,
  enableAutomationArgs,
  installLauncher,
  judgeFingerprint,
  judgeRules,
  judgeRulesProblems,
  LAUNCHER_ENV,
  LAUNCHER_SOURCE,
  LAUNCHER_VERSION,
  launcherPaths,
  PLUGIN_ID,
  PLUGIN_ROOT_FILE,
} from '../../lib/setup-automation.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const prepare = () => {
  const f = fixture()
  const home = join(f.dir, 'claude')
  process.env.ORCA_AUTO_CLAUDE_HOME = home
  mkdirSync(join(home, 'plugins'), { recursive: true })
  const installed = (path: string) =>
    f.put(join(home, 'plugins/installed_plugins.json'), {
      plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: path }] },
    })
  const cleanup = () => {
    Reflect.deleteProperty(process.env, LAUNCHER_ENV)
    Reflect.deleteProperty(process.env, CLAUDE_HOME_ENV)
    f.cleanup()
  }
  const run = (...args: string[]) => spawnSync(launcherPaths().launcher, args, { encoding: 'utf8' })
  return { ...f, home, installed, run, cleanup }
}
test('SU20 launcher copies match and installed shell is executable', () => {
  const f = prepare()
  try {
    assert.deepEqual(
      [
        launch.LAUNCHER_VERSION,
        launch.PLUGIN_ID,
        launch.LAUNCHER_ENV,
        launch.CLAUDE_HOME_ENV,
        launch.CONFIG_HOME_ENV,
        launch.PLUGIN_ROOT_FILE,
        launch.ENTRY_FILE,
        launch.LAUNCHER_SOURCE,
      ],
      [
        LAUNCHER_VERSION,
        PLUGIN_ID,
        LAUNCHER_ENV,
        CLAUDE_HOME_ENV,
        CONFIG_HOME_ENV,
        PLUGIN_ROOT_FILE,
        ENTRY_FILE,
        LAUNCHER_SOURCE,
      ],
    )
    assert.equal(installLauncher(), true)
    assert.ok(statSync(launcherPaths().launcher).mode & 0o111)
    assert.ok(readFileSync(launcherPaths().launcher, 'utf8').includes('exec "$NODE"'))
  } finally {
    f.cleanup()
  }
})
test('SU21 installed plugin wins, old plugin falls back, missing plugin fails', () => {
  const f = prepare()
  try {
    assert.equal(installLauncher(), true)
    f.installed(f.plugin)
    rmSync(launcherPaths().pluginRootFile)
    let result = f.run('judge-doc', '--name', 'main')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`${launcherPaths().launcher} judge-list --name main`))
    assert.equal(installLauncher(), true)
    f.installed(f.dir)
    result = f.run('judge-doc', '--name', 'main')
    assert.equal(result.status, 0, result.stderr)
    rmSync(launcherPaths().pluginRootFile)
    result = f.run('judge-doc', '--name', 'main')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /make auto-setup をやり直してください/)
  } finally {
    f.cleanup()
  }
})
test('SU21b symlink config home keeps the launcher spelling through tick', () => {
  const f = prepare()
  try {
    renameSync(join(f.dir, 'config'), join(f.dir, 'real'))
    symlinkSync(join(f.dir, 'real'), join(f.dir, 'config'))
    f.installed(f.plugin)
    assert.equal(installLauncher(), true)
    const config = f.config()
    assert.equal(applyJudgeRules(judgeRules(config, launcherPaths().launcher)), true)
    f.put(f.configFile, { ...f.raw, automation: { id: 'a1', acceptedFingerprint: judgeFingerprint(config) } })
    const result = f.run('tick', '--name', 'main')
    assert.ok(!result.stdout.includes('判定の権限が'), result.stdout)
    assert.ok(f.calls().includes('issue list'))
  } finally {
    f.cleanup()
  }
})
test('SU22 automation has stable paths, disabled create, and state preserving edit', () => {
  const f = prepare()
  try {
    const c = f.config(),
      launcher = launcherPaths().launcher
    const args = createAutomationArgs(c, launcher, autoDir('main'))
    assert.ok(args.every((arg) => !arg.includes(f.plugin)))
    assert.ok(args.includes('--disabled'))
    assert.ok(AUTO_PRECHECK_TIMEOUT_SECONDS > 100)
    assert.equal(args[args.indexOf('--precheck') + 1], `'${launcher}' tick --name main`)
    assert.ok(args.includes(`--extra-agent-args=--model ${c.judge.model} --effort ${c.judge.effort}`))
    const edit = editAutomationArgs('a1', c, launcher, autoDir('main'))
    for (const flag of ['--name', '--enabled', '--disabled']) assert.ok(!edit.includes(flag))
    assert.deepEqual(enableAutomationArgs('a1'), ['automations', 'edit', 'a1', '--enabled', '--json'])
  } finally {
    f.cleanup()
  }
})
test('SU23 rules cover exact commands, reads, decisions, and reject local or managed overrides', () => {
  const f = prepare()
  try {
    const c = f.config(),
      launcher = launcherPaths().launcher,
      dir = autoDir('main'),
      decisions = join(dir, 'judge/decisions.json')
    const rules = judgeRules(c, launcher)
    const paths = (path: string) => {
      try {
        const real = realpathSync(path)
        return real === path ? [path] : [path, real]
      } catch {
        return [path]
      }
    }
    const expected = [
      `Bash(${launcher} judge-doc --name main)`,
      `Bash(${launcher} judge-list --name main)`,
      `Bash(${launcher} judge-apply --name main --file ${decisions})`,
      ...paths(dir).map((p) => `Read(/${p}/**)`),
      ...Object.values(c.repos).flatMap((r) => paths(r.checkout).map((p) => `Read(/${p}/**)`)),
      ...paths(dir).flatMap((p) => [
        `Write(/${join(p, 'judge/decisions.json')})`,
        `Edit(/${join(p, 'judge/decisions.json')})`,
      ]),
    ]
    assert.deepEqual(rules.allow, expected)
    assert.deepEqual(rules.deny, [
      'WebFetch',
      'WebSearch',
      'Bash(gh *)',
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(git *)',
      'Bash(orca *)',
      'Bash(ssh *)',
      'Bash(scp *)',
      'Bash(rsync *)',
      'Bash(nc *)',
    ])
    assert.equal(applyJudgeRules(rules), true)
    assert.deepEqual(judgeRulesProblems(c, launcher), [])
    const root = JSON.parse(readFileSync(rules.file, 'utf8'))
    root.permissions.allow.push('Bash(ls)')
    f.put(rules.file, root)
    assert.ok(judgeRulesProblems(c, launcher).length)
    assert.equal(applyJudgeRules(rules), true)
    writeFileSync(join(dir, '.claude/settings.local.json'), '{}')
    assert.ok(judgeRulesProblems(c, launcher).some((s) => s.includes('settings.local.json')))
    rmSync(join(dir, '.claude/settings.local.json'))
    f.put(join(f.home, 'managed-settings.json'), { permissions: { defaultMode: 'default' } })
    assert.ok(judgeRulesProblems(c, launcher).some((s) => s.includes('managed')))
  } finally {
    f.cleanup()
  }
})
test('SU23b fingerprint tracks permissions in inherited settings', () => {
  const f = prepare()
  try {
    const c = f.config()
    assert.equal(judgeFingerprint(c), null)
    assert.equal(applyJudgeRules(judgeRules(c, launcherPaths().launcher)), true)
    const first = judgeFingerprint(c)
    assert.equal(typeof first, 'string')
    f.put(join(f.home, 'settings.json'), { permissions: { allow: ['Bash(ls)'] } })
    const second = judgeFingerprint(c)
    assert.notEqual(second, first)
    f.put(join(f.home, 'settings.json'), { theme: 'dark', permissions: { allow: ['Bash(ls)'] } })
    assert.equal(judgeFingerprint(c), second)
  } finally {
    f.cleanup()
  }
})
test('SU24 judge-doc prints caller commands without needing config', () => {
  const f = prepare()
  try {
    rmSync(f.configFile)
    for (const viaLauncher of [false, true]) {
      if (viaLauncher) process.env[LAUNCHER_ENV] = String(LAUNCHER_VERSION)
      const result = f.cli('judge-doc', '--name', 'main')
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.startsWith('# Judge the automatic queue'))
      const prefix = viaLauncher ? launcherPaths().launcher : `node ${join(f.plugin, ENTRY_FILE)}`
      assert.ok(result.stdout.includes(`${prefix} judge-list --name main`))
      assert.ok(
        result.stdout.includes(
          `${prefix} judge-apply --name main --file ${join(autoDir('main'), 'judge/decisions.json')}`,
        ),
      )
    }
  } finally {
    f.cleanup()
  }
})
test('SU25 and SU25b launcher tick refuses missing approval or changed permissions', () => {
  const f = prepare()
  try {
    process.env[LAUNCHER_ENV] = '1'
    let result = f.cli('tick')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /承認されていません/)
    assert.ok(!f.calls().includes('issue list'))
    const c = f.config()
    const rules = judgeRules(c, launcherPaths().launcher)
    applyJudgeRules(rules)
    f.put(f.configFile, { ...f.raw, automation: { id: 'a1', acceptedFingerprint: judgeFingerprint(c) } })
    result = f.cli('tick')
    assert.ok(!result.stdout.includes('判定の権限が'), result.stdout)
    assert.ok(f.calls().includes('issue list'))
    writeFileSync(join(f.gh, 'calls.log'), '')
    f.put(rules.file, { permissions: {} })
    result = f.cli('tick')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /承認したときと違います/)
    assert.ok(!f.calls().includes('issue list'))
    Reflect.deleteProperty(process.env, LAUNCHER_ENV)
    f.cli('tick')
    assert.ok(f.calls().includes('issue list'))
    assert.ok(existsSync(f.configFile))
  } finally {
    f.cleanup()
  }
})

// 2026-11-24（Claude Code 2.1.331）: dontAsk は .claude の下への書き込みを、Edit の許可があっても拒む。
// 既定の設定の置き場所は ~/.claude/config/... なので、判定結果のファイルだけを .claude の外に置く
test('SU23c decisions file leaves a .claude config home, and the rules follow it', () => {
  const f = prepare()
  const oldHome = process.env.HOME
  try {
    assert.equal(decisionsFile('main'), join(autoDir('main'), 'judge/decisions.json'))
    const home = join(f.dir, 'home')
    process.env.HOME = home
    process.env[CONFIG_HOME_ENV] = join(home, '.claude/config/orca-team-dispatch-task')
    mkdirSync(autoDir('main'), { recursive: true })
    f.put(join(autoDir('main'), 'config.json'), f.raw)
    const config = readAutoConfig('main')
    assert.ok(config)
    const file = decisionsFile('main')
    assert.equal(file, join(home, '.orca-team-dispatch-task/auto/main/judge/decisions.json'))
    const launcher = launcherPaths().launcher
    const rules = judgeRules(config, launcher)
    const real = join(realpathSync(home), '.orca-team-dispatch-task/auto/main/judge/decisions.json')
    const forms = real === file ? [file] : [file, real]
    assert.ok(rules.allow.includes(`Bash(${launcher} judge-apply --name main --file ${file})`))
    for (const form of forms)
      for (const tool of ['Read', 'Write', 'Edit'])
        assert.ok(rules.allow.includes(`${tool}(/${form})`), `${tool} ${form}`)
    assert.ok(!rules.allow.some((entry) => /^(Write|Edit)\(/.test(entry) && entry.includes('/.claude/')))
    // 判定の材料に出す path も同じ
    f.put(join(autoDir('main'), 'state.json'), { version: 1, judgingSince: null, issues: {}, projectSync: {} })
    const listed = spawnSync(process.execPath, [join(import.meta.dirname, '../../bin/orca-auto.ts'), 'judge-list'], {
      encoding: 'utf8',
    })
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(JSON.parse(listed.stdout).decisionsFile, file)
    assert.ok(existsSync(join(home, '.orca-team-dispatch-task/auto/main/judge')))
  } finally {
    process.env.HOME = oldHome
    f.cleanup()
  }
})
