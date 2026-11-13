// slack-issue-intake と orca-team-dispatch-task が共有する約束の一致を確かめる（spec 5.1 / 5.4）。
// プラグインは別々にインストールされるので、同じ定義を両方に写して持ち、ここで食い違いを見つける。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const intake = join(root, 'apps/slack-issue-intake')
const dispatch = join(root, 'apps/orca-team-dispatch-task')
const problems = []

const a = (await import(join(intake, 'lib/defaults.ts'))).STATUS_LABELS
const b = (await import(join(dispatch, 'lib/status.ts'))).STATUS_LABELS
if (!isDeepStrictEqual(a, b))
  problems.push(
    `STATUS_LABELS が違います:\n  slack-issue-intake/lib/defaults.ts: ${JSON.stringify(a)}\n  orca-team-dispatch-task/lib/status.ts: ${JSON.stringify(b)}`,
  )

const fixture = 'test/fixtures/orca-auto-comments.json'
if (!readFileSync(join(intake, fixture)).equals(readFileSync(join(dispatch, fixture))))
  problems.push(`${fixture} の 2 つの写しが違います（slack-issue-intake と orca-team-dispatch-task）`)

const intakeLabels = await import(join(intake, 'lib/defaults.ts'))
const dispatchLabels = await import(join(dispatch, 'lib/status.ts'))
if (!isDeepStrictEqual([intakeLabels.SOURCE_LABEL, intakeLabels.ADOPTED_LABEL], dispatchLabels.MANAGED_LABELS))
  problems.push('MANAGED_LABELS が違います')
const names = intakeLabels.LABEL_SPECS.map((label) => label.name)
for (const name of [...Object.values(dispatchLabels.PRIORITY_LABELS), dispatchLabels.FEATURE_LABEL])
  if (!names.includes(name)) problems.push(`LABEL_SPECS に ${name} がありません`)
const reportFixture = 'test/fixtures/auto-report.json'
if (!readFileSync(join(intake, reportFixture)).equals(readFileSync(join(dispatch, reportFixture))))
  problems.push(`${reportFixture} の 2 つの写しが違います（slack-issue-intake と orca-team-dispatch-task）`)

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log('check-shared-contracts: OK')
