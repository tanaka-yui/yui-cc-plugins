import { readJson, writeJson } from '../../lib/fs.ts'
import { asObject } from '../../lib/json.ts'
import { homePaths } from '../../lib/paths.ts'
import {
  applyProject,
  applyUserDeny,
  inheritedGrants,
  managedSettingsFile,
  permissionFingerprint,
  permissionStatus,
  proposedRules,
  safetyProblems,
} from '../../lib/permissions.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('MW7 別のホームの秘密ファイル拒否を足しても既存の承認を保ち、1ホームの旧指紋とも一致する', () => {
  const previous = process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
  try {
    for (const names of [
      ['.slack-issue-intake', '.slack-issue-intake-ws2', '.slack-issue-intake-ws3'],
      ['.slack-issue-intake-ws2', '.slack-issue-intake', '.slack-issue-intake-ws3'],
    ]) {
      const root = tempHome()
      process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = tempHome()
      const accepted = new Map<string, string>()
      for (const name of names) {
        const home = join(root, name)
        const rules = proposedRules(home)
        applyProject(rules)
        applyUserDeny(rules)
        const fingerprint = permissionFingerprint(home)
        assert.ok(fingerprint)
        if (!accepted.size) {
          // 更新前の正規形で計算する。自分の secrets の deny を除く変更では一致しない。
          const legacy = createHash('sha256')
            .update(
              JSON.stringify({
                managed: null,
                project: {
                  permissions: {
                    allow: rules.project.allow,
                    defaultMode: rules.project.defaultMode,
                    deny: rules.project.deny,
                    disableBypassPermissionsMode: rules.project.disableBypassPermissionsMode,
                  },
                },
                user: { deny: rules.user.deny },
              }),
            )
            .digest('hex')
          assert.equal(fingerprint, legacy)
        }
        accepted.set(home, fingerprint)
        for (const [configured, fingerprint] of accepted)
          assert.equal(permissionStatus(configured, fingerprint), 'accepted', configured)
      }
      const home = join(root, names[0] ?? '')
      const rules = proposedRules(home)
      const user = asObject(readJson(rules.user.file))
      assert.ok(user)
      const p = asObject(user.permissions)
      assert.ok(p)
      assert.ok(Array.isArray(p.deny))
      p.deny = p.deny.filter((rule) => rule !== rules.user.deny[0])
      writeJson(rules.user.file, user)
      assert.equal(permissionStatus(home, accepted.get(home) ?? null), 'unsafe')
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
    else process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = previous
  }
})
test('MW8 他のディレクトリ・ファイル・操作の deny と継承権限の変更は引き続き承認を外す', () => {
  const root = tempHome()
  const home = join(root, '.slack-issue-intake')
  const previous = process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
  process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = tempHome()
  try {
    const rules = proposedRules(home)
    applyProject(rules)
    applyUserDeny(rules)
    const accepted = permissionFingerprint(home)
    assert.ok(accepted)
    const other = join(root, '.slack-issue-intake-ws2')
    for (const deny of [
      `Read(/${join(root, '.slack-issue-intake-slack-app', 'secrets.json')})`,
      `Read(/${join(root, '.slack-issue-intake-UP', 'secrets.json')})`,
      `Read(/${join(other, 'config.json')})`,
      `Write(/${join(other, 'secrets.json')})`,
      `Read(/${join(root, 'elsewhere', '.slack-issue-intake-ws2', 'secrets.json')})`,
    ]) {
      writeJson(rules.user.file, { permissions: { deny: [...rules.user.deny, deny] } })
      assert.equal(permissionStatus(home, accepted), 'changed', deny)
    }
    for (const patch of [
      { allow: ['Bash(git status)'] },
      { additionalDirectories: [root] },
      { defaultMode: 'dontAsk' },
    ]) {
      writeJson(rules.user.file, { permissions: { deny: rules.user.deny, ...patch } })
      assert.equal(permissionStatus(home, accepted), 'changed')
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME
    else process.env.SLACK_ISSUE_INTAKE_CLAUDE_HOME = previous
  }
})
