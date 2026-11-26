import { LEARN_PLUGIN_REPO } from '../../lib/auto-learn.ts'
import { autoDir } from '../../lib/auto-paths.ts'
import { runSetup } from '../../lib/auto-setup.ts'
import { releaseLock, takeLock } from '../../lib/auto-state.ts'
import { fixture } from '../lib/auto-fixture.ts'
import { readClaudeStubArgs, readClaudeStubPwd, writeClaudeStub } from '../lib/claude-stub.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import type { SetupCommand } from '../../lib/auto-setup.ts'

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
  // setup は checkout の置き場所が確かめられた組を verified にするので、置き場所のある fixture は確認済みで始める
  f.raw.repos['other/api'].verified = true
  f.put(f.configFile, f.raw)
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
    // 判定の学びを改善の Issue として出すか（既定は n）
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
    // merge したあと Issue を閉じるか（既定は n）
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
  // 配列の答えは同じ問いに順に返し、尽きたら既定値に戻る（make repos の一覧の操作のように繰り返す問い）
  const rerun = (overrides: Record<string, string | string[]> = {}, only?: SetupCommand) => {
    let output = ''
    const asked: string[] = []
    const answer = (q: string): string | undefined => {
      const value = Object.entries(overrides).find(([key]) => q.includes(key))?.[1]
      return Array.isArray(value) ? value.shift() : value
    }
    const code = runSetup(
      'main',
      {
        ask: (q, fallback) => {
          asked.push(q)
          return answer(q) ?? fallback ?? ''
        },
        confirm: (q) => {
          asked.push(q)
          return answer(q) === 'y'
        },
      },
      (text) => {
        output += text
      },
      only,
    )
    return { code, output, asked }
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
    // 確認コマンドは保存するだけで走らせない
    assert.deepEqual(config.repos['acme/app']?.verify, [`echo ran >> '${join(f.dir, 'verify.log')}'`])
    assert.equal(existsSync(join(f.dir, 'verify.log')), false)
    assert.ok(f.calls(f.orca).includes('--disabled'))
    assert.ok(f.calls(f.orca).includes('automations edit a1 --enabled'))
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
    writeFileSync(join(f.orca, 'calls.log'), '')
    const again = f.invoke(Array(100).fill(''))
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.deepEqual(f.config(), config)
    assert.equal(existsSync(join(f.dir, 'verify.log')), false)
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
    answers[8] = 'acme/3'
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
    answers[22] = 'n'
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
test('SU30c legacy hand-written config preserves omitted defaults and commands without running them', () => {
  const f = prepare()
  try {
    f.put(f.configFile, {
      ...f.raw,
      repos: {
        ...f.raw.repos,
        'other/api': {
          ...f.raw.repos['other/api'],
          verify: [`echo ran >> '${join(f.dir, 'verify.log')}'`],
          verified: true,
        },
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
    'other/api': { selector: `path:${f.raw.repos['other/api'].checkout}`, verified: true },
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
test('SU30e changing checkout is verified by its path without running the commands', () => {
  const f = prepare()
  try {
    assert.equal(f.fresh().status, 0)
    const checkout = join(f.dir, 'checkout-b')
    gitRepo(checkout, 'acme/app')
    const result = f.rerun({
      'acme/app のこのマシンの checkout': checkout,
      'config.json を書きますか': 'y',
      有効にしますか: 'y',
    })
    assert.equal(result.code, 0, result.output)
    assert.equal(f.config().repos['acme/app']?.checkout, checkout)
    assert.equal(f.config().repos['acme/app']?.verified, true)
    assert.equal(f.config().hosts?.[0]?.repos['acme/app']?.verified, true)
    assert.match(result.output, new RegExp(`acme/app: ${checkout} を確かめました`))
    assert.ok(!result.asked.some((q) => q.includes('走らせて')), result.asked.join('\n'))
    assert.equal(existsSync(join(f.dir, 'verify.log')), false)
  } finally {
    f.cleanup()
  }
})
test('SU30f changed remote selector is verified from the Orca list without a terminal', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    const result = f.rerun({
      'Server の acme/app の checkout': '2',
      'config.json を書きますか': 'y',
    })
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.config().hosts?.[1]?.repos['acme/app'], { selector: 'id:R2', verified: true, measure: null })
    assert.match(result.output, /Server: acme\/app: \/remote\/app2 を確かめました/)
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
    const result = f.invoke(['', '', '', '', 'y', ''])
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
        repos: { 'other/api': { selector: `path:${f.raw.repos['other/api'].checkout}`, verified: true } },
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
    const result = f.invoke([f.raw.intakeConfig, '', '1', '', '', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.equal(existsSync(f.configFile), false)
    const draft = JSON.parse(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'))
    assert.deepEqual(draft.done, ['prereq', 'sources'])
    const rest = f.freshAnswers().slice(6)
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
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(f.config().repos['acme/app']?.verify, ['echo ok'])
    assert.equal(f.config().repos['acme/app']?.verified, true)
    for (const text of ['AI の案: echo ok', '必要な道具: sh, definitely-not-a-tool-xyz'])
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
      'config.json を書きますか': 'y',
    })
    assert.equal(r.code, 0, r.output)
    assert.ok(r.output.includes('AI の案を作れませんでした: claude を起動できません'), r.output)
    assert.deepEqual(f.config().repos['other/api']?.verify, ['echo typed'])
  } finally {
    f.cleanup()
  }
})
const measuredPair = {
  selector: 'id:R',
  verified: true,
  measure: { peakMemoryMb: 3000, diskGrowthMb: 700, measuredAt: '2026-11-13T05:30:00Z' },
}
test('SU36 a remote pair is verified from the Orca list, keeps its measure and never opens a terminal', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, {
      ...f.raw,
      hosts: [localHost(f), { ...remoteHost, repos: { 'acme/app': { ...measuredPair, verified: false } } }],
    })
    const r = f.rerun({ 'config.json を書きますか': 'y' })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app'], measuredPair)
    assert.ok(r.output.includes('Server: acme/app: /remote/app を確かめました'), r.output)
    assert.ok(r.output.includes('1 worktree: メモリ 6000 MB・ディスク 1400 MB（測った値）'), r.output)
    assert.ok(!f.calls(f.orca).includes('terminal create'))
  } finally {
    f.cleanup()
  }
})
test('SU37 a remote pair whose origin Orca cannot tell is not verified', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.hook(
      'repo_list',
      `case " $* " in *' --environment '*) printf '%s' '{"ok":true,"result":{"repos":[{"id":"R","path":"/remote/app"}]}}' > "$ORCA_STUB_DIR/repo_list" ;; *) printf '%s' '{"ok":true,"result":{"repos":[]}}' > "$ORCA_STUB_DIR/repo_list" ;; esac`,
      f.orca,
    )
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    const r = f.rerun({ 'config.json を書きますか': 'y' }, 'hosts')
    assert.equal(r.code, 0, r.output)
    assert.equal(f.config().hosts?.find((h) => h.id === 'env-1')?.repos['acme/app']?.verified, false)
    assert.ok(r.output.includes('Server: acme/app: /remote/app の origin が acme/app だと確かめられません'), r.output)
    assert.ok(!f.calls(f.orca).includes('terminal create'))
  } finally {
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
    const result = f.invoke(['', '', '1,2', '', '', '', '', '']) // 番号は既定（全部）、ほかは無し、拾う元 1,2、拾う条件と auto-ready を 2 つずつ、学びの Issue、次の段で入力が尽きる
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
    const result = f.invoke(['-', '', '1', 'relative.json', missing, f.raw.intakeConfig, '', '1,2', '', '', '', '', ''])
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
    const result = f.invoke(['', '', '1', '', '', ''])
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
    const result = f.invoke(['', '', '', '', '', ''])
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(legacy) && result.stdout.includes(ws2), result.stdout)
    assert.deepEqual(draftOf().values.intakeConfigs, [legacy])
  } finally {
    f.cleanup()
  }
})
test('SU40 roles changes only review_mode and phase_b and leaves automation and draft alone', () => {
  const f = prepare()
  try {
    const before = f.config()
    const result = f.rerun(
      { review_mode: 'on', phase_b: 'on', closeOnMerge: 'y', 'config.json を書きますか': 'y' },
      'roles',
    )
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.config(), { ...before, roles: { review_mode: 'on', phase_b: 'on' }, closeOnMerge: true })
    assert.deepEqual(
      result.asked.map((q) => q.split(' ')[0]),
      ['review_mode', 'phase_b', 'closeOnMerge:', 'この内容で'],
    )
    assert.match(result.output, /1 件が使う worktree: 対象1つ=4、対象2つ=8/)
    assert.equal(f.calls(f.orca), '')
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
  } finally {
    f.cleanup()
  }
})
test('SU40b roles with Enter only writes nothing', () => {
  const f = prepare()
  try {
    const { intakeConfig, ...rest } = f.raw
    f.put(f.configFile, { ...rest, intakeConfigs: [intakeConfig] })
    const before = readFileSync(f.configFile, 'utf8')
    const result = f.rerun({}, 'roles')
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /変わる所はありません/)
    assert.equal(readFileSync(f.configFile, 'utf8'), before)
  } finally {
    f.cleanup()
  }
})
test('SU41 hosts asks only machines, checks and lanes, and a changed selector is checked again by its path', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, { ...f.raw, hosts: [localHost(f), remoteHost] })
    const result = f.rerun(
      {
        'Server の acme/app の checkout': '2',
        'config.json を書きますか': 'y',
      },
      'hosts',
    )
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.config().hosts?.[1]?.repos['acme/app'], { selector: 'id:R2', verified: true, measure: null })
    assert.ok(!result.asked.some((q) => /intake|review_mode|判定の間隔/.test(q)), result.asked.join('\n'))
    assert.ok(!f.calls(f.orca).includes('automations'))
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
  } finally {
    f.cleanup()
  }
})
test('SU42 hosts and roles refuse without config and during an unfinished setup', () => {
  const f = prepare()
  try {
    const raw = readFileSync(f.configFile, 'utf8')
    rmSync(f.configFile)
    const missing = f.rerun({}, 'roles')
    assert.equal(missing.code, 1)
    assert.match(missing.output, /先に make auto-setup main を最後まで実行してください/)
    writeFileSync(f.configFile, raw)
    const draft = `${JSON.stringify({ version: 1, name: 'main', done: ['prereq'], values: {} })}\n`
    writeFileSync(join(autoDir('main'), 'setup.json'), draft)
    const during = f.rerun({ review_mode: 'on' }, 'hosts')
    assert.equal(during.code, 1)
    assert.match(during.output, /make auto-setup main が途中です/)
    assert.equal(readFileSync(join(autoDir('main'), 'setup.json'), 'utf8'), draft)
    assert.equal(readFileSync(f.configFile, 'utf8'), raw)
  } finally {
    f.cleanup()
  }
})
test('SU43 hosts, roles and repos refuse non-tty stdin', () => {
  const f = prepare()
  try {
    for (const command of ['hosts', 'roles', 'repos']) {
      const result = spawnSync(process.execPath, [join(f.plugin, 'bin/orca-auto.ts'), command, '--name', 'main'], {
        input: '\n',
        env: { ...process.env, ORCA_AUTO_TEST_STDIN: '' },
        encoding: 'utf8',
      })
      assert.equal(result.status, 2, result.stdout + result.stderr)
      assert.match(result.stderr, new RegExp(`make ${command}`))
    }
  } finally {
    f.cleanup()
  }
})
test('SU48 repos adds a repository from the menu, registers it on the machine and approves the judge rules without enabling', () => {
  const f = prepare()
  try {
    assert.equal(f.fresh().status, 0)
    const fingerprint = f.config().automation?.acceptedFingerprint
    const related = [...(f.config().sources[0]?.related ?? []), 'acme/web']
    const checkout = join(f.dir, 'checkout3')
    gitRepo(checkout, 'acme/web')
    const callsBefore = f.calls(f.orca)
    const result = f.rerun(
      {
        '=追加': ['a'],
        追加するリポジトリ: 'acme/web',
        'acme/web のこのマシンの checkout': checkout,
        'config.json を書きますか': 'y',
        この権限を書きますか: 'y',
      },
      'repos',
    )
    assert.equal(result.code, 0, result.output)
    const config = f.config()
    assert.deepEqual(config.sources[0]?.related, related)
    assert.equal(config.repos['acme/web']?.checkout, checkout)
    assert.notEqual(config.automation?.acceptedFingerprint, fingerprint)
    const rules = JSON.parse(readFileSync(join(autoDir('main'), '.claude/settings.json'), 'utf8'))
    assert.ok(
      rules.permissions.allow.some((rule: string) => rule.startsWith(`Read(/${checkout}`)),
      JSON.stringify(rules),
    )
    assert.ok(
      !result.asked.some((q) => /intake|拾う条件|Project|review_mode|判定の間隔/.test(q)),
      result.asked.join('\n'),
    )
    const added = f.calls(f.orca).slice(callsBefore.length)
    assert.ok(added.includes(checkout), added)
    assert.ok(!added.includes('automations'), added)
    assert.equal(existsSync(join(autoDir('main'), 'setup.json')), false)
  } finally {
    f.cleanup()
  }
})
test('SU49 repos declining the judge rules keeps the old approval and says ticks stop until approved', () => {
  const f = prepare()
  try {
    assert.equal(f.fresh().status, 0)
    const fingerprint = f.config().automation?.acceptedFingerprint
    const checkout = join(f.dir, 'checkout3')
    gitRepo(checkout, 'acme/web')
    const result = f.rerun(
      {
        '=追加': ['a'],
        追加するリポジトリ: 'acme/web',
        'acme/web のこのマシンの checkout': checkout,
        'config.json を書きますか': 'y',
      },
      'repos',
    )
    assert.equal(result.code, 0, result.output)
    assert.equal(f.config().repos['acme/web']?.checkout, checkout)
    assert.equal(f.config().automation?.acceptedFingerprint, fingerprint)
    assert.match(result.output, /判定の権限は書いていません。.*make repos main をやり直して承認してください/)
  } finally {
    f.cleanup()
  }
})
test('SU51 repos changes a checkout and removes a repository from the menu, keeping at least one', () => {
  const f = prepare()
  try {
    f.put(f.configFile, { ...f.raw, automation: { id: 'a1', acceptedFingerprint: null } })
    const moved = join(f.dir, 'checkout-moved')
    gitRepo(moved, 'acme/app')
    const result = f.rerun(
      {
        '拾う元の Issue のリポジトリ': '1',
        '=追加': ['x', 'c', 'd', 'd'],
        番号: ['1', '2', '1'],
        'acme/app のこのマシンの checkout': moved,
        'config.json を書きますか': 'y',
      },
      'repos',
    )
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /a・c・d のどれか/)
    assert.match(result.output, /1 つは残してください/)
    const config = f.config()
    assert.deepEqual(config.sources[0]?.related, ['acme/app'])
    assert.equal(config.repos['acme/app']?.checkout, moved)
    // ほかの拾う元が使うリポジトリは残る
    assert.ok(config.repos['other/api'])
    assert.match(result.output, /判定の権限は書いていません/)
  } finally {
    f.cleanup()
  }
})
test('SU52 a new repository defaults to the same-named folder next to an existing checkout, and setup numbers the checkouts', () => {
  const f = prepare()
  try {
    f.put(f.configFile, { ...f.raw, automation: { id: 'a1', acceptedFingerprint: null } })
    const web = join(f.dir, 'web')
    gitRepo(web, 'acme/web')
    const added = f.rerun(
      {
        '拾う元の Issue のリポジトリ': '1',
        '=追加': ['a'],
        追加するリポジトリ: 'acme/web',
        'config.json を書きますか': 'y',
      },
      'repos',
    )
    assert.equal(added.code, 0, added.output)
    assert.equal(f.config().repos['acme/web']?.checkout, web)
    // 同名のフォルダが別のリポジトリなら既定値にしない（Enter だけでは進めない）
    gitRepo(join(f.dir, 'mobile'), 'acme/other')
    const mobile = join(f.dir, 'mobile-app')
    gitRepo(mobile, 'acme/mobile')
    const wrong = f.rerun(
      {
        '拾う元の Issue のリポジトリ': '1',
        '=追加': ['a'],
        追加するリポジトリ: 'acme/mobile',
        'acme/mobile のこのマシンの checkout': ['', mobile],
      },
      'repos',
    )
    assert.match(wrong.output, /checkout は絶対パスで入力してください/)
    const setup = f.rerun({ 'config.json を書きますか': 'n' })
    assert.ok(
      setup.asked.some((q) => q.startsWith('(1/') && q.includes('のこのマシンの checkout')),
      setup.asked.join('\n'),
    )
  } finally {
    f.cleanup()
  }
})
test('SU50 repos with Enter only writes nothing and keeps the approval', () => {
  const f = prepare()
  try {
    assert.equal(f.fresh().status, 0)
    const before = readFileSync(f.configFile, 'utf8')
    const callsBefore = f.calls(f.orca)
    const result = f.rerun({}, 'repos')
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /変わる所はありません/)
    assert.match(result.output, /判定の権限は承認済みです/)
    assert.equal(readFileSync(f.configFile, 'utf8'), before)
    assert.ok(!f.calls(f.orca).slice(callsBefore.length).includes('automations'))
  } finally {
    f.cleanup()
  }
})
const withBranches = (f: ReturnType<typeof prepare>, names: string[], defaultBranch: string) => {
  writeFileSync(join(f.gh, 'api'), `${names.join('\n')}\n`)
  f.respond('repo_view', { defaultBranchRef: { name: defaultBranch } })
}
const insertAfterCheckout = (f: ReturnType<typeof prepare>, extra: string[]) => {
  const answers = f.freshAnswers()
  answers.splice(answers.indexOf(f.raw.repos['acme/app'].checkout) + 1, 0, ...extra)
  return answers
}
test('SU44 asks the usual base and candidates when two or more branches exist, validates, and shows current values on rerun', () => {
  const f = prepare()
  try {
    withBranches(f, ['develop', 'main', 'feature/x'], 'main')
    rmSync(f.configFile)
    // 候補に無い向き先と重複した候補は弾かれて尋ね直される
    const result = f.invoke(
      insertAfterCheckout(f, ['staging', 'develop,main', 'develop', 'develop,develop', 'develop', 'develop,main']),
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /普段の向き先は候補に含めてください/)
    assert.match(result.stdout, /候補に重複があります/)
    assert.deepEqual(
      [f.config().repos['acme/app']?.baseBranch, f.config().repos['acme/app']?.branches],
      ['develop', ['develop', 'main']],
    )
    assert.ok(f.calls().includes('repos/acme/app/branches'))
    const again = f.rerun({ 書きますか: 'y' })
    assert.equal(again.code, 0, again.output)
    assert.ok(again.asked.some((q) => q.includes('acme/app') && q.includes('普段の向き先')))
    assert.deepEqual(
      [f.config().repos['acme/app']?.baseBranch, f.config().repos['acme/app']?.branches],
      ['develop', ['develop', 'main']],
    )
    const changed = f.rerun({ 書きますか: 'y', 普段の向き先: 'main', 向き先の候補: 'main,develop' })
    assert.equal(changed.code, 0, changed.output)
    assert.deepEqual(
      [f.config().repos['acme/app']?.baseBranch, f.config().repos['acme/app']?.branches],
      ['main', ['main', 'develop']],
    )
    assert.equal(f.rerun({ 書きますか: 'y' }).code, 0)
    assert.deepEqual(
      [f.config().repos['acme/app']?.baseBranch, f.config().repos['acme/app']?.branches],
      ['main', ['main', 'develop']],
    )
  } finally {
    f.cleanup()
  }
})
test('SU46 asks autoMerge only for a source that answered yes to auto-ready, defaulting to the current value', () => {
  const f = prepare()
  try {
    // auto-ready を使わない（既定）なら autoMerge は尋ねない
    const plain = f.rerun({ 書きますか: 'y' })
    assert.equal(plain.code, 0, plain.output)
    assert.ok(!plain.asked.some((q) => q.includes('autoMerge')))
    assert.equal(f.config().sources[0]?.autoMerge, false)
    // auto-ready を使うと答えたら autoMerge を尋ねる。答えが yes なら設定に残る
    const on = f.rerun({ 'auto-ready を使います': 'y', 'autoMerge を使います': 'y', 書きますか: 'y' })
    assert.equal(on.code, 0, on.output)
    const autoReadyAt = on.asked.findIndex((q) => q.includes('auto-ready を使います'))
    assert.ok(autoReadyAt >= 0 && on.asked[autoReadyAt + 1]?.includes('autoMerge を使います'), on.asked.join('\n'))
    assert.equal(f.config().sources[0]?.autoReady, true)
    assert.equal(f.config().sources[0]?.autoMerge, true)
    // もう一度流すと、現在の値が既定になる
    const again = f.rerun({ 書きますか: 'y' })
    assert.equal(again.code, 0, again.output)
    assert.equal(f.config().sources[0]?.autoMerge, true)
    // auto-ready をやめたら autoMerge も残らない
    const off = f.rerun({ 'auto-ready を使います': 'n', 書きますか: 'y' })
    assert.equal(off.code, 0, off.output)
    assert.ok(!off.asked.some((q) => q.includes('autoMerge')))
    assert.equal(f.config().sources[0]?.autoReady, false)
    assert.equal(f.config().sources[0]?.autoMerge, false)
  } finally {
    f.cleanup()
  }
})
test('LN21 setup の質問は権限があれば y を受け付けて issueRepo を残し、権限が無ければ断って null のまま、拾う元は変えない', () => {
  const f = prepare()
  try {
    const question = '改善の Issue として出しますか'
    // gh api repos/<repo> --jq .permissions.push の応答（スタブの鍵は api_repos/<owner>/<name>）
    const permission = (value: string) => {
      const path = join(f.gh, `api_repos/${LEARN_PLUGIN_REPO}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${value}\n`)
    }
    const before = f.config().sources
    // 既定は n。gh を読まない
    const plain = f.rerun({ 書きますか: 'y' })
    assert.equal(plain.code, 0, plain.output)
    assert.ok(plain.asked.some((q) => q.includes(`判定の学びを、${LEARN_PLUGIN_REPO} の${question}（y/n）`)))
    assert.ok(!f.calls().includes(`repos/${LEARN_PLUGIN_REPO}`))
    assert.deepEqual(f.config().learn, { issueRepo: null })
    // 権限が無ければ y でも断って null のまま
    permission('false')
    const denied = f.rerun({ [question]: 'y', 書きますか: 'y' })
    assert.equal(denied.code, 0, denied.output)
    assert.match(denied.output, /書き込む権限が無いので出せません/)
    assert.deepEqual(f.config().learn, { issueRepo: null })
    // 権限があれば y を受け付け、1 台だけにする注意を 1 行出す。拾う元は変えない
    permission('true')
    const on = f.rerun({ [question]: 'y', 書きますか: 'y' })
    assert.equal(on.code, 0, on.output)
    assert.ok(
      on.output.includes(
        `同じリポジトリを拾う --auto は 1 台だけにしてください。${LEARN_PLUGIN_REPO} を拾う元に入れた --auto が、改善の Issue を実装します`,
      ),
      on.output,
    )
    assert.deepEqual(f.config().learn, { issueRepo: LEARN_PLUGIN_REPO })
    assert.deepEqual(f.config().sources, before)
    // 再実行では今の値が既定
    assert.equal(f.rerun({ 書きますか: 'y' }).code, 0)
    assert.deepEqual(f.config().learn, { issueRepo: LEARN_PLUGIN_REPO })
    // n にすると設定から消える
    assert.equal(f.rerun({ [question]: 'n', 書きますか: 'y' }).code, 0)
    assert.deepEqual(f.config().learn, { issueRepo: null })
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.configFile, 'utf8')), 'learn'), false)
    assert.deepEqual(f.config().sources, before)
  } finally {
    f.cleanup()
  }
})
test('SU45 asks nothing and writes no base fields when fewer than two candidate branches exist', () => {
  const f = prepare()
  try {
    withBranches(f, ['main', 'feature/x'], 'main')
    const result = f.fresh()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout, /普段の向き先/)
    assert.equal(f.config().repos['acme/app']?.baseBranch, null)
    assert.deepEqual(f.config().repos['acme/app']?.branches, [])
    assert.ok(!readFileSync(f.configFile, 'utf8').includes('baseBranch'))
    assert.ok(!f.rerun().asked.some((q) => q.includes('普段の向き先')))
  } finally {
    f.cleanup()
  }
})
test('SU47 the machine prompt says several numbers are allowed and first selects every listed machine', () => {
  const f = prepare()
  try {
    remoteResponses(f)
    f.put(f.configFile, f.raw)
    const seen: Array<{ q: string; fallback: string | undefined }> = []
    runSetup(
      'main',
      {
        ask: (q, fallback) => {
          if (q.includes('使うマシンの番号')) seen.push({ q, fallback })
          return fallback ?? ''
        },
        confirm: (q) => q.includes('マシンの構成を変えますか'),
      },
      () => {},
      'hosts',
    )
    assert.equal(seen.length, 1)
    assert.ok(seen[0]?.q.includes('カンマ区切りで複数可'), seen[0]?.q)
    assert.equal(seen[0]?.fallback, '1,2')
  } finally {
    f.cleanup()
  }
})
