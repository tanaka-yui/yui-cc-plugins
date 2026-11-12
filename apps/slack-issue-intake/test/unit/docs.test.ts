import * as launcher from '../../bin/launch.ts'
import {
  CLAUDE_HOME_ENV,
  FORM_EXTRA_SCOPES,
  FORM_KINDS,
  LAUNCHER_VERSION,
  LAUNCHER_VERSION_ENV,
  PLUGIN_ID,
  SLACK_BOT_SCOPES,
} from '../../lib/defaults.ts'
import { renderGuide, renderTemplate } from '../../lib/guide.ts'
import { HOME_ENV } from '../../lib/paths.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '../..')
test('DO1 配布文書と生成するSlack設定が一致', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const kind of FORM_KINDS) assert.ok(readme.includes(renderTemplate(kind)), kind.key)
  for (const scope of SLACK_BOT_SCOPES) assert.ok(readme.includes(scope))
})
test('DO4 READMEの案内はguideの出力そのもので、make setupとフォームの権限を載せる', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(readme.includes(renderGuide()))
  assert.ok(readme.includes('make setup'))
  for (const scope of FORM_EXTRA_SCOPES) assert.ok(readme.includes(scope))
  const makefile = readFileSync(join(root, 'Makefile'), 'utf8')
  for (const target of ['setup', 'slack-form', 'manifest']) assert.match(makefile, new RegExp(`^${target}:`, 'm'))
  assert.ok(!renderGuide().includes('form --manifest'))
  for (const kind of FORM_KINDS) {
    assert.ok(renderGuide().includes(kind.title), kind.title)
    assert.ok(renderGuide().includes(renderTemplate(kind)), kind.key)
    // テンプレートは ``` を含むので、外側は ~~~ で囲む（入れ子の ``` で表示が崩れないように）
    assert.ok(renderGuide().includes(`~~~text\n${renderTemplate(kind)}\n~~~`), kind.key)
    for (const item of kind.items) assert.ok(renderGuide().includes(item.label), item.label)
  }
})
test('DO2 手順書のplaceholderをprocedureがすべて置き換えられる', () => {
  const procedure = readFileSync(join(root, 'skills/slack-issue-intake/references/procedure.md'), 'utf8')
  const allowed = new Set([
    'LAUNCHER',
    'RUN_DIR',
    'WORK_FILE',
    'DECISIONS_FILE',
    'MAX_QUESTIONS',
    'QUESTION_MAX_CHARS',
    'SUMMARY_MAX_CHARS',
    'DETAILS_MAX_CHARS',
    'UNRESOLVED_MAX_ITEMS',
    'UNRESOLVED_ITEM_MAX_CHARS',
  ])
  for (const m of procedure.matchAll(/{{([A-Z_]+)}}/g)) assert.ok(allowed.has(m[1] ?? ''))
})
test('DO3 SKILLはOutput Languageを保持', () =>
  assert.ok(
    readFileSync(join(root, 'skills/slack-issue-intake/SKILL.md'), 'utf8').includes(
      '## Output Language\n\nAll user-facing questions, option labels, tables, and progress reports MUST be\nrendered in Japanese. This file is written in English for consistency; it does\nnot change the language presented to the user.',
    ),
  ))
test('LA2 コピー先で独立動作するランチャーの定数が一致', () => {
  assert.equal(launcher.PLUGIN_ID, PLUGIN_ID)
  assert.equal(launcher.LAUNCHER_VERSION, LAUNCHER_VERSION)
  assert.equal(launcher.LAUNCHER_VERSION_ENV, LAUNCHER_VERSION_ENV)
  assert.equal(launcher.CLAUDE_HOME_ENV, CLAUDE_HOME_ENV)
  assert.equal(launcher.HOME_ENV, HOME_ENV)
})
