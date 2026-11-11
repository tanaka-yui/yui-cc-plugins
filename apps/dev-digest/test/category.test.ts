import { loadConfig } from '../lib/config.ts'
import { homePaths } from '../lib/paths.ts'
import { loadSecrets, saveWebhook } from '../lib/secrets.ts'
import { runCli, tempHome, writeConfig } from './helpers.ts'

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, test } from 'node:test'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const URL_S = 'https://hooks.slack.com/services/T2/B2/sec'

const setup = (): { home: string; env: Record<string, string> } => {
  const home = tempHome()
  homes.push(home)
  writeConfig(home, { x: { listUrl: 'https://x.com/i/lists/1', hashtags: ['#AI'] } })
  return { home, env: { DEV_DIGEST_HOME: home } }
}

test('CA1 set はカテゴリを作り、指定した欄だけを変える。list に出る', () => {
  const { home, env } = setup()
  const created = runCli(
    ['category', 'set', '--id', 'k8s', '--title', 'Kubernetes', '--feeds', 'https://kubernetes.io/feed.xml'],
    env,
  )
  assert.equal(created.code, 0, created.stderr)
  assert.match(created.stdout, /^saved id=k8s created=true$/m)
  assert.equal(runCli(['category', 'set', '--id', 'k8s', '--keywords', 'kubectl,helm'], env).code, 0)
  assert.deepEqual(loadConfig(home)?.categories, [
    { id: 'k8s', title: 'Kubernetes', feeds: ['https://kubernetes.io/feed.xml'], keywords: ['kubectl', 'helm'] },
  ])
  const listed = runCli(['category', 'list'], env).stdout
  assert.match(listed, /^aws\tbuiltin\tenabled\tchannel=global\texclude=none$/m)
  assert.match(
    listed,
    /^k8s\tcustom\tenabled\ttitle=Kubernetes\tfeeds=https:\/\/kubernetes\.io\/feed\.xml\tkeywords=kubectl,helm/m,
  )
  assert.match(listed, /^exclude_common=none$/m)
})

test('CA2 set は不正な id・組み込みと重なる id・http でないフィード・中身の無いカテゴリを拒む', () => {
  const { home, env } = setup()
  assert.equal(runCli(['category', 'set', '--id', 'Bad_ID', '--title', 't', '--keywords', 'a'], env).code, 2)
  assert.equal(runCli(['category', 'set', '--id', 'aws', '--title', 't', '--keywords', 'a'], env).code, 2)
  assert.equal(runCli(['category', 'set', '--id', 'f', '--title', 't', '--feeds', 'javascript:alert(1)'], env).code, 2)
  assert.equal(runCli(['category', 'set', '--id', 'empty', '--title', 't'], env).code, 2)
  assert.equal(runCli(['category', 'set', '--id', 'nt', '--keywords', 'a'], env).code, 2)
  assert.deepEqual(loadConfig(home)?.categories, [])
})

test('CA3 remove は追加カテゴリとその除外ワード・専用 Webhook を消し、組み込みは消せない', () => {
  const { home, env } = setup()
  assert.equal(runCli(['category', 'set', '--id', 'ai', '--title', 'AI', '--keywords', 'LLM'], env).code, 0)
  assert.equal(runCli(['category', 'exclude', '--id', 'ai', '--words', 'ad'], env).code, 0)
  saveWebhook(homePaths(home).secrets, 'section:ai', URL_S)
  const removed = runCli(['category', 'remove', '--id', 'ai'], env)
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, /^removed id=ai webhook=true$/m)
  assert.deepEqual(loadConfig(home)?.categories, [])
  assert.deepEqual(loadConfig(home)?.categoryExclude, {})
  assert.deepEqual(loadSecrets(homePaths(home).secrets).sections, {})
  assert.equal(runCli(['category', 'remove', '--id', 'aws'], env).code, 2)
  assert.equal(runCli(['category', 'remove', '--id', 'none-such'], env).code, 2)
})

test('CA4 disable / enable は組み込みのカテゴリだけ。X を止めると手順書は X を読ませない', () => {
  const { home, env } = setup()
  assert.equal(runCli(['category', 'disable', '--id', 'x'], env).code, 0)
  assert.deepEqual(loadConfig(home)?.disabledSections, ['x'])
  const procedure = runCli(['procedure'], env)
  assert.equal(procedure.code, 0, procedure.stderr)
  assert.ok(!procedure.stdout.includes('x-open --target'))
  assert.match(runCli(['category', 'list'], env).stdout, /^x\tbuiltin\tdisabled/m)
  assert.equal(runCli(['category', 'enable', '--id', 'x'], env).code, 0)
  assert.deepEqual(loadConfig(home)?.disabledSections, [])
  assert.ok(runCli(['procedure'], env).stdout.includes('x-open --target list'))
  assert.equal(runCli(['category', 'disable', '--id', 'releases'], env).code, 2)
})

test('CA5 exclude は --id が無ければ共通、あればそのカテゴリの除外ワードを置き換え、none で消す', () => {
  const { home, env } = setup()
  assert.equal(runCli(['category', 'exclude', '--words', 'beginner, PR'], env).code, 0)
  assert.equal(runCli(['category', 'exclude', '--id', 'devto', '--words', 'tutorial'], env).code, 0)
  assert.deepEqual(loadConfig(home)?.excludeWords, ['beginner', 'PR'])
  assert.deepEqual(loadConfig(home)?.categoryExclude, { devto: ['tutorial'] })
  assert.match(runCli(['category', 'list'], env).stdout, /^devto\tbuiltin\tenabled\tchannel=global\texclude=tutorial$/m)
  assert.equal(runCli(['category', 'exclude', '--id', 'devto', '--words', 'none'], env).code, 0)
  assert.deepEqual(loadConfig(home)?.categoryExclude, {})
  assert.equal(runCli(['category', 'exclude', '--id', 'none-such', '--words', 'a'], env).code, 2)
})

test('CA6 set-webhook は追加したカテゴリにも保存でき、無いカテゴリは拒む', () => {
  const { home, env } = setup()
  assert.equal(runCli(['category', 'set', '--id', 'ai', '--title', 'AI', '--keywords', 'LLM'], env).code, 0)
  assert.equal(runCli(['set-webhook', '--target', 'section:k8s', '--from-stdin'], env).code, 2)
  assert.equal(runCli(['category', 'disable', '--id', 'gcp'], env).code, 0)
  // 止めているカテゴリにも保存しない
  assert.equal(runCli(['set-webhook', '--target', 'section:gcp', '--from-stdin'], env).code, 2)
  assert.deepEqual(loadSecrets(homePaths(home).secrets).sections, {})
})
