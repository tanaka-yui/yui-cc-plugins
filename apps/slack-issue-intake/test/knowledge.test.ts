import { readKnowledgeMeta } from '../lib/knowledge.ts'
import { homePaths } from '../lib/paths.ts'
import { claudeCalls, fakeClaude, fakeGh, ghCalls, runCliAsync, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// 写す元のリポジトリ。ドキュメント・ドキュメントでないもの・symlink・大きすぎるもの・秘密らしい文字列を置く
const sourceRepo = (): string => {
  const dir = tempHome()
  mkdirSync(join(dir, 'docs', 'spec'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# app\n')
  writeFileSync(join(dir, 'docs', 'spec', 'billing.md'), '締め日は月末。トークン例 xoxb-123-secret\n')
  writeFileSync(join(dir, 'docs', 'big.md'), 'x'.repeat(300_000))
  writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  writeFileSync(join(dir, 'outside.md'), 'outside\n')
  symlinkSync(join(dir, 'outside.md'), join(dir, 'docs', 'link.md'))
  return dir
}
const INDEX = {
  overview: '請求のアプリ xoxb-999-leak',
  topics: [{ name: '請求', files: ['docs/spec/billing.md', '.env'] }],
  glossary: [{ term: '締め日', meaning: '請求をまとめる日' }],
  docs: [
    { path: 'README.md', title: 'README', summary: '概要', topics: [] },
    { path: './docs/spec/billing.md', title: '請求', summary: '締め日の決まり', topics: ['請求'] },
    { path: '.env', title: 'env', summary: 'x', topics: [] },
    { path: 'docs/link.md', title: 'link', summary: 'x', topics: [] },
    { path: 'docs/big.md', title: 'big', summary: 'x', topics: [] },
    { path: '../escape.md', title: 'escape', summary: 'x', topics: [] },
    { path: 'docs/missing.md', title: 'missing', summary: 'x', topics: [] },
  ],
}

const setup = async (t: { after: (fn: () => Promise<void>) => void }, result: object = INDEX) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const claude = fakeClaude(tempHome())
  const server = await startSlack(() => ({ json: { ok: true } }))
  t.after(() => server.close())
  const env = {
    ...gh.env,
    ...claude.env,
    FAKE_GH_CLONE_SOURCE: sourceRepo(),
    FAKE_CLAUDE_RESULT: JSON.stringify(result),
    ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })),
  }
  const dir = join(home, 'knowledge', 'acme', 'app')
  return {
    home,
    gh,
    claude,
    env,
    dir,
    run: (extra: Record<string, string> = {}) => runCliAsync(['knowledge'], { ...env, ...extra }),
  }
}

test('KN1 docs だけを写し、AI の索引から INDEX.md・index.json・meta.json を作り、外れたものは知らせて捨てる', async (t) => {
  const f = await setup(t)
  const r = await f.run()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^knowledge repo=acme\/app files=2 commit=[0-9a-f]{40}$/m)
  for (const path of ['.env', 'docs/link.md', 'docs/big.md', '../escape.md', 'docs/missing.md'])
    assert.ok(r.stdout.includes(`dropped repo=acme/app path=${path}`), path)
  const meta = readKnowledgeMeta(f.dir)
  assert.deepEqual(meta?.files, ['README.md', 'docs/spec/billing.md'])
  assert.deepEqual(readdirSync(join(f.dir, 'docs')).sort(), ['README.md', 'docs'])
  const copied = readFileSync(join(f.dir, 'docs', 'docs', 'spec', 'billing.md'), 'utf8')
  assert.ok(copied.includes('締め日は月末') && !copied.includes('xoxb-123-secret'))
  const index = readFileSync(join(f.dir, 'INDEX.md'), 'utf8')
  for (const text of ['請求のアプリ', '締め日', '請求をまとめる日', 'docs/spec/billing.md', '締め日の決まり'])
    assert.ok(index.includes(text), text)
  assert.ok(!index.includes('xoxb-999-leak') && !index.includes('.env'))
  const json = JSON.parse(readFileSync(join(f.dir, 'index.json'), 'utf8'))
  assert.deepEqual(json.topics, [{ name: '請求', files: ['docs/spec/billing.md'] }])
  const call = claudeCalls(f.claude.log)[0]
  for (const arg of [
    '-p',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
  ])
    assert.ok(call?.argv.includes(arg), arg)
  // clone の設定（hooks など）を読ませず、読み取りの許可は clone の中だけに絞る
  const argv = call?.argv ?? []
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user')
  const allowed = argv[argv.indexOf('--allowedTools') + 1] ?? ''
  // clone は消えているので realpath は取れない。macOS の /private の有無だけをそろえて比べる
  const bare = (path: string): string => path.replace(/^\/private\//, '/')
  assert.equal(bare(allowed.slice('Read(/'.length, -'/**)'.length)), bare(call?.cwd ?? ''))
  assert.ok(allowed.startsWith('Read(//') && allowed.endsWith('/**)'), allowed)
  const clone = ghCalls(f.gh.log).find((c) => c.argv[0] === 'repo' && c.argv[1] === 'clone')
  assert.deepEqual(clone?.argv.slice(0, 3), ['repo', 'clone', 'acme/app'])
  assert.deepEqual(clone?.argv.slice(-3), ['--', '--depth', '1'])
  assert.equal(call?.cwd.endsWith(clone?.argv[3] ?? '?') || call?.cwd === clone?.argv[3], true)
  assert.ok(!existsSync(clone?.argv[3] ?? ''))
  assert.ok(!readdirSync(homePaths(f.home).tmpDir).length)
})

test('KN2 作り直しは faq.jsonl を残して docs を入れ替え、失敗したら前の版を残す', async (t) => {
  const f = await setup(t)
  assert.equal((await f.run()).code, 0)
  writeFileSync(join(f.dir, 'faq.jsonl'), '{"q":1}\n')
  const only = { ...INDEX, docs: [INDEX.docs[1]] }
  assert.equal((await f.run({ FAKE_CLAUDE_RESULT: JSON.stringify(only) })).code, 0)
  assert.equal(readFileSync(join(f.dir, 'faq.jsonl'), 'utf8'), '{"q":1}\n')
  assert.ok(!existsSync(join(f.dir, 'docs', 'README.md')))
  assert.deepEqual(readKnowledgeMeta(f.dir)?.files, ['docs/spec/billing.md'])
  const before = readFileSync(join(f.dir, 'meta.json'), 'utf8')
  const failures: Record<string, string>[] = [
    { FAKE_CLAUDE_RESULT: 'not json' },
    { FAKE_CLAUDE_FAIL: '1' },
    { FAKE_GH_CLONE_SOURCE: '' },
  ]
  for (const extra of failures) {
    const r = await f.run(extra)
    assert.equal(r.code, 1, JSON.stringify(extra))
    assert.match(r.stderr, /acme\/app/)
    assert.equal(readFileSync(join(f.dir, 'meta.json'), 'utf8'), before)
    assert.ok(existsSync(join(f.dir, 'docs', 'docs', 'spec', 'billing.md')))
    assert.deepEqual(
      readdirSync(f.dir).sort(),
      ['INDEX.md', 'docs', 'faq.jsonl', 'index.json', 'meta.json'],
      JSON.stringify(extra),
    )
  }
})

test('KN3 写せたドキュメントが 1 つも無ければ、作れたことにしたうえで知らせる', async (t) => {
  const f = await setup(t, { ...INDEX, docs: [INDEX.docs[2]] })
  const r = await f.run()
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^knowledge repo=acme\/app files=0 /m)
  assert.match(r.stderr, /acme\/app の仕様の索引に写せたドキュメントがありません/)
})
