#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

// ひらがな / カタカナ / CJK 記号・句読点 / CJK 統合漢字 / 拡張 A / 互換漢字。
// Box drawing (U+2500-257F) と矢印 (U+2190-21FF) は範囲外なので誤検出しない。
export const JAPANESE_RE = /[、-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/u

// frontmatter (先頭の --- ブロック) を本文から切り離す。
// description に日本語トリガー語を残すため、検証対象から外す必要がある。
export function stripFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') return { body: text, startLine: 1 }
  const closing = lines.indexOf('---', 1)
  if (closing === -1) return { body: text, startLine: 1 }
  return { body: lines.slice(closing + 1).join('\n'), startLine: closing + 2 }
}

export function findJapaneseLines(text) {
  const { body, startLine } = stripFrontmatter(text)
  const hits = []
  body.split('\n').forEach((line, index) => {
    if (JAPANESE_RE.test(line)) hits.push({ line: startLine + index, text: line })
  })
  return hits
}

function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory()
}

function walkMarkdown(dir, root, acc) {
  if (!isDir(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, root, acc)
    else if (entry.name.endsWith('.md')) acc.push(relative(root, full))
  }
  return acc
}

// 対象: apps/*/skills/*/SKILL.md, apps/*/skills/*/references/**/*.md,
//       apps/*/references/**/*.md, apps/*/commands/*.md
export function collectTargets(root) {
  const appsDir = join(root, 'apps')
  if (!isDir(appsDir)) return []
  const targets = []
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const appPath = join(appsDir, app.name)

    const commandsDir = join(appPath, 'commands')
    if (isDir(commandsDir)) {
      for (const entry of readdirSync(commandsDir)) {
        if (entry.endsWith('.md')) targets.push(relative(root, join(commandsDir, entry)))
      }
    }

    walkMarkdown(join(appPath, 'references'), root, targets)

    const skillsDir = join(appPath, 'skills')
    if (!isDir(skillsDir)) continue
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const skillPath = join(skillsDir, skill.name)
      const skillFile = join(skillPath, 'SKILL.md')
      if (existsSync(skillFile)) targets.push(relative(root, skillFile))
      walkMarkdown(join(skillPath, 'references'), root, targets)
    }
  }
  return targets.sort()
}

export function isTranslation(relPath) {
  return basename(relPath).endsWith('-ja.md')
}

// SKILL.md の frontmatter 直後に置く定型文。CLAUDE.md 「Language convention」の
// 「## Output Language ブロック」節と一字一句一致させること。
export const OUTPUT_LANGUAGE_BLOCK = `All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.`

export function check(root, filter) {
  const matches = (relPath) => !filter?.length || filter.some((f) => relPath.startsWith(f))
  const violations = []

  for (const relPath of collectTargets(root)) {
    if (!matches(relPath)) continue
    const text = readFileSync(join(root, relPath), 'utf8')

    if (isTranslation(relPath)) {
      if (!JAPANESE_RE.test(text)) {
        violations.push({
          file: relPath,
          line: 1,
          rule: 'empty-translation',
          message: 'translation file contains no Japanese text',
        })
      }
      continue
    }

    for (const hit of findJapaneseLines(text)) {
      violations.push({
        file: relPath,
        line: hit.line,
        rule: 'japanese-in-english-doc',
        message: `Japanese found: ${hit.text.trim().slice(0, 60)}`,
      })
    }

    if (basename(relPath) === 'SKILL.md') {
      const guide = join(root, relPath.replace(/SKILL\.md$/, 'references/guide-ja.md'))
      if (!existsSync(guide)) {
        violations.push({
          file: relPath,
          line: 1,
          rule: 'missing-guide-ja',
          message: 'references/guide-ja.md is required for every SKILL.md',
        })
      }

      if (!text.includes(OUTPUT_LANGUAGE_BLOCK)) {
        violations.push({
          file: relPath,
          line: 1,
          rule: 'missing-output-language',
          message: 'the "## Output Language" block is missing or does not match verbatim',
        })
      }
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const violations = check(root, process.argv.slice(2))
  for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.message}`)
  if (violations.length > 0) {
    console.error(`\n${violations.length} violation(s). See CLAUDE.md "Language convention".`)
    process.exit(1)
  }
  console.log('check-doc-lang: OK')
}
