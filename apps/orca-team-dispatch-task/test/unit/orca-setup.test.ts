// make setup（普段の設定。bin/orca-setup.ts / lib/settings-setup.ts）。SE1〜SE6
import { autoDir } from '../../lib/auto-paths.ts'
import { globalConfigFile, OPUS_MODEL, TOGGLE_KEYS } from '../../lib/config.ts'
import { SETUP_DRAFT_FILE } from '../../lib/setup-draft.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ENTER_WORKERS = Array(12).fill('')
const ENTER_TOGGLES = Array(TOGGLE_KEYS.length).fill('')
const prepare = () => {
  const f = fixture()
  const setups = (base: string | null) => ({
    ok: true,
    result: {
      setups: [
        { id: 's1', hostId: 'local', kind: 'git', path: f.dir, displayName: 'app', worktreeBasePath: base },
        { id: 's2', hostId: 'local', kind: 'folder', path: f.dir, displayName: 'run', worktreeBasePath: null },
        { id: 's3', hostId: 'remote', kind: 'git', path: f.dir, displayName: 'far', worktreeBasePath: null },
      ],
    },
  })
  f.respond('project_setups', setups(null), f.orca)
  // setup-update が受けた path を一覧に写す（Orca が値を変えたことを読み直しで確かめるため）
  const applyOnUpdate = () => {
    const hook = join(f.orca, 'project_setup-update.hook')
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --worktree-base-path ] && p="$2"; shift; done\nnode -e 'const [f,p]=process.argv.slice(1);const j=JSON.parse(require("fs").readFileSync(f));j.result.setups[0].worktreeBasePath=p;require("fs").writeFileSync(f,JSON.stringify(j))' '${join(f.orca, 'project_setups')}' "$p"\n`,
    )
    chmodSync(hook, 0o755)
  }
  const invoke = (answers: string[], tty = true) =>
    spawnSync(process.execPath, [join(f.plugin, 'bin/orca-setup.ts'), '--name', 'main'], {
      input: `${answers.join('\n')}\n`,
      env: { ...process.env, ORCA_AUTO_TEST_STDIN: tty ? '1' : '' },
      encoding: 'utf8',
    })
  const autoConfig = () => JSON.parse(readFileSync(join(autoDir('main'), 'config.json'), 'utf8'))
  return { f, setups, applyOnUpdate, invoke, autoConfig }
}

test('SE1 changes only what was answered and keeps unknown keys in the global layer', () => {
  const { f, applyOnUpdate, invoke, autoConfig } = prepare()
  try {
    mkdirSync(join(f.dir, 'config'), { recursive: true })
    writeFileSync(globalConfigFile(), JSON.stringify({ custom: 1 }))
    const before = autoConfig()
    applyOnUpdate()
    const workspace = join(f.dir, 'ebs', 'worktrees')
    const r = invoke([
      '',
      'gpt-6.2-sol', // claude の役に codex の model は断る
      'sonnet',
      'bogus', // claude の effort ではない
      'high',
      ...Array(9).fill(''),
      'maybe', // review_mode の値ではない
      'on',
      ...Array(7).fill(''),
      'y',
      '',
      'medium',
      '1',
      workspace,
      'y',
      'y',
      '',
    ])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /gpt-6\.2-sol は codex の model です/)
    assert.match(r.stdout, /claude の effort ではありません/)
    assert.match(r.stdout, /on \/ off のどれかを入力してください/)
    assert.deepEqual(JSON.parse(readFileSync(globalConfigFile(), 'utf8')), {
      custom: 1,
      review_mode: 'on',
      roles: { design: { model: 'sonnet', effort: 'high' } },
    })
    assert.deepEqual(autoConfig(), { ...before, judge: { model: OPUS_MODEL, effort: 'medium' } })
    assert.equal(existsSync(workspace), true)
    assert.match(
      f.calls(f.orca),
      new RegExp(`project setup-update --setup s1 --worktree-base-path ${workspace} --json`),
    )
    // folder と遠くのマシンの setup は一覧に出さない
    assert.doesNotMatch(r.stdout, /2\. run|far/)
    assert.match(r.stdout, /変えました/)
  } finally {
    f.cleanup()
  }
})

test('SE2 Enter everywhere writes nothing and calls no setup-update', () => {
  const { f, invoke, autoConfig } = prepare()
  try {
    const before = autoConfig()
    const r = invoke([...ENTER_WORKERS, ...ENTER_TOGGLES, '', '', ''])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(globalConfigFile()), false)
    assert.deepEqual(autoConfig(), before)
    assert.doesNotMatch(f.calls(f.orca), /setup-update/)
    assert.match(r.stdout, /作業場所: Orca の既定/)
  } finally {
    f.cleanup()
  }
})

test('SE3 an unfinished auto-setup skips only the judge stage', () => {
  const { f, invoke, autoConfig } = prepare()
  try {
    writeFileSync(
      join(autoDir('main'), SETUP_DRAFT_FILE),
      JSON.stringify({ version: 1, name: 'main', done: [], values: {} }),
    )
    const before = autoConfig()
    const r = invoke([...ENTER_WORKERS, ...ENTER_TOGGLES, ''])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /make auto-setup main が途中です/)
    assert.doesNotMatch(r.stdout, /判定役の model/)
    assert.deepEqual(autoConfig(), before)
  } finally {
    f.cleanup()
  }
})

test('SE4 not a terminal writes nothing and exits 2; ended input exits 2', () => {
  const { f, invoke } = prepare()
  try {
    const r = invoke(['', 'sonnet'], false)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ターミナルで make setup を実行してください/)
    const ended = invoke(['', 'sonnet'])
    assert.equal(ended.status, 2)
    assert.equal(existsSync(globalConfigFile()), false)
  } finally {
    f.cleanup()
  }
})

test('SE5 a setup-update Orca did not apply is reported and exits 1', () => {
  const { f, invoke } = prepare()
  try {
    const r = invoke([...ENTER_WORKERS, ...ENTER_TOGGLES, '', '', '1', f.dir, 'y', ''])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /Orca が作業場所を変えませんでした/)
    assert.match(r.stdout, /checkout と同じディスク/)
  } finally {
    f.cleanup()
  }
})

test('SE6 without an --auto config the judge stage is skipped', () => {
  const { f } = prepare()
  try {
    const r = spawnSync(process.execPath, [join(f.plugin, 'bin/orca-setup.ts'), '--name', 'work'], {
      input: `${[...ENTER_WORKERS, ...ENTER_TOGGLES, ''].join('\n')}\n`,
      env: { ...process.env, ORCA_AUTO_TEST_STDIN: '1' },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /make auto-setup work を先に実行してください/)
  } finally {
    f.cleanup()
  }
})
