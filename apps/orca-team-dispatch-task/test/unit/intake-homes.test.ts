// test/unit/intake-homes.test.ts（新規）
import { listIntakeConfigs } from '../../lib/intake-homes.ts'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('MI4 intake homes are listed by the shared naming rule', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'intake-homes-'))
  try {
    for (const [name, hasConfig] of [
      ['.slack-issue-intake', true],
      ['.slack-issue-intake-ws2', true],
      ['.slack-issue-intake-b', true],
      ['.slack-issue-intake-slack-app', true],
      ['.slack-issue-intake-x-slack-app', true],
      ['.slack-issue-intake-UP', true],
      ['.slack-issue-intake-c', false],
      [`.slack-issue-intake-${'a'.repeat(33)}`, true],
      ['.slack-issue-intakeX', true],
      ['.other', true],
    ] as const) {
      mkdirSync(join(tmp, name))
      if (hasConfig) writeFileSync(join(tmp, name, 'config.json'), '{}')
    }
    assert.deepEqual(listIntakeConfigs(tmp), [
      join(tmp, '.slack-issue-intake', 'config.json'),
      join(tmp, '.slack-issue-intake-b', 'config.json'),
      join(tmp, '.slack-issue-intake-ws2', 'config.json'),
    ])
    assert.deepEqual(listIntakeConfigs(join(tmp, 'missing')), [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
