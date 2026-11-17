// test/unit/paths.test.ts（新規）
import { automationNameFor, createArgs } from '../../lib/automation.ts'
import { homeForName, homePaths, intakeNameProblem, nameOfHome } from '../../lib/paths.ts'

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Config } from '../../lib/config.ts'

test('MW1 home and automation name follow the workspace name', () => {
  assert.equal(homeForName(null), join(homedir(), '.slack-issue-intake'))
  assert.equal(homeForName('ws2'), join(homedir(), '.slack-issue-intake-ws2'))
  assert.equal(nameOfHome(homeForName('ws2')), 'ws2')
  assert.equal(nameOfHome(`${homeForName('ws2')}/`), 'ws2')
  for (const home of [homeForName(null), '/tmp/x', '/tmp/.slack-issue-intake-slack-app', '/tmp/.slack-issue-intake-UP'])
    assert.equal(nameOfHome(home), null, home)
  assert.equal(automationNameFor(homeForName('ws2')), 'slack-issue-intake-ws2')
  assert.equal(automationNameFor(homeForName(null)), 'slack-issue-intake')
  assert.equal(automationNameFor('/tmp/x'), 'slack-issue-intake')
  const home = homeForName('ws2')
  const create = createArgs({ everyMinutes: 5 } as Config, homePaths(home), home)
  assert.equal(create[create.indexOf('--name') + 1], 'slack-issue-intake-ws2')
})
test('MW2 invalid names are rejected', () => {
  for (const name of ['', 'WS', 'a/b', '..', 'a'.repeat(33), '-a', 'a_b', 'a.b', 'slack-app', 'foo-slack-app'])
    assert.notEqual(intakeNameProblem(name), null, name)
  for (const name of ['ws2', 'a', '0', 'team-1', 'a-', 'a'.repeat(32), 'slack-apps', 'slackapp'])
    assert.equal(intakeNameProblem(name), null, name)
})
