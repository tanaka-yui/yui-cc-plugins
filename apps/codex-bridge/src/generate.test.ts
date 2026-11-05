import {
  ancestorDirs,
  checkChains,
  collectGlobalOutput,
  collectProjectOutputs,
  decideWrite,
  diagnoseChain,
  groupRulesByTarget,
  hasSentinel,
  main,
  parseFrontmatter,
  parseMaxBytesFlag,
  parseProjectDocMaxBytes,
  renderAgentsFile,
  resolveSizeLimit,
  SENTINEL,
  suggestLimit,
  writeOutputs,
} from './generate.ts'

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile as readFileAssert, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('block 形式の codexTargets を配列で取り出す', () => {
  const input = [
    '---',
    'description: Go backend rules',
    'codexTargets:',
    '  - go/',
    '  - cmd/',
    '---',
    '# Go',
    'body line',
  ].join('\n')
  const { attrs, body } = parseFrontmatter(input)
  expect(attrs.codexTargets).toEqual(['go/', 'cmd/'])
  expect(attrs.description).toBe('Go backend rules')
  expect(body).toBe('# Go\nbody line')
})

test('flow 形式 [a, b] の codexTargets を取り出す', () => {
  const input = ['---', 'codexTargets: [go/, proto/]', '---', 'X'].join('\n')
  const { attrs } = parseFrontmatter(input)
  expect(attrs.codexTargets).toEqual(['go/', 'proto/'])
})

test('frontmatter が無ければ空 targets と全文 body を返す', () => {
  const { attrs, body } = parseFrontmatter('# no front\ntext')
  expect(attrs.codexTargets).toEqual([])
  expect(attrs.description).toBeNull()
  expect(body).toBe('# no front\ntext')
})

test('renderAgentsFile はセンチネルヘッダーと結合本文を出力する', () => {
  const out = renderAgentsFile(['.claude/rules/go-backend.md', '.claude/rules/go-testing.md'], ['# A\naaa', '# B\nbbb'])
  expect(out).toContain(SENTINEL)
  expect(out).toContain('.claude/rules/go-backend.md, .claude/rules/go-testing.md')
  expect(out).toContain('# A\naaa\n\n# B\nbbb')
  expect(out.endsWith('\n')).toBe(true)
})

test('hasSentinel は生成物を true、手書きを false と判定する', () => {
  const generated = renderAgentsFile(['x'], ['y'])
  expect(hasSentinel(generated)).toBe(true)
  expect(hasSentinel('# 手書きの AGENTS.md\n')).toBe(false)
})

test('同一 target の rule を結合し、target・file 順にソートする', () => {
  const { groups, unmapped } = groupRulesByTarget([
    { file: 'go-testing.md', targets: ['go/'], body: 'T' },
    { file: 'go-backend.md', targets: ['go/'], body: 'B' },
    { file: 'proto.md', targets: ['proto/'], body: 'P' },
  ])
  expect(groups.map((g) => g.target)).toEqual(['go/', 'proto/'])
  expect(groups[0]?.members.map((m) => m.file)).toEqual(['go-backend.md', 'go-testing.md'])
  expect(unmapped).toEqual([])
})

test('複数 target を持つ rule は各 target に現れる', () => {
  const { groups } = groupRulesByTarget([{ file: 'shared.md', targets: ['a/', 'b/'], body: 'S' }])
  expect(groups.map((g) => g.target)).toEqual(['a/', 'b/'])
})

test('targets 空の rule は unmapped に入る', () => {
  const { groups, unmapped } = groupRulesByTarget([{ file: 'orphan.md', targets: [], body: 'O' }])
  expect(groups).toEqual([])
  expect(unmapped).toEqual(['orphan.md'])
})

test('存在しない/センチネル付きなら write、手書きなら skip-handwritten', () => {
  const generated = renderAgentsFile(['x'], ['y'])
  expect(decideWrite(null, generated).action).toBe('write')
  expect(decideWrite(generated, generated).action).toBe('write')
  expect(decideWrite('# 手書き\n', generated).action).toBe('skip-handwritten')
})

test('parseMaxBytesFlag は --max-bytes の値を取り出す', () => {
  expect(parseMaxBytesFlag(['--max-bytes', '65536'])).toBe(65536)
  expect(parseMaxBytesFlag(['--max-bytes=65536'])).toBe(65536)
  expect(parseMaxBytesFlag(['--global'])).toBeNull()
})

test('parseMaxBytesFlag は 正の整数以外を null として無視する', () => {
  expect(parseMaxBytesFlag(['--max-bytes', 'abc'])).toBeNull()
  expect(parseMaxBytesFlag(['--max-bytes', '0'])).toBeNull()
  expect(parseMaxBytesFlag(['--max-bytes', '-5'])).toBeNull()
  expect(parseMaxBytesFlag(['--max-bytes'])).toBeNull()
})

test('parseProjectDocMaxBytes は root テーブルの値だけを読む', () => {
  expect(parseProjectDocMaxBytes('project_doc_max_bytes = 131072\n')).toBe(131072)
  expect(parseProjectDocMaxBytes('model = "x"\nproject_doc_max_bytes=65536\n')).toBe(65536)
  // [section] 以降の同名キーは root の設定ではないので無視する
  expect(parseProjectDocMaxBytes('[features]\nproject_doc_max_bytes = 131072\n')).toBeNull()
  expect(parseProjectDocMaxBytes('model = "x"\n')).toBeNull()
})

test('parseProjectDocMaxBytes はコメント行を無視する', () => {
  expect(parseProjectDocMaxBytes('# project_doc_max_bytes = 999\nmodel = "x"\n')).toBeNull()
})

test('suggestLimit は超過分を収める 2 の冪を返す', () => {
  expect(suggestLimit(40000, 32768)).toBe(65536)
  expect(suggestLimit(65952, 32768)).toBe(131072)
  expect(suggestLimit(100, 32768)).toBe(32768)
})

test('diagnoseChain は合計が上限内なら null', () => {
  const chain = [{ path: 'AGENTS.md', bytes: 100, sources: [] }]
  expect(diagnoseChain({ path: 'AGENTS.md', target: '<root>' }, chain, 32768)).toBeNull()
})

test('diagnoseChain は 1 つの rule が上限を超えると single-rule-over-limit', () => {
  const d = diagnoseChain(
    { path: 'go/AGENTS.md', target: 'go/' },
    [
      { path: 'AGENTS.md', bytes: 1000, sources: [{ file: 'CLAUDE.md', bytes: 1000 }] },
      {
        path: 'go/AGENTS.md',
        bytes: 66182,
        sources: [
          { file: '.claude/rules/go-backend.md', bytes: 50777 },
          { file: '.claude/rules/go-testing.md', bytes: 15405 },
        ],
      },
    ],
    32768,
  )
  expect(d?.kind).toBe('single-rule-over-limit')
  expect(d?.bytes).toBe(67182)
  expect(d?.overBy).toBe(67182 - 32768)
  expect(d?.suggestedLimit).toBe(131072)
  expect(d?.offenders.map((o) => o.file)).toEqual(['.claude/rules/go-backend.md'])
  // codexTargets の付け替えでは解決しないことを明示する
  expect(d?.remedies.join('\n')).toContain('codexTargets')
})

test('diagnoseChain は 1 つの AGENTS.md が単体で超えると concatenation-over-limit で最大の rule を挙げる', () => {
  const d = diagnoseChain(
    { path: 'typescript/AGENTS.md', target: 'typescript/' },
    [
      {
        path: 'typescript/AGENTS.md',
        bytes: 40200,
        sources: [
          { file: '.claude/rules/a.md', bytes: 20000 },
          { file: '.claude/rules/b.md', bytes: 19000 },
        ],
      },
    ],
    32768,
  )
  expect(d?.kind).toBe('concatenation-over-limit')
  expect(d?.offenders).toEqual([])
  expect(d?.remedies.join('\n')).toContain('.claude/rules/a.md')
})

test('diagnoseChain はどのファイルも収まるのに合計で超えると chain-over-limit', () => {
  const d = diagnoseChain(
    { path: 'go/internal/AGENTS.md', target: 'go/internal/' },
    [
      { path: 'AGENTS.md', bytes: 30000, sources: [{ file: 'CLAUDE.md', bytes: 30000 }] },
      { path: 'go/AGENTS.md', bytes: 20000, sources: [{ file: '.claude/rules/go.md', bytes: 20000 }] },
      { path: 'go/internal/AGENTS.md', bytes: 10000, sources: [{ file: '.claude/rules/internal.md', bytes: 10000 }] },
    ],
    32768,
  )
  expect(d?.kind).toBe('chain-over-limit')
  expect(d?.bytes).toBe(60000)
  expect(d?.suggestedLimit).toBe(65536)
  // いちばん大きい root を挙げ、CLAUDE.md の節を rule に移す案と、コミットできる .codex/config.toml の案を出す
  expect(d?.remedies[0]).toContain('CLAUDE.md')
  expect(d?.remedies.join('\n')).toContain('リポジトリの .codex/config.toml')
})

test('diagnoseChain は global の出力にはプロジェクトの .codex/config.toml を勧めない', () => {
  const d = diagnoseChain(
    { path: 'AGENTS.md', target: '<global>' },
    [{ path: 'AGENTS.md', bytes: 40000, sources: [{ file: '~/.claude/CLAUDE.md', bytes: 40000 }] }],
    32768,
  )
  expect(d?.kind).toBe('single-rule-over-limit')
  const remedies = d?.remedies.join('\n') ?? ''
  expect(remedies).toContain('~/.codex/config.toml')
  expect(remedies).not.toContain('リポジトリの .codex/config.toml')
})

test('ancestorDirs は root から dir までを root 側から返す', () => {
  expect(ancestorDirs('/repo', '/repo')).toEqual(['/repo'])
  expect(ancestorDirs('/repo', '/repo/go/internal')).toEqual(['/repo', '/repo/go', '/repo/go/internal'])
  expect(ancestorDirs('/repo', '/elsewhere')).toEqual(['/repo'])
})

async function makeTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'codex-bridge-'))
}

test('collectProjectOutputs は rules と root CLAUDE.md を出力に変換する', async () => {
  const root = await makeTmp()
  await mkdir(join(root, '.claude/rules'), { recursive: true })
  await mkdir(join(root, 'go'), { recursive: true })
  await writeFile(join(root, '.claude/rules/go-backend.md'), '---\ncodexTargets:\n  - go/\n---\n# Go\nbody')
  await writeFile(join(root, '.claude/rules/orphan.md'), '# no front')
  await writeFile(join(root, 'CLAUDE.md'), '# Project overview')

  const { outputs, warnings } = await collectProjectOutputs(root)
  const paths = outputs.map((o) => o.path)
  expect(paths).toContain(join(root, 'go', 'AGENTS.md'))
  expect(paths).toContain(join(root, 'AGENTS.md'))
  const goOut = outputs.find((o) => o.path === join(root, 'go', 'AGENTS.md'))
  expect(goOut?.content).toContain('# Go\nbody')
  expect(warnings.some((w) => w.includes('orphan.md'))).toBe(true)
})

test('collectProjectOutputs は存在しない target を警告してスキップする', async () => {
  const root = await makeTmp()
  await mkdir(join(root, '.claude/rules'), { recursive: true })
  await writeFile(join(root, '.claude/rules/x.md'), '---\ncodexTargets:\n  - missing/\n---\nX')
  const { outputs, warnings } = await collectProjectOutputs(root)
  expect(outputs.some((o) => o.path.includes('missing'))).toBe(false)
  expect(warnings.some((w) => w.includes('missing/'))).toBe(true)
})

test('collectGlobalOutput は ~/.claude/CLAUDE.md を ~/.codex/AGENTS.md に変換する', async () => {
  const home = await makeTmp()
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude/CLAUDE.md'), '必ず日本語で応答')
  const { outputs } = await collectGlobalOutput(home)
  expect(outputs[0]?.path).toBe(join(home, '.codex', 'AGENTS.md'))
  expect(outputs[0]?.content).toContain('必ず日本語で応答')
})

test('writeOutputs は新規書き込みし、手書きファイルはスキップする', async () => {
  const dir = await makeTmp()
  const generated = renderAgentsFile(['x'], ['y'])
  const newPath = join(dir, 'a', 'AGENTS.md')
  const handwrittenPath = join(dir, 'AGENTS.md')
  await writeFile(handwrittenPath, '# 手書き\n')

  const report = await writeOutputs([
    { path: newPath, content: generated, target: 'a/', sources: [{ file: '.claude/rules/x.md', bytes: 1 }] },
    { path: handwrittenPath, content: generated, target: '<root>', sources: [{ file: 'CLAUDE.md', bytes: 1 }] },
  ])

  expect(report.written).toContain(newPath)
  expect(report.skippedHandwritten).toContain(handwrittenPath)
  expect(await readFileAssert(newPath, 'utf8')).toBe(generated)
  expect(await readFileAssert(handwrittenPath, 'utf8')).toBe('# 手書き\n')
})

test('checkChains は root からの合計で測り、手書きと override も数える', async () => {
  const root = await makeTmp()
  await mkdir(join(root, 'go', 'internal'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'r'.repeat(600))
  // 手書きの AGENTS.md も Codex は読むので数える
  await writeFile(join(root, 'go', 'AGENTS.md'), 'g'.repeat(300))
  // AGENTS.override.md があれば AGENTS.md の代わりに読む
  await writeFile(join(root, 'go', 'AGENTS.override.md'), 'o'.repeat(200))
  const outputs = [
    {
      path: join(root, 'go', 'internal', 'AGENTS.md'),
      content: 'i'.repeat(300),
      target: 'go/internal/',
      sources: [{ file: '.claude/rules/i.md', bytes: 300 }],
    },
  ]
  await writeOutputs(outputs)

  expect(await checkChains(root, outputs, 1100)).toEqual([])
  const [d] = await checkChains(root, outputs, 1000)
  expect(d?.path).toBe(join('go', 'internal', 'AGENTS.md'))
  expect(d?.bytes).toBe(1100)
  expect(d?.kind).toBe('chain-over-limit')
  expect(d?.chain.map((f) => [f.path, f.bytes])).toEqual([
    ['AGENTS.md', 600],
    [join('go', 'AGENTS.override.md'), 200],
    [join('go', 'internal', 'AGENTS.md'), 300],
  ])
  expect(d?.chain[2]?.sources).toEqual([{ file: '.claude/rules/i.md', bytes: 300 }])
})

test('checkChains は空白だけの AGENTS.md を数えない', async () => {
  const root = await makeTmp()
  await mkdir(join(root, 'a'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '  \n')
  const outputs = [{ path: join(root, 'a', 'AGENTS.md'), content: 'x'.repeat(10), target: 'a/', sources: [] }]
  await writeOutputs(outputs)
  const [d] = await checkChains(root, outputs, 5)
  expect(d?.chain.map((f) => f.path)).toEqual([join('a', 'AGENTS.md')])
})

test('checkChains は 各ファイルが上限内でも合計が超えれば超過とする（書き込みは行う）', async () => {
  const root = await makeTmp()
  await mkdir(join(root, 'go'), { recursive: true })
  const rootOut = { path: join(root, 'AGENTS.md'), content: 'r'.repeat(700), target: '<root>', sources: [] }
  const goOut = { path: join(root, 'go', 'AGENTS.md'), content: 'g'.repeat(700), target: 'go/', sources: [] }
  const report = await writeOutputs([rootOut, goOut])
  expect(report.written).toEqual([rootOut.path, goOut.path])
  const diagnoses = await checkChains(root, [rootOut, goOut], 1000)
  // root 単体は収まり、go/ までの連なりだけが超える
  expect(diagnoses.map((d) => [d.path, d.kind])).toEqual([[join('go', 'AGENTS.md'), 'chain-over-limit']])
})

test('checkChains は global の出力を ~/.codex を root にした単一ファイルとして測る', async () => {
  const home = await makeTmp()
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude/CLAUDE.md'), 'a'.repeat(2000))
  const { outputs } = await collectGlobalOutput(home)
  await writeOutputs(outputs)
  const [d] = await checkChains(join(home, '.codex'), outputs, 1000)
  expect(d?.target).toBe('<global>')
  expect(d?.chain.map((f) => f.path)).toEqual(['AGENTS.md'])
  expect(d?.kind).toBe('single-rule-over-limit')
})

test('resolveSizeLimit は --max-bytes > プロジェクトの .codex > ~/.codex > 既定値 の順に決める', async () => {
  const home = await makeTmp()
  const root = await makeTmp()
  const env = { root, home }
  expect(await resolveSizeLimit([], env)).toEqual({ limit: 32768, source: 'codex 既定値' })
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/config.toml'), 'project_doc_max_bytes = 65536\n')
  expect(await resolveSizeLimit([], env)).toEqual({ limit: 65536, source: '~/.codex/config.toml' })
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex/config.toml'), 'project_doc_max_bytes = 131072\n')
  expect(await resolveSizeLimit([], env)).toEqual({ limit: 131072, source: '.codex/config.toml（プロジェクト）' })
  expect(await resolveSizeLimit(['--max-bytes', '1024'], env)).toEqual({ limit: 1024, source: '--max-bytes' })
  // global モードはプロジェクトの設定を見ない
  expect(await resolveSizeLimit([], { root: null, home })).toEqual({ limit: 65536, source: '~/.codex/config.toml' })
})

test('collectProjectOutputs は各出力に target と sources を持たせる', async () => {
  const root = await makeTmp()
  await mkdir(join(root, '.claude/rules'), { recursive: true })
  await mkdir(join(root, 'go'), { recursive: true })
  await writeFile(join(root, '.claude/rules/go-backend.md'), '---\ncodexTargets:\n  - go/\n---\n# Go\nbody')
  await writeFile(join(root, 'CLAUDE.md'), '# Project overview')

  const { outputs } = await collectProjectOutputs(root)
  const goOut = outputs.find((o) => o.path === join(root, 'go', 'AGENTS.md'))
  expect(goOut?.target).toBe('go/')
  expect(goOut?.sources.map((s) => s.file)).toEqual(['.claude/rules/go-backend.md'])
  expect(goOut?.sources[0]?.bytes).toBe(Buffer.byteLength('# Go\nbody', 'utf8'))

  const rootOut = outputs.find((o) => o.path === join(root, 'AGENTS.md'))
  expect(rootOut?.target).toBe('<root>')
  expect(rootOut?.sources.map((s) => s.file)).toEqual(['CLAUDE.md'])
})

test('main は合計が上限を超える連なりがあれば書き込んだうえで 1 を返す', async () => {
  const root = await makeTmp()
  const home = await makeTmp()
  await mkdir(join(root, '.claude/rules'), { recursive: true })
  await mkdir(join(root, 'go'), { recursive: true })
  await writeFile(join(root, '.claude/rules/go.md'), `---\ncodexTargets:\n  - go/\n---\n${'g'.repeat(600)}`)
  await writeFile(join(root, 'CLAUDE.md'), 'r'.repeat(600))
  const env = { cwd: root, home }
  expect(await main(['--max-bytes', '4096'], env)).toBe(0)
  expect(await main(['--max-bytes', '1000'], env)).toBe(1)
  expect(await readFileAssert(join(root, 'go', 'AGENTS.md'), 'utf8')).toContain('g'.repeat(600))
})
