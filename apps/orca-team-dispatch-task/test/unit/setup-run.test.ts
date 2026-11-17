import { autoDir } from '../../lib/auto-paths.ts'
import { runSetup } from '../../lib/auto-setup.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  for (const [repo, r] of Object.entries(f.raw.repos)) gitRepo(r.checkout, repo)
  const home = join(f.dir, 'claude')
  mkdirSync(home)
  process.env.ORCA_AUTO_CLAUDE_HOME = home
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
    '1',
    '',
    '',
    f.raw.repos['acme/app'].checkout,
    '',
    '',
    '',
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
    f.cleanup()
  }
  return { ...f, home, invoke, freshAnswers, fresh, rerun, cleanup }
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
    answers[5] = 'acme/3'
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
    answers[18] = 'n'
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
    assert.deepEqual(after, raw)
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
    const result = f.rerun({ 'Server の acme/app の checkout': '2', 'config.json を書きますか': 'y' })
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
    const result = f.invoke([f.raw.intakeConfig, '1', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.equal(existsSync(f.configFile), false)
    const draft = JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'))
    assert.deepEqual(draft.done, ['prereq', 'sources'])
    const rest = f.freshAnswers().slice(3)
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
