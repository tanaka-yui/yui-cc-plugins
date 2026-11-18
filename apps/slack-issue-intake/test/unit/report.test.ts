import { readReport, renderReport } from '../../lib/report.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.TZ = 'UTC'
const path = join(import.meta.dirname, '../fixtures/auto-report.json')
const at = new Date('2026-11-13T05:35:00Z')
test('RP1 報告の時刻と経過は材料を基準にし、マシンの名前を表示し、題名をエスケープする', () => {
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
      'マシン: Mac M2max',
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
test('RP10 マシンは名前とつながるかだけを出し、使用数・上限・空きの数を出さない', () => {
  const report = readReport(path)
  assert.ok(report)
  report.hosts = [
    { name: 'Mac M2max', used: 1, max: 4, reachable: true },
    { name: 'Mac mini', used: 0, max: 2, reachable: false },
  ]
  const text = renderReport(report, at)
  assert.equal(text.split('\n').at(-1), 'マシン: Mac M2max・Mac mini つながらない')
  // ほかのワークスペースの作業で使用数が変わっても、上限が変わっても、文面は変わらない
  report.hosts = [
    { name: 'Mac M2max', used: 4, max: 8, reachable: true },
    { name: 'Mac mini', used: 2, max: 2, reachable: false },
  ]
  assert.equal(renderReport(report, at), text)
  report.hosts = []
  assert.equal(renderReport(report, at).split('\n').at(-1), 'マシン: （なし）')
})
