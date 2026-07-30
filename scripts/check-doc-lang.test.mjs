import { check, collectTargets, findJapaneseLines, OUTPUT_LANGUAGE_BLOCK, stripFrontmatter } from './check-doc-lang.mjs'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const roots = []

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'doc-lang-'))
  roots.push(root)
  return root
}

function write(root, relPath, content) {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

// 最小構成の skill を作る。guide-ja.md と Output Language ブロックも同時に
// 満たすので、ルール B/C/D は個別のテストでない限り発火しない。
function makeSkill(root, app, skill, skillBody) {
  const body = skillBody.includes(OUTPUT_LANGUAGE_BLOCK)
    ? skillBody
    : `${skillBody}\n## Output Language\n\n${OUTPUT_LANGUAGE_BLOCK}\n`
  write(root, `apps/${app}/skills/${skill}/SKILL.md`, body)
  write(root, `apps/${app}/skills/${skill}/references/guide-ja.md`, '# 日本語ガイド\n')
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('stripFrontmatter', () => {
  it('removes a leading --- block and reports the body start line', () => {
    const text = '---\nname: x\ndescription: 日本語\n---\n\n# Title\n'
    const { body, startLine } = stripFrontmatter(text)
    assert.equal(body, '\n# Title\n')
    assert.equal(startLine, 5)
  })

  it('returns the text unchanged when there is no frontmatter', () => {
    const { body, startLine } = stripFrontmatter('# Title\nbody\n')
    assert.equal(body, '# Title\nbody\n')
    assert.equal(startLine, 1)
  })

  it('returns the text unchanged when the closing --- is missing', () => {
    const text = '---\nname: x\n# Title\n'
    const { body, startLine } = stripFrontmatter(text)
    assert.equal(body, text)
    assert.equal(startLine, 1)
  })
})

describe('findJapaneseLines', () => {
  it('detects hiragana, katakana and kanji', () => {
    const hits = findJapaneseLines('one\nこれ\nカタカナ\n漢字\n')
    assert.deepEqual(
      hits.map((h) => h.line),
      [2, 3, 4],
    )
  })

  it('ignores box drawing, arrows and em dashes', () => {
    assert.deepEqual(findJapaneseLines('┌─┬─┐\na → b\nTemplate A — list\n'), [])
  })

  it('detects japanese punctuation left behind on an otherwise english line', () => {
    const hits = findJapaneseLines('run the script、then commit\n')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].line, 1)
  })

  it('skips the frontmatter block', () => {
    assert.deepEqual(findJapaneseLines('---\ndescription: 日本語の説明\n---\n# Title\n'), [])
  })
})

describe('collectTargets', () => {
  it('collects SKILL.md, references, commands but not README or CLAUDE.md', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/loop.md', '# Loop\n')
    write(root, 'apps/demo/references/setup.md', '# Setup\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n')
    write(root, 'apps/demo/README.md', '# 日本語 README\n')
    write(root, 'apps/demo/CLAUDE.md', '# 日本語ガイド\n')

    assert.deepEqual(collectTargets(root), [
      'apps/demo/commands/demo.md',
      'apps/demo/references/setup.md',
      'apps/demo/skills/demo/SKILL.md',
      'apps/demo/skills/demo/references/guide-ja.md',
      'apps/demo/skills/demo/references/loop.md',
    ])
  })
})

describe('check', () => {
  it('reports japanese in a SKILL.md body', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n\nこれは日本語です。\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'apps/demo/skills/demo/SKILL.md')
    assert.equal(violations[0].line, 3)
    assert.equal(violations[0].rule, 'japanese-in-english-doc')
  })

  it('allows japanese in the frontmatter description', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '---\nname: demo\ndescription: 日本語の説明\n---\n\n# Demo\n')
    assert.deepEqual(check(root), [])
  })

  it('reports a SKILL.md with no guide-ja.md', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', `## Output Language\n\n${OUTPUT_LANGUAGE_BLOCK}\n\n# Demo\n`)
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, 'missing-guide-ja')
    assert.equal(violations[0].file, 'apps/demo/skills/demo/SKILL.md')
  })

  it('reports a -ja.md that contains no japanese', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', `## Output Language\n\n${OUTPUT_LANGUAGE_BLOCK}\n\n# Demo\n`)
    write(root, 'apps/demo/skills/demo/references/guide-ja.md', '# Guide\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, 'empty-translation')
  })

  it('does not apply the japanese rule to -ja.md files', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/loop-mode-ja.md', '# ループ\n\n日本語の本文。\n')
    assert.deepEqual(check(root), [])
  })

  it('reports japanese in commands and references', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n\n日本語。\n')
    write(root, 'apps/demo/skills/demo/references/loop.md', '# Loop\n\n日本語。\n')
    const files = check(root).map((v) => v.file)
    assert.deepEqual(files.sort(), ['apps/demo/commands/demo.md', 'apps/demo/skills/demo/references/loop.md'])
  })

  it('restricts results to the given path filter', () => {
    const root = makeRoot()
    makeSkill(root, 'a', 'a', '# A\n\n日本語。\n')
    makeSkill(root, 'b', 'b', '# B\n\n日本語。\n')
    const violations = check(root, ['apps/a'])
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'apps/a/skills/a/SKILL.md')
  })

  it('returns an empty array for a clean tree', () => {
    const root = makeRoot()
    makeSkill(root, 'demo', 'demo', '# Demo\n\nAll english here.\n')
    write(root, 'apps/demo/commands/demo.md', '# Command\n')
    assert.deepEqual(check(root), [])
  })

  it('does not report missing-output-language when the block is present verbatim', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', `## Output Language\n\n${OUTPUT_LANGUAGE_BLOCK}\n\n# Demo\n`)
    write(root, 'apps/demo/skills/demo/references/guide-ja.md', '# デモ\n')
    assert.deepEqual(check(root), [])
  })

  it('reports missing-output-language for a SKILL.md without the block', () => {
    const root = makeRoot()
    write(root, 'apps/demo/skills/demo/SKILL.md', '# Demo\n')
    write(root, 'apps/demo/skills/demo/references/guide-ja.md', '# デモ\n')
    const violations = check(root)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, 'missing-output-language')
    assert.equal(violations[0].file, 'apps/demo/skills/demo/SKILL.md')
  })
})

describe('CLI entry guard', () => {
  it('does not throw on import when process.argv[1] is undefined', async () => {
    const originalArgv1 = process.argv[1]
    process.argv[1] = undefined
    try {
      await assert.doesNotReject(import(`./check-doc-lang.mjs?argv1-undefined=${Date.now()}`))
    } finally {
      process.argv[1] = originalArgv1
    }
  })
})
