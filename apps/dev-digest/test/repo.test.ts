import { loadRepos } from '../lib/config.ts'
import { homePaths } from '../lib/paths.ts'
import { loadSecrets, saveWebhook } from '../lib/secrets.ts'
import { runCli, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-digest-repo-'))
  dirs.push(dir)
  return dir
}
const home = (): string => {
  const dir = tempHome()
  dirs.push(dir)
  return dir
}
const gitRepo = (remote: string | null): string => {
  const dir = temp()
  spawnSync('git', ['init', '-q', dir])
  if (remote !== null) spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  return dir
}
const WEBHOOK = 'https://hooks.slack.com/services/T0123/B4567/SECRETTAILVALUE'

const candidate = (path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'o/r',
  displayName: 'o/r',
  path,
  jvnMinSeverity: null,
  devtoTags: ['react'],
  watch: {
    languages: ['ts'],
    packages: [{ name: 'a', ecosystem: 'npm', github: 'o/a' }],
    cloudServices: [],
    keywords: [],
  },
  ...overrides,
})
const saveCandidate = (h: string, value: Record<string, unknown>) => {
  const file = join(temp(), 'candidate.json')
  writeFileSync(file, JSON.stringify(value))
  return runCli(['repo', 'save', '--file', file], { DEV_DIGEST_HOME: h })
}

test('RP1 slug は https と ssh の remote から owner/repo を作る', () => {
  const h = home()
  const remotes = [
    'git@github.com:o/r.git',
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'ssh://git@github.com/o/r.git',
  ]
  for (const remote of remotes) {
    const result = runCli(['repo', 'slug', '--path', gitRepo(remote)], { DEV_DIGEST_HOME: h })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, 'slug=o/r\n', remote)
  }
})

test('RP2 remote の無いディレクトリは basename', () => {
  const dir = gitRepo(null)
  const result = runCli(['repo', 'slug', '--path', dir], { DEV_DIGEST_HOME: home() })
  assert.equal(result.stdout, `slug=${dir.split('/').pop()}\n`)
})

test('RP3 save の 2 回目は addedAt を保ち差分を出す', () => {
  const h = home()
  const dir = temp()
  const first = saveCandidate(h, candidate(dir))
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /created=true\nadded=a\nremoved=\n/)
  const addedAt = loadRepos(h)[0]?.addedAt
  assert.ok(addedAt)
  const second = saveCandidate(
    h,
    candidate(dir, {
      watch: {
        languages: [],
        packages: [{ name: 'b', ecosystem: 'npm', github: null }],
        cloudServices: [],
        keywords: [],
      },
    }),
  )
  assert.match(second.stdout, /created=false\nadded=b\nremoved=a\n/)
  assert.equal(loadRepos(h)[0]?.addedAt, addedAt)
})

test('RP4 list は Webhook を伏せ、show は秘密を含まない', () => {
  const h = home()
  const dir = temp()
  saveCandidate(h, candidate(dir))
  saveCandidate(h, candidate(dir, { slug: 'o/s' }))
  saveWebhook(homePaths(h).secrets, 'o/r', WEBHOOK)
  const list = runCli(['repo', 'list'], { DEV_DIGEST_HOME: h })
  assert.equal(list.code, 0, list.stderr)
  assert.ok(!list.stdout.includes('SECRETTAILVALUE'))
  const lines = list.stdout.trimEnd().split('\n')
  assert.match(
    lines[0] ?? '',
    /^o\/r\t.+\twebhook=https:\/\/hooks\.slack\.com\/services\/T\*\*\*\/…\tjvn=global\tpackages=1$/,
  )
  assert.match(lines[1] ?? '', /\twebhook=global\t/)
  const show = runCli(['repo', 'show', '--slug', 'o/r'], { DEV_DIGEST_HOME: h })
  assert.equal(JSON.parse(show.stdout).slug, 'o/r')
  assert.ok(!show.stdout.includes('SECRETTAILVALUE'))
})

test('RP5 candidate の不正な値は欄の名前つきで exit 2 になり何も保存しない', () => {
  const h = home()
  const dir = temp()
  const bad: Array<[Record<string, unknown>, string]> = [
    [candidate(dir, { slug: 'a/b/c' }), 'slug'],
    [candidate(dir, { slug: 'a b' }), 'slug'],
    [candidate(dir, { devtoTags: ['Re/act'] }), 'devtoTags'],
    [
      candidate(dir, {
        watch: {
          languages: [],
          packages: [{ name: 'x', ecosystem: 'npm', github: 'a/b/c' }],
          cloudServices: [],
          keywords: [],
        },
      }),
      'github',
    ],
    [candidate(join(dir, 'missing')), 'path'],
  ]
  for (const [value, field] of bad) {
    const result = saveCandidate(h, value)
    assert.equal(result.code, 2, field)
    assert.match(result.stderr, new RegExp(field))
  }
  assert.deepEqual(loadRepos(h), [])
})

test('RP6 save は path の realpath を保存する', () => {
  const h = home()
  const dir = temp()
  const link = join(temp(), 'link')
  spawnSync('ln', ['-s', dir, link])
  saveCandidate(h, candidate(link))
  assert.equal(loadRepos(h)[0]?.path, spawnSync('realpath', [dir], { encoding: 'utf8' }).stdout.trim())
})

test('RP7 remove は repo と専用 Webhook を消し 0600 を保つ。未登録は exit 2', () => {
  const h = home()
  const dir = temp()
  saveCandidate(h, candidate(dir))
  saveCandidate(h, candidate(dir, { slug: 'o/s' }))
  const secrets = homePaths(h).secrets
  saveWebhook(secrets, 'o/r', WEBHOOK)
  saveWebhook(secrets, 'o/s', `${WEBHOOK}2`)
  const removed = runCli(['repo', 'remove', '--slug', 'o/r'], { DEV_DIGEST_HOME: h })
  assert.equal(removed.code, 0, removed.stderr)
  assert.ok(!removed.stdout.includes('SECRETTAILVALUE'))
  assert.deepEqual(
    loadRepos(h).map((r) => r.slug),
    ['o/s'],
  )
  assert.deepEqual(Object.keys(loadSecrets(secrets).repos), ['o/s'])
  assert.equal(statSync(secrets).mode & 0o777, 0o600)
  assert.ok(readFileSync(secrets, 'utf8').includes('o/s'))
  const again = runCli(['repo', 'remove', '--slug', 'o/r'], { DEV_DIGEST_HOME: h })
  assert.equal(again.code, 2)
})
