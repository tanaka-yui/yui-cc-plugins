import { groupRulesByTarget, hasSentinel, parseFrontmatter, renderAgentsFile, SENTINEL } from './generate.ts'

import { expect, test } from 'bun:test'

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
