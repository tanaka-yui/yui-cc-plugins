import {
  MSG_NAME_ASK,
  MSG_NAME_LIST_EMPTY,
  MSG_NAME_NONE,
  MSG_NAME_REQUIRED,
  MSG_NAME_RESERVED,
  MSG_NAME_RULE,
} from '../../lib/defaults.ts'
import { homeOfSlackProject, listIntakeNames } from '../../lib/paths.ts'
import { askWorkspaceName, commandWithName, legacyHomeNotice, nameRequiredMessage } from '../../lib/workspace.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Prompter } from '../../lib/prompt.ts'

test('NR1 listIntakeNames は有効な名前つきディレクトリだけを昇順で返す', () => {
  const tmp = tempHome()
  for (const suffix of ['', '-b', '-a', '-slack-app', '-x-slack-app', '-UP', `-${'a'.repeat(33)}`, 'X'])
    mkdirSync(join(tmp, `.slack-issue-intake${suffix}`))
  mkdirSync(join(tmp, '.other'))
  writeFileSync(join(tmp, '.slack-issue-intake-file'), '')
  assert.deepEqual(listIntakeNames(tmp), ['a', 'b'])
  assert.deepEqual(listIntakeNames(join(tmp, 'missing')), [])
})
test('NR2 homeOfSlackProject は intake の Slack プロジェクトだけからホームを戻す', () => {
  assert.equal(homeOfSlackProject('/u/.slack-issue-intake-ws2-slack-app'), '/u/.slack-issue-intake-ws2')
  assert.equal(homeOfSlackProject('/u/.slack-issue-intake-slack-app'), '/u/.slack-issue-intake')
  for (const dir of ['/u/foo-slack-app', '/u/.slack-issue-intake-ws2', '/u/.slack-issue-intake-UP-slack-app', '/u'])
    assert.equal(homeOfSlackProject(dir), null)
})
test('NR3 名前の案内は一覧とシェルで使えるコマンドを出す', () => {
  const ex = (n: string) => commandWithName('bin/slack-issue-intake.ts', ['mention', '--group', 'dev member', '#x'], n)
  assert.equal(ex('acme'), "node bin/slack-issue-intake.ts --name acme mention --group 'dev member' '#x'")
  assert.equal(
    commandWithName("../My Plugins/it's/bin/slack-issue-intake.ts", ['status'], 'acme'),
    String.raw`node '../My Plugins/it'\''s/bin/slack-issue-intake.ts' --name acme status`,
  )
  assert.deepEqual(nameRequiredMessage(MSG_NAME_REQUIRED, ex, ['acme'], null).split('\n'), [
    MSG_NAME_REQUIRED,
    '今あるワークスペース: acme',
    `例: ${ex('acme')}`,
  ])
  assert.deepEqual(nameRequiredMessage(MSG_NAME_REQUIRED, ex, ['a', 'b'], 'LEGACY').split('\n'), [
    MSG_NAME_REQUIRED,
    '今あるワークスペース: a, b',
    `例: ${ex('<名前>')}`,
    'LEGACY',
  ])
  assert.deepEqual(nameRequiredMessage(MSG_NAME_REQUIRED, ex, [], null).split('\n'), [MSG_NAME_REQUIRED, MSG_NAME_NONE])
})
test('NR4 名前の質問は空と不正な名前を聞き直し、EOF で null を返す', () => {
  const said: string[] = [],
    asked: string[] = [],
    answers = ['', 'BAD', 'slack-app', 'ws2']
  const p: Prompter = {
    ask: (q) => {
      asked.push(q)
      return answers.shift() ?? null
    },
    confirm: () => null,
  }
  assert.equal(
    askWorkspaceName(p, ['a', 'b'], (t) => said.push(t)),
    'ws2',
  )
  assert.equal(asked[0], MSG_NAME_ASK)
  assert.equal(said[0], '今あるワークスペース: a, b')
  assert.ok(said[1]?.includes(MSG_NAME_RULE) && said[2]?.includes(MSG_NAME_RESERVED) && said.length === 3)
  assert.equal(
    askWorkspaceName({ ask: () => null, confirm: () => null }, [], (t) => said.push(t)),
    null,
  )
  assert.equal(said.at(-1), MSG_NAME_LIST_EMPTY)
})
test('NR11 名前なしのホームがあるときだけ 1 行で知らせる', () => {
  const previous = process.env.HOME
  const user = tempHome()
  process.env.HOME = user
  try {
    assert.equal(legacyHomeNotice(), null)
    mkdirSync(join(user, '.slack-issue-intake'))
    const line = legacyHomeNotice() ?? ''
    for (const text of [
      '~/.slack-issue-intake）は使わなくなりました',
      'make setup NAME=<名前>',
      'automation「slack-issue-intake」を止めて',
    ])
      assert.ok(line.includes(text), text)
    assert.ok(!line.includes('\n'))
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
})
