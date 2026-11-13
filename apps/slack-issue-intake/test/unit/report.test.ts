import { readReport, renderReport } from '../../lib/report.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.TZ = 'UTC'
const path = join(import.meta.dirname, '../fixtures/auto-report.json')
test('RP1 報告の時刻と経過は材料を基準にし、空きを表示し、題名をエスケープする', () => {
  const report = readReport(path)
  assert.ok(report)
  assert.equal(
    renderReport(report, new Date('2026-11-13T05:35:00Z')),
    [
      '📋 自動実行の状況（11/13 05:30）',
      '実行中 1件',
      '  • orgA/app#42 ログインできない … Mac M2max・35分 / 上限60分',
      'キュー 1件',
      '  1. [critical] orgA/app#51 決済が落ちる',
      '空き: Mac M2max 0/2',
    ].join('\n'),
  )
  const first = report.running[0]
  assert.ok(first)
  first.title = '<b>&'
  assert.ok(renderReport(report, new Date(report.updatedAt)).includes('&lt;b&gt;&amp;'))
})
test('RP3 古さは間隔の3倍を超えたときだけ警告する', () => {
  const report = readReport(path)
  assert.ok(report)
  assert.ok(!renderReport(report, new Date('2026-11-13T05:45:00Z')).startsWith('⚠'))
  assert.equal(
    renderReport(report, new Date('2026-11-13T05:46:00Z')).split('\n')[0],
    '⚠ `--auto` が止まっています（最後の更新 05:30）',
  )
})
test('RP1 材料の構造を検査し、無いファイルや壊れた値は読めない', () => {
  const file = join(tempHome(), 'report.json')
  assert.equal(readReport(file), null)
  for (const text of ['{', '{}', '{"version":1,"name":"x","updatedAt":"bad"}']) {
    writeFileSync(file, text)
    assert.equal(readReport(file), null)
  }
})
