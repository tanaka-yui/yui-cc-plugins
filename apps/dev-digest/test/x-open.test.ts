import { fakeOrca, orcaCalls, runCli, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, test } from 'node:test'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const LIST_URL = 'https://x.com/i/lists/1'

const setup = (listUrl: string | null = LIST_URL): { log: string; env: Record<string, string> } => {
  const home = tempHome()
  const work = tempHome()
  dirs.push(home, work)
  writeConfig(home, { x: { listUrl, hashtags: ['#AI', '#生成AI'] } })
  const orca = fakeOrca(work)
  return { log: orca.FAKE_ORCA_LOG, env: { ...orca, DEV_DIGEST_HOME: home } }
}

test('XO1 x-open --target list は設定のリスト URL でタブを開き page= だけを出す', () => {
  const { log, env } = setup()
  const result = runCli(['x-open', '--target', 'list'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'page=page-1\n')
  assert.deepEqual(orcaCalls(log), [['tab', 'create', '--url', LIST_URL, '--json']])
})

test('XO2 x-open --target hashtag はハッシュタグの最新順の検索 URL を組み立てる', () => {
  const { log, env } = setup()
  const first = runCli(['x-open', '--target', 'hashtag', '--index', '0'], env)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.stdout, 'page=page-1\n')
  const second = runCli(['x-open', '--target', 'hashtag', '--index', '1'], env)
  assert.equal(second.code, 0, second.stderr)
  assert.deepEqual(orcaCalls(log), [
    ['tab', 'create', '--url', 'https://x.com/search?q=%23AI&f=live', '--json'],
    ['tab', 'create', '--url', 'https://x.com/search?q=%23%E7%94%9F%E6%88%90AI&f=live', '--json'],
  ])
})

test('XO3 URL や余分な引数は受け付けず Orca も呼ばない', () => {
  const { log, env } = setup()
  const cases = [
    ['x-open', '--target', 'list', '--url', 'https://attacker.example/'],
    ['x-open', '--url', 'https://x.com/home'],
    ['x-open', '--target', 'list', 'https://attacker.example/'],
    ['x-open', '--target', 'list', '--index', '0'],
    ['x-open', '--target', 'hashtag'],
    ['x-open', '--target', 'home'],
    ['x-open'],
  ]
  for (const args of cases) {
    const result = runCli(args, env)
    assert.equal(result.code, 2, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
  }
  assert.deepEqual(orcaCalls(log), [])
})

test('XO4 範囲外や数字でない index は exit 2', () => {
  const { log, env } = setup()
  for (const index of ['2', '-1', '1.5', 'a']) {
    const result = runCli(['x-open', '--target', 'hashtag', '--index', index], env)
    assert.equal(result.code, 2, index)
  }
  assert.deepEqual(orcaCalls(log), [])
})

test('XO5 リストが未設定か x.com でなければ exit 2、Orca が page id を返さなければ exit 1', () => {
  const none = setup(null)
  assert.equal(runCli(['x-open', '--target', 'list'], none.env).code, 2)
  const foreign = setup('https://example.com/i/lists/1')
  assert.equal(runCli(['x-open', '--target', 'list'], foreign.env).code, 2)
  assert.deepEqual([...orcaCalls(none.log), ...orcaCalls(foreign.log)], [])

  const { env } = setup()
  const result = runCli(['x-open', '--target', 'list'], { ...env, FAKE_ORCA_TAB: 'noid' })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /browserPageId/)
})
