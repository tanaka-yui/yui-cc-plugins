import { readReport, renderReport, scopeReport } from '../../lib/report.ts'
import { tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Config, RepoSetting } from '../../lib/config.ts'

process.env.TZ = 'UTC'
const path = join(import.meta.dirname, '../fixtures/auto-report.json')
const at = new Date('2026-11-13T05:35:00Z')
// 照合に使うのは repos だけなので、必要なキーだけを持つ設定にする（test/unit/automation.test.ts と同じ書き方）
const home = (...names: string[]): Config =>
  ({ repos: names.map((name): RepoSetting => ({ name, form: true, existing: 'skip' })) }) as Config
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
test('RP7 ほかのリポジトリの実行中とキューは描かず、リポジトリ名は大文字小文字を区別せずに照合する', () => {
  const original = readReport(path)
  const report = readReport(path)
  assert.ok(original)
  assert.ok(report)
  report.running.push({
    issue: 'orgB/web#7',
    title: '他社の障害',
    host: 'Mac M2max',
    startedAt: '2026-11-13T05:00:00Z',
    limitMinutes: 30,
  })
  report.queue.unshift({ issue: 'orgB/web#8', title: '他社の要望', priority: 'critical' })
  for (const config of [home('orgA/app'), home('ORGA/APP'), home('acme/app', 'OrgA/App')])
    assert.equal(renderReport(scopeReport(report, config), at), renderReport(original, at))
  // 引数は書き換えない
  assert.equal(report.running.length, 2)
  assert.equal(report.queue.length, 2)
})
test('RP8 件数・キューの番号・ほか N件は絞ったあとの Issue だけで数える', () => {
  const report = readReport(path)
  assert.ok(report)
  report.running.push(
    { issue: 'orgB/web#1', title: '他社の作業', host: 'Mac M2max', startedAt: '2026-11-13T05:00:00Z', limitMinutes: 60 },
    { issue: 'orgA/app#43', title: '自社の作業', host: 'Mac M2max', startedAt: '2026-11-13T05:10:00Z', limitMinutes: 60 },
  )
  // 自分の 12 件（101〜112）にほかの 5 件（201〜205）を混ぜる。先頭はほかのリポジトリ
  report.queue = [201, 101, 102, 202, 103, 104, 203, 105, 106, 204, 107, 108, 109, 110, 205, 111, 112].map((n) => ({
    issue: n > 200 ? `orgB/web#${n}` : `orgA/app#${n}`,
    title: `件名${n}`,
    priority: 'middle',
  }))
  assert.equal(
    renderReport(scopeReport(report, home('orgA/app')), at),
    [
      '📋 自動実行の状況（11/13 05:30）',
      '実行中 2件',
      '  • orgA/app#42 ログインできない … Mac M2max・35分 / 上限60分',
      '  • orgA/app#43 自社の作業 … Mac M2max・20分 / 上限60分',
      'キュー 12件',
      ...[101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map((n, i) => `  ${i + 1}. [middle] orgA/app#${n} 件名${n}`),
      '  ほか 2件',
      'マシン: Mac M2max',
    ].join('\n'),
  )
})
test('RP9 # が無いなどリポジトリ名を取り出せない issue は、ホームのリポジトリ名と同じ文字列でも描かない', () => {
  const report = readReport(path)
  assert.ok(report)
  const first = report.running[0]
  assert.ok(first)
  first.issue = 'orgA/app'
  report.queue.push(
    { issue: 'orgA/app', title: '番号なし', priority: 'high' },
    { issue: '#52', title: '名前なし', priority: 'high' },
    // 最後の # より前は orgA/app#51 で、登録されていないので出さない（split('#')[0] に置き換えると落ちる）
    { issue: 'orgA/app#51#52', title: '番号が2つ', priority: 'high' },
  )
  assert.equal(
    renderReport(scopeReport(report, home('orgA/app')), at),
    ['📋 自動実行の状況（11/13 05:30）', '実行中 0件', 'キュー 1件', '  1. [critical] orgA/app#51 決済が落ちる', 'マシン: Mac M2max'].join(
      '\n',
    ),
  )
})
