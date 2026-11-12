import { readJson, writeJson } from '../../lib/fs.ts'
import { asObject } from '../../lib/json.ts'
import { homePaths } from '../../lib/paths.ts'
import {
  applyProject,
  applyUserDeny,
  inheritedGrants,
  managedSettingsFile,
  permissionFingerprint,
  proposedRules,
  safetyProblems,
} from '../../lib/permissions.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const setup = () => {
  const home = tempHome()
  process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = tempHome()
  const rules = proposedRules(home)
  applyProject(rules)
  applyUserDeny(rules)
  return { home, rules }
}
test('PM1/PM2 許可範囲をちょうど適用し、広い追加許可を拒否', () => {
  const { home, rules } = setup()
  assert.equal(rules.project.allow.length, 6)
  assert.ok(rules.project.allow.includes(`Bash(${home}/bin/slack-issue-intake collect)`))
  assert.ok(!rules.project.allow.some((r) => r.includes('collect *')))
  assert.equal(rules.project.deny.length, 11)
  assert.deepEqual(safetyProblems(home), [])
  const raw = asObject(readJson(rules.project.file))
  assert.ok(raw)
  const p = asObject(raw.permissions)
  assert.ok(p)
  p.allow = [...rules.project.allow, 'Bash(ls)']
  writeJson(rules.project.file, raw)
  assert.ok(safetyProblems(home).length > 0)
})
test('PM3 指紋はキー順に依存せず、userのdeny・モード・allowの変化を検出', () => {
  const { home, rules } = setup()
  const fp = permissionFingerprint(home)
  assert.ok(fp)
  const raw = asObject(readJson(rules.user.file))
  assert.ok(raw)
  writeJson(rules.user.file, Object.fromEntries(Object.entries(raw).reverse()))
  assert.equal(permissionFingerprint(home), fp)
  for (const patch of [
    { allow: ['Bash(git status)'] },
    { deny: [...rules.user.deny, 'Read(/x)'] },
    { defaultMode: 'dontAsk' },
  ]) {
    writeJson(rules.user.file, { permissions: { deny: rules.user.deny, ...patch } })
    assert.notEqual(permissionFingerprint(home), fp)
  }
  writeJson(rules.user.file, {
    permissions: { deny: rules.user.deny, allow: ['Bash(git status)'], additionalDirectories: ['/tmp/x'] },
  })
  assert.deepEqual(inheritedGrants(), { allow: ['Bash(git status)'], dirs: ['/tmp/x'] })
})
test('PM4 local・managed・secrets denyの不備を拒否', () => {
  const { home, rules } = setup()
  const local = homePaths(home).projectLocalSettings
  writeJson(local, { permissions: { defaultMode: 'bypassPermissions' } })
  assert.ok(safetyProblems(home).length)
  rmSync(local)
  const managed = managedSettingsFile()
  writeJson(managed, { permissions: { defaultMode: 'acceptEdits' } })
  assert.ok(safetyProblems(home).length)
  writeFileSync(managed, '{')
  assert.ok(safetyProblems(home).length)
  rmSync(managed)
  writeJson(rules.user.file, { permissions: { deny: [rules.user.deny[0] ?? ''] } })
  assert.ok(safetyProblems(home).length)
  assert.equal(join(process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME ?? '', 'managed-settings.json'), managed)
})
