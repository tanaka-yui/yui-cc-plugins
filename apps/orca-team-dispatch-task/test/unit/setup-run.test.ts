import { autoDir } from '../../lib/auto-paths.ts'
import { runSetup } from '../../lib/auto-setup.ts'
import { releaseLock, takeLock } from '../../lib/auto-state.ts'
import { VERIFY_BEGIN, VERIFY_END, VERIFY_TMP } from '../../lib/setup-verify.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { readClaudeStubArgs, readClaudeStubPwd, writeClaudeStub } from '../lib/claude-stub.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const gitRepo = (path: string, repo: string) => {
  mkdirSync(path, { recursive: true })
  for (const args of [
    ['init', '-q'],
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'],
    ['remote', 'add', 'origin', `https://github.com/${repo}.git`],
  ]) {
    const r = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
}
const prepare = () => {
  const f = fixture()
  const userHome = join(f.dir, 'home')
  mkdirSync(userHome)
  const oldHome = process.env.HOME
  process.env.HOME = userHome
  for (const [repo, r] of Object.entries(f.raw.repos)) gitRepo(r.checkout, repo)
  const home = join(f.dir, 'claude')
  mkdirSync(home)
  process.env.ORCA_AUTO_CLAUDE_HOME = home
  process.env.ORCA_AUTO_CLAUDE_BIN = join(f.dir, 'no-claude')
  f.respond('auth_status', { hosts: { 'github.com': [{ active: true, state: 'success', scopes: 'repo, project' }] } })
  f.respond('label_list', [])
  f.respond(
    'host_list',
    { ok: true, result: { hosts: [{ id: 'local', kind: 'local', machineName: 'Test Mac' }] } },
    f.orca,
  )
  f.respond('status', { ok: true, result: { runtime: { reachable: true } } }, f.orca)
  f.respond('repo_list', { ok: true, result: { repos: [] } }, f.orca)
  f.respond('automations_list', { ok: true, result: { automations: [] } }, f.orca)
  f.respond('automations_create', { ok: true, result: { automation: { id: 'a1' } } }, f.orca)
  const invoke = (answers: string[], tty = true) =>
    spawnSync(process.execPath, [join(f.plugin, 'bin/orca-auto.ts'), 'setup', '--name', 'main'], {
      input: `${answers.join('\n')}\n`,
      env: { ...process.env, ORCA_AUTO_TEST_STDIN: tty ? '1' : '' },
      encoding: 'utf8',
    })
  const freshAnswers = () => [
    f.raw.intakeConfig,
    '',
    '1',
    '',
    '',
    '',
    f.raw.repos['acme/app'].checkout,
    '',
    '',
    '',
    'n',
    `echo ran >> '${join(f.dir, 'verify.log')}'`,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'y',
    'y',
  ]
  const fresh = (last = 'y') => {
    rmSync(f.configFile)
    const a = freshAnswers()
    a[a.length - 1] = last
    return invoke(a)
  }
  const rerun = (overrides: Record<string, string> = {}) => {
    let output = ''
    const code = runSetup(
      'main',
      {
        ask: (q, fallback) => Object.entries(overrides).find(([key]) => q.includes(key))?.[1] ?? fallback ?? '',
        confirm: (q) => Object.entries(overrides).find(([key]) => q.includes(key))?.[1] === 'y',
      },
      (text) => {
        output += text
      },
    )
    return { code, output }
  }
  const cleanup = () => {
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_CLAUDE_HOME')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_CLAUDE_BIN')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_TIMEOUT_MS')
    Reflect.deleteProperty(process.env, 'ORCA_AUTO_VERIFY_INTERVAL_MS')
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
    else process.env.HOME = oldHome
    f.cleanup()
  }
  return { ...f, home, userHome, invoke, freshAnswers, fresh, rerun, cleanup }
}
const withoutAutomation = (value: ReturnType<ReturnType<typeof prepare>['config']>) => {
  const { automation: _automation, ...rest } = value
  return rest
}
test('SU26 non-tty refuses without writing', () => {
  const f = prepare()
  try {
    rmSync(f.configFile)
    const result = f.invoke([], false)
    assert.equal(result.status, 2)
    assert.equal(existsSync(f.configFile), false)
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
  } finally {
    f.cleanup()
  }
})
test('SU27 fresh setup creates disabled automation then approves and enables; SU30 rerun preserves', () => {
  const f = prepare()
  try {
    const first = f.fresh()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    const config = f.config()
    assert.equal(config.hosts?.[0]?.name, 'Test Mac')
    assert.ok(config.hosts?.[0]?.spec)
    assert.equal(config.repos['acme/app']?.verified, true)
    assert.equal(config.automation?.id, 'a1')
    assert.equal(typeof config.automation?.acceptedFingerprint, 'string')
    assert.equal(readFileSync(join(f.dir, 'verify.log'), 'utf8'), 'ran\n')
    assert.ok(f.calls(f.orca).includes('--disabled'))
    assert.ok(f.calls(f.orca).includes('automations edit a1 --enabled'))
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
    writeFileSync(join(f.orca, 'calls.log'), '')
    const again = f.invoke(Array(100).fill(''))
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.deepEqual(f.config(), config)
    assert.equal(readFileSync(join(f.dir, 'verify.log'), 'utf8'), 'ran\n')
    assert.ok(!f.calls(f.orca).includes('automations create'))
    assert.ok(f.calls(f.orca).includes('automations edit a1'))
  } finally {
    f.cleanup()
  }
})
test('SU28 decline new enable and SU28b decline existing changed permissions', () => {
  const f = prepare()
  try {
    const result = f.fresh('n')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /無効のままです/)
    assert.equal(f.config().automation?.acceptedFingerprint, null)
    assert.ok(!f.calls(f.orca).includes('--enabled'))
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
    const enabled = f.rerun({ 有効にしますか: 'y' })
    assert.equal(enabled.code, 0, enabled.output)
    const fingerprint = f.config().automation?.acceptedFingerprint
    f.put(join(f.home, 'settings.json'), { permissions: { allow: ['Bash(ls)'] } })
    writeFileSync(join(f.orca, 'calls.log'), '')
    const again = f.invoke(Array(100).fill(''))
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /有効・無効は変えていません/)
    assert.ok(!again.stdout.includes('無効のままです'))
    assert.equal(f.config().automation?.acceptedFingerprint, fingerprint)
    assert.ok(!/--enabled|--disabled/.test(f.calls(f.orca)))
  } finally {
    f.cleanup()
  }
})
test('SU29 missing project scope records no project and explains recovery', () => {
  const f = prepare()
  try {
    rmSync(f.configFile)
    f.respond('auth_status', { hosts: { 'github.com': [{ active: true, state: 'success', scopes: 'repo' }] } })
    const answers = f.freshAnswers()
    answers[7] = 'acme/3'
    const result = f.invoke(answers)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(f.config().sources[0]?.project, null)
    assert.match(result.stdout, /gh auth refresh -h github.com -s project/)
  } finally {
    f.cleanup()
  }
})
test('SU27b same-name automation requires consent', () => {
  const f = prepare()
  try {
    rmSync(f.configFile)
    f.respond(
      'automations_list',
      { ok: true, result: { automations: [{ id: 'old', name: 'orca-auto-main' }] } },
      f.orca,
    )
    const answers = f.freshAnswers()
    answers[21] = 'n'
    const result = f.invoke(answers)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.ok(!/automations (create|edit)/.test(f.calls(f.orca)))
    const accepted = f.invoke(['y', 'n'])
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
    assert.equal(f.config().automation?.id, 'old')
  } finally {
    f.cleanup()
  }
})
test('SU30b missing recorded automation is recreated', () => {
  const f = prepare()
  try {
    assert.equal(f.fresh().status, 0)
    writeFileSync(join(f.orca, 'automations_edit_a1.rc'), '1')
    f.respond('automations_create', { ok: true, result: { automation: { id: 'a2' } } }, f.orca)
    const result = f.invoke(Array(100).fill(''))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(f.config().automation?.id, 'a2')
  } finally {
    f.cleanup()
  }
})
test('SU30c legacy hand-written config preserves omitted defaults and unverified commands', () => {
  const f = prepare()
  try {
    f.put(f.configFile, {
      ...f.raw,
      repos: {
        ...f.raw.repos,
        'other/api': { ...f.raw.repos['other/api'], verify: [`echo ran >> '${join(f.dir, 'verify.log')}'`] },
      },
    })
    const before = f.config(),
      raw = JSON.parse(readFileSync(f.configFile, 'utf8'))
    const result = f.invoke(Array(100).fill(''))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /変わる所はありません/)
    assert.ok(!result.stdout.includes('書きますか'))
    assert.deepEqual(withoutAutomation(f.config()), withoutAutomation(before))
    const after = JSON.parse(readFileSync(f.configFile, 'utf8'))
    delete after.automation
    const { intakeConfig, ...rest } = raw
    assert.deepEqual(after, { ...rest, intakeConfigs: [intakeConfig] })
    assert.equal(existsSync(join(f.dir, 'verify.log')), false)
  } finally {
    f.cleanup()
  }
})
const localHost = (f: ReturnType<typeof prepare>) => ({
  id: 'local',
  name: 'This Mac',
  lanes: 2,
  orcaBin: 'orca',
  repos: {
    'acme/app': { selector: `path:${f.raw.repos['acme/app'].checkout}`, verified: true },
    'other/api': { selector: `path:${f.raw.repos['other/api'].checkout}`, verified: false },
  },
})
const remoteSpec = {
  cpus: 4,
  memoryTotalMb: 16384,
  memoryFreeMb: 4096,
  swapTotalMb: 0,
  diskFreeMb: 20480,
  measuredAt: '2026-11-17T00:00:00Z',
}
const remoteHost = {
  id: 'env-1',
  name: 'Server',
  lanes: 1,
  orcaBin: 'orca',
  spec: remoteSpec,
  repos: { 'acme/app': { selector: 'id:R', verified: true } },
}
const remoteResponses = (f: ReturnType<typeof prepare>) => {
  f.respond(
    'host_list',
    {
      ok: true,
      result: {
        hosts: [
          { id: 'local', kind: 'local', machineName: 'Test Mac' },
          { id: 'env-1', kind: 'environment', name: 'Server' },
        ],
      },
    },
    f.orca,
  )
  f.hook(
    'repo_list',
    `case " $* " in *' --environment '*) printf '%s' '{"ok":true,"result":{"repos":[{"id":"R","path":"/remote/app","gitRemoteIdentity":{"canonicalKey":"github.com/acme/app"}},{"id":"R2","path":"/remote/app2","gitRemoteIdentity":{"canonicalKey":"github.com/acme/app"}}]}}' > "$ORCA_STUB_DIR/repo_list" ;; *) printf '%s' '{"ok":true,"result":{"repos":[]}}' > "$ORCA_STUB_DIR/repo_list" ;; esac`,
    f.orca,
  )
}
test('SU30d existing host name, spec absence, orcaBin and lanes survive Enter', () => {
  const f = prepare()
  try {
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f)] })
    const before = f.config()
    const result = f.invoke(Array(100).fill(''))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(withoutAutomation(f.config()), withoutAutomation(before))
  } finally {
    f.cleanup()
  }
})
test('SU30e changing checkout invalidates verification until commands pass', () => {
  for (const run of ['n', 'y']) {
    const f = prepare()
    try {
      assert.equal(f.fresh().status, 0)
      const checkout = join(f.dir, 'checkout-b')
      gitRepo(checkout, 'acme/app')
      const result = f.rerun({
        'acme/app のこのマシンの checkout': checkout,
        走らせて確かめますか: run,
        'config.json を書きますか': 'y',
        有効にしますか: 'y',
      })
      assert.equal(result.code, 0, result.output)
      assert.equal(f.config().repos['acme/app']?.checkout, checkout)
      assert.equal(f.config().repos['acme/app']?.verified, run === 'y')
      assert.equal(f.config().hosts?.[0]?.repos['acme/app']?.verified, run === 'y')
      assert.equal(
        readFileSync(join(f.dir, 'verify.log'), 'utf8').split('\n').filter(Boolean).length,
        run === 'y' ? 2 : 1,
      )
    } finally {
      f.cleanup()
    }
  }
})
test('SU30f changed remote selector loses verification without reprobe', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    const result = f.rerun({
      'Server の acme/app の checkout': '2',
      'acme/app を Server で走らせて確かめますか': 'n',
      'config.json を書きますか': 'y',
    })
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.config().hosts?.[1]?.repos['acme/app'], { selector: 'id:R2', verified: false, measure: null })
    assert.ok(!f.calls(f.orca).includes('terminal create'))
  } finally {
    f.cleanup()
  }
})
test('SU30g legacy lanes persist across an interrupted setup', () => {
  const f = prepare()
  try {
    f.put(f.configFile, { ...f.raw, lanes: 2 })
    let output = ''
    const code = runSetup(
      'main',
      {
        ask: (q, fallback) => (q.includes('review_mode') ? null : q.includes('全体の並列数') ? '3' : (fallback ?? '')),
        confirm: () => false,
      },
      (text) => {
        output += text
      },
    )
    assert.equal(code, 2, output)
    const draft = JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'))
    assert.equal(draft.values.lanes, 3)
    assert.ok(draft.done.includes('lanes'))
    const result = f.invoke(['', '', '', 'y', ''])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(f.config().lanes, 3)
    assert.equal(f.config().hosts, null)
  } finally {
    f.cleanup()
  }
})
for (const withLocal of [false, true])
  test(`SU30${withLocal ? 'i' : 'h'} global verification survives without a local host mapping`, () => {
    const f = prepare()
    try {
      remoteResponses(f)
      const local = {
        ...localHost(f),
        repos: { 'other/api': { selector: `path:${f.raw.repos['other/api'].checkout}`, verified: false } },
      }
      f.put(f.configFile, { ...f.raw, hosts: [...(withLocal ? [local] : []), remoteHost] })
      const before = f.config()
      const result = f.invoke(Array(100).fill(''))
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.deepEqual(withoutAutomation(f.config()), withoutAutomation(before))
      assert.ok(!f.calls(f.orca).includes('terminal create'))
    } finally {
      f.cleanup()
    }
  })
test('SU31 EOF keeps finished steps and resumes at repositories', () => {
  const f = prepare()
  try {
    rmSync(f.configFile)
    const result = f.invoke([f.raw.intakeConfig, '', '1', '', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.equal(existsSync(f.configFile), false)
    const draft = JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'))
    assert.deepEqual(draft.done, ['prereq', 'sources'])
    const rest = f.freshAnswers().slice(5)
    const again = f.invoke(rest)
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.match(again.stdout, /\[1\/12\] 前提の確認 … 済み/)
    assert.match(again.stdout, /\[2\/12\] 拾う元 … 済み/)
  } finally {
    f.cleanup()
  }
})
test('SU32 active remote issue prevents removing its host and leaves config bytes unchanged', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    f.put(join(autoDir('main'), 'state.json'), {
      version: 1,
      judgingSince: null,
      issues: {
        'acme/app#1': {
          key: 'acme/app#1',
          repo: 'acme/app',
          generation: 1,
          phase: 'running',
          host: 'env-1',
          targets: ['acme/app'],
          prs: [],
        },
      },
    })
    const before = readFileSync(f.configFile, 'utf8')
    const result = f.rerun({ 使うマシンの番号: '1', 'config.json を書きますか': 'y' })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /acme\/app#1 がマシン env-1 を使っています/)
    assert.equal(readFileSync(f.configFile, 'utf8'), before)
  } finally {
    f.cleanup()
  }
})
for (const managed of [false, true])
  test(`SU33${managed ? 'b' : ''} approval cannot override unsafe local or managed settings`, () => {
    const f = prepare()
    try {
      const file = managed
        ? join(f.home, 'managed-settings.json')
        : join(autoDir('main'), '.claude/settings.local.json')
      mkdirSync(join(autoDir('main'), '.claude'), { recursive: true })
      const content = managed ? '{"permissions":{"defaultMode":"default"}}' : '{}'
      writeFileSync(file, content)
      const result = f.fresh()
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.ok(result.stdout.includes(managed ? 'managed' : 'settings.local.json'))
      assert.equal(f.config().automation?.acceptedFingerprint, null)
      assert.ok(!f.calls(f.orca).includes('--enabled'))
      assert.equal(readFileSync(file, 'utf8'), content)
      const draft = JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'))
      assert.ok(draft.done.includes('automation'))
    } finally {
      f.cleanup()
    }
  })

test('SU30j Enter preserves source order independently of intake order', () => {
  const f = prepare()
  try {
    f.put(f.configFile, { ...f.raw, sources: [...f.raw.sources].reverse() })
    const before = f.config()
    const result = f.invoke(Array(100).fill(''))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(withoutAutomation(f.config()), withoutAutomation(before))
  } finally {
    f.cleanup()
  }
})
test('SU30k Enter preserves host priority order independently of discovery order', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [remoteHost, localHost(f)] })
    const before = f.config()
    const result = f.invoke(Array(100).fill(''))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(withoutAutomation(f.config()), withoutAutomation(before))
  } finally {
    f.cleanup()
  }
})

test('SU27c initial roles inherit the dispatch configuration', () => {
  const f = prepare()
  try {
    f.put(join(f.dir, 'config/config.json'), { review_mode: 'on', phase_b: 'on' })
    const result = f.fresh()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(f.config().roles, { review_mode: 'on', phase_b: 'on' })
    assert.match(result.stdout, /review_mode \[on\]/)
    assert.match(result.stdout, /phase_b \[on\]/)
  } finally {
    f.cleanup()
  }
})

test('SU34 AI suggestion becomes the default commands and is accepted with Enter', () => {
  const f = prepare()
  try {
    process.env.ORCA_AUTO_CLAUDE_BIN = writeClaudeStub(
      f.dir,
      JSON.stringify({
        type: 'result',
        result: JSON.stringify({ commands: ['echo ok'], tools: ['sh', 'definitely-not-a-tool-xyz'], notes: 'メモ' }),
      }),
    )
    const r = f.rerun({
      'acme/app の確認コマンドを AI に': 'y',
      'other/api の確認コマンドを AI に': 'n',
      'acme/app の確認コマンドをこのマシンで': 'y',
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(f.config().repos['acme/app']?.verify, ['echo ok'])
    assert.equal(f.config().repos['acme/app']?.verified, true)
    for (const text of [
      'AI の案: echo ok',
      'このマシン: 通りました',
      'このマシン: 足りない道具: definitely-not-a-tool-xyz',
    ])
      assert.ok(r.output.includes(text), r.output)
    const args = readClaudeStubArgs(f.dir)
    for (const [flag, value] of [
      ['--allowedTools', 'Read,Glob,Grep'],
      ['--model', 'claude-opus-5-5[1m]'],
      ['--effort', 'high'],
    ])
      assert.equal(args[args.indexOf(flag ?? '') + 1], value)
    assert.equal(readClaudeStubPwd(f.dir), realpathSync(f.raw.repos['acme/app'].checkout))
  } finally {
    f.cleanup()
  }
})
test('SU35 AI failure falls back to manual entry', () => {
  const f = prepare()
  try {
    const r = f.rerun({
      'other/api の確認コマンド 1': 'echo typed',
      'other/api の確認コマンドをこのマシンで': 'n',
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    assert.ok(r.output.includes('AI の案を作れませんでした: claude を起動できません'), r.output)
    assert.deepEqual(f.config().repos['other/api']?.verify, ['echo typed'])
  } finally {
    f.cleanup()
  }
})
const remoteVerifyResponse = (f: ReturnType<typeof prepare>, kind = 'pass') => {
  remoteResponses(f)
  f.respond('terminal_create', { ok: true, result: { terminal: { handle: 't1' } } }, f.orca)
  const result = {
    ok: kind === 'pass',
    failed: kind === 'pass' ? null : 'npm test',
    exitCode: kind === 'pass' ? 0 : 1,
    peakMemoryMb: 3000,
    diskGrowthMb: 700,
    missingTools: kind === 'pass' ? [] : ['npm'],
    platform: 'darwin',
  }
  f.respond(
    'terminal_read',
    {
      ok: true,
      result: {
        terminal: {
          tail: [
            `${VERIFY_TMP}/tmp/x@@`,
            ...(kind === 'timeout' ? [] : [`${VERIFY_BEGIN}${JSON.stringify(result)}${VERIFY_END}`]),
          ],
        },
      },
    },
    f.orca,
  )
}
const measuredPair = {
  selector: 'id:R',
  verified: true,
  measure: { peakMemoryMb: 3000, diskGrowthMb: 700, measuredAt: '2026-11-13T05:30:00Z' },
}
for (const kind of ['pass', 'fail', 'timeout'])
  test(`SU36 remote pair verification ${kind}`, () => {
    const f = prepare()
    try {
      remoteVerifyResponse(f, kind)
      f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
      if (kind === 'timeout') {
        process.env.ORCA_AUTO_VERIFY_TIMEOUT_MS = '50'
        process.env.ORCA_AUTO_VERIFY_INTERVAL_MS = '10'
      }
      const r = f.rerun({ 'acme/app を Server で走らせて確かめますか': 'y', 'config.json を書きますか': 'y' })
      assert.equal(r.code, 0, r.output)
      const pair = f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app']
      assert.deepEqual(pair, kind === 'pass' ? measuredPair : { selector: 'id:R', verified: false, measure: null })
      if (kind === 'pass') {
        assert.ok(r.output.includes('Server: 通りました（最大メモリ 3000 MB、ディスク +700 MB）'), r.output)
        assert.ok(r.output.includes('1 worktree: メモリ 6000 MB・ディスク 1400 MB（測った値）'), r.output)
      } else if (kind === 'fail') {
        assert.ok(r.output.includes('Server: npm test が失敗しました'), r.output)
        assert.ok(r.output.includes('Server: 足りない道具: npm'), r.output)
      } else {
        assert.ok(r.output.includes('Server: 時間内に終わりませんでした'), r.output)
        assert.ok(r.output.includes('一時ディレクトリが残っていれば消してください: /tmp/x'), r.output)
      }
      const calls = readFileSync(join(f.orca, 'argv.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\x1f'))
      const create = calls.find((a) => a[0] === 'terminal' && a[1] === 'create')
      assert.ok(create)
      for (const [flag, value] of [
        ['--environment', 'env-1'],
        ['--worktree', 'path:/remote/app'],
        ['--title', 'orca-auto-verify'],
      ])
        assert.equal(create[create.indexOf(flag ?? '') + 1], value)
      assert.ok(calls.some((a) => a[0] === 'terminal' && a[1] === 'close' && a[a.indexOf('--terminal') + 1] === 't1'))
    } finally {
      f.cleanup()
    }
  })
test('SU37 Enter rerun skips the remote check and keeps verified and measure', () => {
  const f = prepare()
  try {
    remoteVerifyResponse(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    const r = f.rerun({ 'acme/app を Server で走らせて確かめますか': 'y', 'config.json を書きますか': 'y' })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app'], measuredPair)
    const before = withoutAutomation(f.config())
    writeFileSync(join(f.orca, 'calls.log'), '')
    const again = f.invoke(Array(100).fill(''))
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.ok(!f.calls(f.orca).includes('terminal create'))
    assert.deepEqual(withoutAutomation(f.config()), before)
  } finally {
    f.cleanup()
  }
})
test('SU37b unverified C3a remote pair is checked with Enter', () => {
  const f = prepare()
  try {
    remoteVerifyResponse(f)
    f.put(f.configFile, {
      ...f.raw,
      hosts: [localHost(f), { ...remoteHost, repos: { 'acme/app': { selector: 'id:R', verified: false } } }],
    })
    const r = f.rerun({ 'config.json を書きますか': 'y' })
    assert.equal(r.code, 0, r.output)
    assert.ok(f.calls(f.orca).includes('terminal create'))
    assert.deepEqual(f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app'], measuredPair)
  } finally {
    f.cleanup()
  }
})
test('SU38 changing the remote selector drops verified and measure until checked again', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), { ...remoteHost, repos: { 'acme/app': measuredPair } }] })
    const r = f.rerun({
      'Server の acme/app の checkout': '2',
      'acme/app を Server で走らせて確かめますか': 'n',
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app'], {
      selector: 'id:R2',
      verified: false,
      measure: null,
    })
    assert.ok(!f.calls(f.orca).includes('terminal create'))
  } finally {
    f.cleanup()
  }
})

test('SU39 cleanup failure reports the remaining temporary directory', () => {
  const f = prepare()
  let leftover: string | null = null
  try {
    const command = `mkdir -p ro/sub && touch ro/sub/f && chmod 555 ro/sub && echo built && pwd -P > '${join(f.dir, 'verify-worktree')}'`
    const r = f.rerun({
      'acme/app の確認コマンド 1': command,
      'acme/app の確認コマンドをこのマシンで': 'y',
      'other/api の確認コマンドを AI に': 'n',
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    const hint = '一時ディレクトリが残っていれば消してください: '
    leftover = dirname(readFileSync(join(f.dir, 'verify-worktree'), 'utf8').trim())
    const reported = r.output.split(hint)[1]?.split('\n')[0]
    assert.ok(reported, r.output)
    assert.equal(realpathSync(reported), realpathSync(leftover))
    assert.ok(existsSync(leftover))
    assert.ok(r.output.includes('このマシン: 確認のスクリプト が失敗しました'), r.output)
    assert.equal(f.config().repos['acme/app']?.verified, false)
  } finally {
    if (!leftover && existsSync(join(f.dir, 'verify-worktree')))
      leftover = dirname(readFileSync(join(f.dir, 'verify-worktree'), 'utf8').trim())
    if (leftover) {
      spawnSync('chmod', ['-R', 'u+w', leftover])
      rmSync(leftover, { recursive: true, force: true })
    }
    f.cleanup()
  }
})

type Draft = { done: string[]; values: { intakeConfigs?: string[]; sources?: Array<{ repo: string }> } }
const draftOf = () => JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8')) as Draft
test('MI5 legacy intakeConfig migrates to intakeConfigs with Enter only and keeps every other key', () => {
  const f = prepare()
  try {
    const before = JSON.parse(readFileSync(f.configFile, 'utf8')) // fixture の古い形（intakeConfig・省いた既定値）
    const first = f.invoke(Array(100).fill(''))
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.ok(first.stdout.includes(`  1. ${f.raw.intakeConfig}`), first.stdout) // 前に選んだ intake が並び、既定で選ばれる
    assert.ok(first.stdout.includes('古い intakeConfig を intakeConfigs に書き換えます'), first.stdout)
    assert.ok(!first.stdout.includes('書きますか'))
    const after = JSON.parse(readFileSync(f.configFile, 'utf8'))
    delete after.automation
    const { intakeConfig, ...rest } = before
    assert.deepEqual(after, { ...rest, intakeConfigs: [intakeConfig] }) // ほかのキー・省いた既定値・verify・verified はそのまま
    assert.deepEqual(f.config().intakeConfigs, [f.raw.intakeConfig])
    const text = readFileSync(f.configFile, 'utf8')
    const second = f.invoke(Array(100).fill(''))
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /変わる所はありません/)
    assert.ok(!second.stdout.includes('intakeConfig を intakeConfigs に書き換えます'))
    assert.equal(readFileSync(f.configFile, 'utf8'), text) // 新しい形は、変わる所が無ければ書かない
  } finally {
    f.cleanup()
  }
})
// import に releaseLock・takeLock（'../../lib/auto-state.ts'）を足す
test('MI10 the key migration re-reads config.json under the lock and never overwrites a newer file', () => {
  for (const variant of ['changed', 'migrated', 'removed'] as const) {
    const f = prepare()
    const oldWait = process.env.ORCA_AUTO_LOCK_WAIT_MS
    try {
      process.env.ORCA_AUTO_LOCK_WAIT_MS = '0' // ロックが取れなければ待たずに「もう一度待ちますか」を聞く
      const legacy = JSON.parse(readFileSync(f.configFile, 'utf8'))
      const { intakeConfig, ...rest } = legacy
      const migrated = { ...rest, intakeConfigs: [intakeConfig] }
      const changed = { ...legacy, automation: { id: 'other', acceptedFingerprint: 'fp' } } // 別の setup が automation を書いた（古いキーのまま）
      assert.ok(takeLock('main', 60_000)) // tick が動いている形にする。保存の段が最初にロックを取ろうとする所で待たされる
      let output = ''
      const code = runSetup(
        'main',
        {
          ask: (_question, fallback) => fallback ?? '',
          confirm: (question) => {
            if (!question.includes('tick が動いています')) return false
            if (variant === 'changed') f.put(f.configFile, changed)
            else if (variant === 'migrated')
              f.put(f.configFile, migrated) // 別の setup が先に新しい形へ移した
            else rmSync(f.configFile)
            releaseLock('main')
            return true
          },
        },
        (text) => {
          output += text
        },
      )
      if (variant === 'changed') {
        assert.equal(code, 1, output)
        assert.ok(output.includes('config.json が setup の途中で変わりました'), output)
        assert.deepEqual(JSON.parse(readFileSync(f.configFile, 'utf8')), changed) // 古い内容で上書きしない
      } else if (variant === 'migrated') {
        assert.equal(code, 0, output)
        assert.ok(!output.includes('intakeConfig を intakeConfigs に書き換えます'), output)
        const after = JSON.parse(readFileSync(f.configFile, 'utf8'))
        delete after.automation
        assert.deepEqual(after, migrated) // 書き戻さない
      } else {
        assert.equal(code, 1, output)
        assert.ok(output.includes('config.json が setup の途中で変わりました'), output)
        assert.equal(existsSync(f.configFile), false)
      }
    } finally {
      releaseLock('main')
      if (oldWait === undefined) Reflect.deleteProperty(process.env, 'ORCA_AUTO_LOCK_WAIT_MS')
      else process.env.ORCA_AUTO_LOCK_WAIT_MS = oldWait
      f.cleanup()
    }
  }
})
test('MI6 two intake homes are offered and their repos become candidates', () => {
  const f = prepare()
  try {
    const ws1 = join(f.userHome, '.slack-issue-intake-ws1', 'config.json')
    const ws2 = join(f.userHome, '.slack-issue-intake-ws2', 'config.json')
    for (const [path, repo] of [
      [ws1, 'acme/app'],
      [ws2, 'other/api'],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true })
      f.put(path, { repos: [{ name: repo }] })
    }
    rmSync(f.configFile)
    const result = f.invoke(['', '', '1,2', '', '', '', '']) // 番号は既定（全部）、ほかは無し、拾う元 1,2、拾う条件と auto-ready を 2 つずつ、次の段で入力が尽きる
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(`  1. ${ws1}`) && result.stdout.includes(`  2. ${ws2}`), result.stdout)
    const draft = draftOf()
    assert.deepEqual(draft.done, ['prereq', 'sources'])
    assert.deepEqual(draft.values.intakeConfigs, [ws1, ws2])
    assert.deepEqual(
      draft.values.sources?.map((s) => s.repo),
      ['acme/app', 'other/api'],
    )
  } finally {
    f.cleanup()
  }
})
test('MI8 other intake paths are checked and at least one intake is required', () => {
  const f = prepare()
  try {
    const ws1 = join(f.userHome, '.slack-issue-intake-ws1', 'config.json')
    mkdirSync(dirname(ws1), { recursive: true })
    f.put(ws1, { repos: [{ name: 'acme/app' }] })
    rmSync(f.configFile)
    const missing = join(f.dir, 'missing.json')
    const result = f.invoke(['-', '', '1', 'relative.json', missing, f.raw.intakeConfig, '', '1,2', '', '', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    for (const text of [
      'intake の設定ファイルを 1 つ以上選んでください',
      '絶対パスを入力してください',
      `intake の repos[].name を読めません: ${missing}`,
    ])
      assert.ok(result.stdout.includes(text), text)
    const draft = draftOf()
    assert.deepEqual(draft.values.intakeConfigs, [ws1, f.raw.intakeConfig])
    assert.deepEqual(
      draft.values.sources?.map((s) => s.repo),
      ['acme/app', 'other/api'],
    )
  } finally {
    f.cleanup()
  }
})

test('MI11 unnamed intake home is not offered for fresh setup', () => {
  const f = prepare()
  try {
    const legacy = join(f.userHome, '.slack-issue-intake', 'config.json')
    const ws2 = join(f.userHome, '.slack-issue-intake-ws2', 'config.json')
    for (const [path, repo] of [
      [legacy, 'acme/app'],
      [ws2, 'other/api'],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true })
      f.put(path, { repos: [{ name: repo }] })
    }
    rmSync(f.configFile)
    const result = f.invoke(['', '', '1', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(`  1. ${ws2}`), result.stdout)
    assert.ok(!result.stdout.includes(legacy), result.stdout)
    assert.deepEqual(draftOf().values.intakeConfigs, [ws2])
  } finally {
    f.cleanup()
  }
})
test('MI12 configured unnamed intake stays offered and selected with Enter', () => {
  const f = prepare()
  try {
    const legacy = join(f.userHome, '.slack-issue-intake', 'config.json')
    const ws2 = join(f.userHome, '.slack-issue-intake-ws2', 'config.json')
    for (const path of [legacy, ws2]) {
      mkdirSync(dirname(path), { recursive: true })
      f.put(path, { repos: [{ name: 'acme/app' }] })
    }
    const configured = { ...f.raw, intakeConfigs: [legacy] }
    Reflect.deleteProperty(configured, 'intakeConfig')
    f.put(f.configFile, configured)
    const result = f.invoke(['', '', '', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(legacy) && result.stdout.includes(ws2), result.stdout)
    assert.deepEqual(draftOf().values.intakeConfigs, [legacy])
  } finally {
    f.cleanup()
  }
})
