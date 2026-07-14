import {
  checkSize,
  collectGlobalOutput,
  collectProjectOutputs,
  decideWrite,
  groupRulesByTarget,
  hasSentinel,
  parseFrontmatter,
  renderAgentsFile,
  SENTINEL,
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

test('checkSize は 32768 バイト超過で ok=false', () => {
  expect(checkSize('a'.repeat(100)).ok).toBe(true)
  const big = checkSize('a'.repeat(40000))
  expect(big.ok).toBe(false)
  expect(big.bytes).toBe(40000)
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
    { path: newPath, content: generated },
    { path: handwrittenPath, content: generated },
  ])

  expect(report.written).toContain(newPath)
  expect(report.skippedHandwritten).toContain(handwrittenPath)
  expect(await readFileAssert(newPath, 'utf8')).toBe(generated)
  expect(await readFileAssert(handwrittenPath, 'utf8')).toBe('# 手書き\n')
})

test('writeOutputs は 32KB 超過を oversize に記録する（書き込みは行う）', async () => {
  const dir = await makeTmp()
  const path = join(dir, 'AGENTS.md')
  const content = renderAgentsFile(['x'], ['a'.repeat(40000)])
  const report = await writeOutputs([{ path, content }])
  expect(report.oversize.some((o) => o.path === path)).toBe(true)
  expect(await readFileAssert(path, 'utf8')).toBe(content)
})
