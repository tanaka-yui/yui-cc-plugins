import { readAutoConfig } from '../../lib/auto-config.ts'
import { autoDir } from '../../lib/auto-paths.ts'

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Json } from '../../lib/json.ts'
export const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-test-'))
  const plugin = resolve(import.meta.dirname, '../..')
  const orca = join(dir, 'orca')
  const gh = join(dir, 'gh')
  const bin = join(dir, 'bin')
  for (const path of [orca, gh, bin]) mkdirSync(path)
  const oldPath = process.env.PATH
  Object.assign(process.env, {
    ORCA_DISPATCH_CONFIG_HOME: join(dir, 'config'),
    ORCA_BIN: join(plugin, 'test/lib/orca-stub.sh'),
    ORCA_STUB_DIR: orca,
    GH_STUB_DIR: gh,
    ORCA_AUTO_BIN_DIR: join(dir, 'children'),
    ORCA_AUTO_FREE_MEMORY_MB: '999999',
    ORCA_AUTO_FREE_DISK_MB: '999999',
    ORCA_AUTO_NOW: '2026-11-13T05:30:00Z',
    PATH: `${bin}:${oldPath}`,
  })
  Reflect.deleteProperty(process.env, 'ORCA_TERMINAL_HANDLE')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec '${plugin}/test/lib/gh-stub.sh' "$@"\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const put = (path: string, value: Json) => writeFileSync(path, JSON.stringify(value))
  const respond = (key: string, value: Json, target = gh) => put(join(target, key), value)
  const hook = (key: string, body: string, target = gh) => {
    const path = join(target, `${key}.hook`)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const calls = (target = gh) =>
    existsSync(join(target, 'calls.log')) ? readFileSync(join(target, 'calls.log'), 'utf8') : ''
  mkdirSync(autoDir('main'), { recursive: true })
  const configFile = join(autoDir('main'), 'config.json')
  const raw = {
    version: 1,
    name: 'main',
    intakeConfig: join(dir, 'intake.json'),
    sources: [
      { repo: 'acme/app', related: ['acme/app', 'other/api'] },
      { repo: 'other/api', related: ['other/api'] },
    ],
    repos: {
      'acme/app': { checkout: join(dir, 'checkout'), verify: ['node --test'], verified: true, ci: true },
      'other/api': { checkout: join(dir, 'checkout2'), verify: [], verified: false, ci: false },
    },
    lanes: 1,
  }
  put(configFile, raw)
  put(raw.intakeConfig, { repos: [{ name: 'acme/app' }, { name: 'other/api' }] })
  respond('issue_list', [])
  respond('issue_view', { state: 'OPEN', labels: [{ name: 'Ready' }], title: '題', body: '本文' })
  respond('api', [])
  const config = () => {
    const c = readAutoConfig('main')
    if (!c) throw new Error('bad fixture')
    return c
  }
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(plugin, 'bin/orca-auto.ts'), ...args], { encoding: 'utf8' })
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true })
    process.env.PATH = oldPath
    for (const key of [
      'ORCA_DISPATCH_CONFIG_HOME',
      'ORCA_BIN',
      'ORCA_STUB_DIR',
      'GH_STUB_DIR',
      'ORCA_AUTO_BIN_DIR',
      'ORCA_AUTO_FREE_MEMORY_MB',
      'ORCA_AUTO_FREE_DISK_MB',
      'ORCA_AUTO_NOW',
    ])
      Reflect.deleteProperty(process.env, key)
  }
  return { dir, plugin, orca, gh, bin, raw, put, respond, hook, calls, configFile, config, cli, cleanup }
}
