import { parseFrontmatter } from './generate.ts'

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
