import * as launcher from '../../bin/launch.ts'
import {
  CLAUDE_HOME_ENV,
  FORM_EXTRA_SCOPES,
  FORM_KINDS,
  LAUNCHER_VERSION,
  LAUNCHER_VERSION_ENV,
  PLUGIN_ID,
  SLACK_BOT_SCOPES,
  STATUS_LABELS,
} from '../../lib/defaults.ts'
import { renderGuide, renderTemplate } from '../../lib/guide.ts'
import { HOME_ENV } from '../../lib/paths.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  assert.ok(readme.includes(renderGuide('<名前>')))
  assert.ok(readme.includes('make setup'))
  for (const scope of FORM_EXTRA_SCOPES) assert.ok(readme.includes(scope))
  const makefile = readFileSync(join(root, 'Makefile'), 'utf8')
  for (const target of ['setup', 'slack-form', 'manifest']) assert.match(makefile, new RegExp(`^${target}:`, 'm'))
  assert.ok(!renderGuide('<名前>').includes('form --manifest'))
  for (const kind of FORM_KINDS) {
    assert.ok(renderGuide('<名前>').includes(kind.title), kind.title)
    assert.ok(renderGuide('<名前>').includes(renderTemplate(kind)), kind.key)
    // テンプレートは ``` を含むので、外側は ~~~ で囲む（入れ子の ``` で表示が崩れないように）
    assert.ok(renderGuide('<名前>').includes(`~~~text\n${renderTemplate(kind)}\n~~~`), kind.key)
    for (const item of kind.items) assert.ok(renderGuide('<名前>').includes(item.label), item.label)
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
    'KNOWLEDGE_DIR',
    'MAX_ANSWERS',
    'ANSWER_MAX_CHARS',
    'ANSWER_MAX_SOURCES',
    'MAX_TITLE_CHARS',
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
test('DO5 README は 9 つのステータスラベル名と usergroups:read と「0.3 からの更新」を含む', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const label of STATUS_LABELS) assert.ok(readme.includes(`| ${label.name} |`), label.name)
  assert.ok(readme.includes('usergroups:read'))
  assert.ok(readme.includes('### 0.3 からの更新'))
})

test('DO6 README は複数リポジトリ・更新手順・report を含み、版は 0.14.0', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const text of ['slack-thread', '0.4 からの更新', 'report --source', '--hide-form'])
    assert.ok(readme.includes(text), text)
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as { version: string }
  const market = JSON.parse(readFileSync(join(root, '../../.claude-plugin/marketplace.json'), 'utf8')) as {
    plugins: { name: string; version: string }[]
  }
  assert.equal(plugin.version, '0.14.0')
  assert.equal(market.plugins.find((p) => p.name === 'slack-issue-intake')?.version, '0.14.0')
  for (const text of [
    '### 0.7.0 以前からの更新',
    'make knowledge <名前>',
    '### 質問する',
    '### 0.8.0 以前からの更新',
    '--branches',
    '`base:<ブランチ>`',
  ])
    assert.ok(readme.includes(text), text)
})

test('MW6 make takes the name as the second word, keeps NAME= and ignores NAME from the environment', () => {
  const make = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('make', ['-n', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.match(make(['setup', 'ws2']).stdout, /slack-issue-intake\.ts' --name 'ws2' setup$/m)
  assert.match(make(['manifest', 'ws2']).stdout, /slack-issue-intake\.ts' --name 'ws2' form --manifest$/m)
  assert.match(make(['slack-form', 'ws2']).stdout, /slack-issue-intake\.ts' --name 'ws2' form$/m)
  assert.match(make(['knowledge', 'ws2']).stdout, /slack-issue-intake\.ts' --name 'ws2' knowledge$/m)
  assert.match(make(['setup', 'NAME=ws2']).stdout, /slack-issue-intake\.ts' --name 'ws2' setup$/m)
  assert.notEqual(make(['setup', 'a', 'b']).status, 0)
  assert.notEqual(make(['setup', 'knowledge']).status, 0)
  const plain = make(['setup'], { NAME: 'leak' }).stdout
  assert.match(plain, /slack-issue-intake\.ts' --ask-name=setup setup$/m)
  assert.ok(!plain.includes('leak'))
  assert.match(make(['manifest']).stdout, /slack-issue-intake\.ts' --ask-name=manifest form --manifest$/m)
  assert.match(make(['slack-form']).stdout, /slack-issue-intake\.ts' --ask-name=slack-form form$/m)
})

test('MW5 docs explain per-workspace setup and --name', () => {
  const skill = readFileSync(join(root, 'skills/slack-issue-intake/SKILL.md'), 'utf8')
  const guide = readFileSync(join(root, 'skills/slack-issue-intake/references/guide-ja.md'), 'utf8')
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const text of [
    '--name <name>',
    'make setup <name>',
    '~/.slack-issue-intake-<name>/secrets.json',
    '## Workspaces',
  ])
    assert.ok(skill.includes(text), text)
  for (const text of [
    '--name <名前>',
    'make setup <名前>',
    '~/.slack-issue-intake-<名前>/secrets.json',
    '## ワークスペース',
  ])
    assert.ok(guide.includes(text), text)
  for (const text of ['make setup <名前>', 'slack-issue-intake-<名前>', '--name <名前>'])
    assert.ok(readme.includes(text), text)
})

test('DC1 README・SKILL・guide-ja の実行例は名前を付ける', () => {
  for (const file of [
    'README.md',
    'skills/slack-issue-intake/SKILL.md',
    'skills/slack-issue-intake/references/guide-ja.md',
  ]) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(/bin\/slack-issue-intake\.ts"?[ \t]+(\S+)/g))
      assert.equal(m[1], '--name', `${file}: ${m[0]}`)
    assert.deepEqual(
      [...text.matchAll(/make (?:setup|manifest|slack-form)\b(?! \S)/g)].map((m) => m[0]),
      [],
      file,
    )
    assert.ok(!text.includes('~/.slack-issue-intake/bin'), file)
  }
})
