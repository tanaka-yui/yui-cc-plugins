// slack-issue-intake と orca-team-dispatch-task が共有する約束の一致を確かめる（spec 5.1 / 5.4）。
// プラグインは別々にインストールされるので、同じ定義を両方に写して持ち、ここで食い違いを見つける。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// 学びの知らせ（orca が書く）と取り消しの依頼（intake が書く）の形。fixture の写しと、ファイル名の定数を照合する
for (const learnFixture of ['test/fixtures/learn-notices.json', 'test/fixtures/learn-cancels.json'])
  if (!readFileSync(join(intake, learnFixture)).equals(readFileSync(join(dispatch, learnFixture))))
    problems.push(`${learnFixture} の 2 つの写しが違います（slack-issue-intake と orca-team-dispatch-task）`)

const intakeHomes = await import(join(dispatch, 'lib/intake-homes.ts'))
for (const key of ['INTAKE_HOME_DIRNAME', 'INTAKE_NAME_RESERVED_SUFFIX'])
  if (intakeLabels[key] !== intakeHomes[key])
    problems.push(`${key} が違います（slack-issue-intake と orca-team-dispatch-task）`)
if (
  intakeLabels.EXISTING_ACTIVE !== intakeHomes.INTAKE_EXISTING_ACTIVE ||
  !intakeLabels.EXISTING_MODES.includes(intakeHomes.INTAKE_EXISTING_ACTIVE) ||
  !intakeLabels.EXISTING_MODES.includes(intakeHomes.INTAKE_EXISTING_THREAD)
)
  problems.push(
    'EXISTING_ACTIVE が違うか、active / thread が intake の EXISTING_MODES にありません（slack-issue-intake と orca-team-dispatch-task）',
  )
const [p, q] = [intakeLabels.INTAKE_NAME_PATTERN, intakeHomes.INTAKE_NAME_PATTERN]
if (!(p instanceof RegExp && q instanceof RegExp && p.source === q.source && p.flags === q.flags))
  problems.push('INTAKE_NAME_PATTERN が違います（slack-issue-intake と orca-team-dispatch-task）')

const intakePaths = await import(join(intake, 'lib/paths.ts'))
const tmp = mkdtempSync(join(tmpdir(), 'intake-contract-'))
try {
  for (const name of [
    '.slack-issue-intake',
    '.slack-issue-intake-a',
    '.slack-issue-intake-c',
    '.slack-issue-intake-b-slack-app',
    '.slack-issue-intake-slack-app',
    '.slack-issue-intake-UP',
    `.slack-issue-intake-${'x'.repeat(33)}`,
    '.slack-issue-intakeX',
  ]) {
    mkdirSync(join(tmp, name))
    writeFileSync(join(tmp, name, 'config.json'), '{}')
  }
  const expected = intakePaths
    .listIntakeNames(tmp)
    .map((name) => join(tmp, `${intakeLabels.INTAKE_HOME_DIRNAME}-${name}`, 'config.json'))
  if (!isDeepStrictEqual(expected, intakeHomes.listIntakeConfigs(tmp)))
    problems.push(
      '名前つきのホームの選び方が違います（slack-issue-intake の listIntakeNames と orca-team-dispatch-task の listIntakeConfigs）',
    )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// orca の readNotices が、fixture の知らせを読める（intake はこの形のファイルを読む）
const learn = await import(join(dispatch, 'lib/auto-learn.ts'))
if (intakeLabels.LEARN_CANCELS_FILE !== learn.LEARN_CANCELS_FILE)
  problems.push('LEARN_CANCELS_FILE が違います（slack-issue-intake と orca-team-dispatch-task）')
// 知らせの種類と依頼の種類（取り消し・公開）。fixture の依頼の action も、その中のものだけ
if (!isDeepStrictEqual([...intakeLabels.LEARN_NOTICE_KINDS], [...learn.NOTICE_KINDS]))
  problems.push('知らせの種類が違います（LEARN_NOTICE_KINDS と NOTICE_KINDS）')
if (!isDeepStrictEqual([...intakeLabels.LEARN_REQUEST_ACTIONS], [...learn.REQUEST_ACTIONS]))
  problems.push('依頼の種類が違います（LEARN_REQUEST_ACTIONS と REQUEST_ACTIONS）')
// 公開の依頼だけが承認した人の Slack の id（user）を持つ
const fixtureCancels = JSON.parse(readFileSync(join(dispatch, 'test/fixtures/learn-cancels.json'), 'utf8')).cancels
if (
  !isDeepStrictEqual(
    fixtureCancels.map((entry) => [entry.action, typeof entry.user]),
    [
      ['cancel', 'undefined'],
      ['publish', 'string'],
    ],
  )
)
  problems.push('learn-cancels.json の fixture に、取り消しの依頼と user 付きの公開の依頼が 1 つずつありません')
const learnTmp = mkdtempSync(join(tmpdir(), 'learn-contract-'))
const previousHome = process.env.ORCA_DISPATCH_CONFIG_HOME
try {
  process.env.ORCA_DISPATCH_CONFIG_HOME = learnTmp
  mkdirSync(learn.learnDir('contract'), { recursive: true })
  writeFileSync(
    join(learn.learnDir('contract'), learn.LEARN_FILES.notices),
    readFileSync(join(dispatch, 'test/fixtures/learn-notices.json')),
  )
  const notices = learn.readNotices('contract')
  if (
    notices.length !== 2 ||
    notices[0].items.length !== 2 ||
    notices[1].items.length !== 1 ||
    notices[1].items[0].kind !== 'global-draft' ||
    notices[1].items[0].body === ''
  )
    problems.push('learn-notices.json を orca の readNotices で読めません')
} catch (error) {
  problems.push(`learn-notices.json を orca の readNotices で読めません: ${error.message}`)
} finally {
  if (previousHome === undefined) delete process.env.ORCA_DISPATCH_CONFIG_HOME
  else process.env.ORCA_DISPATCH_CONFIG_HOME = previousHome
  rmSync(learnTmp, { recursive: true, force: true })
}

if (problems.length) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log('check-shared-contracts: OK')
