// --auto precheck and difficulty judgment. No runtime npm dependencies.

import { readAutoConfig } from '../lib/auto-config.ts'
import { labelNames, readGithub, viewIssue } from '../lib/auto-github.ts'
import { AUTO_FILES, autoDir, autoNow } from '../lib/auto-paths.ts'
import { readState, releaseLock, takeLockWait, writeState } from '../lib/auto-state.ts'
import { runTick } from '../lib/auto-tick.ts'
import { transition } from '../lib/auto-transition.ts'
import { die } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString } from '../lib/json.ts'
import { FEATURE_LABEL, STATUS } from '../lib/status.ts'
import { envCount } from '../lib/sys.ts'

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const AUTO_LOCK_WAIT_MS = 120_000
const LOCK_TTL_MS = 160_000
const main = (argv: string[]): number => {
  const command = argv[0] ?? ''
  if (!['tick', 'status', 'judge-list', 'judge-apply', 'judge-model', 'judge-effort', 'clear-start'].includes(command))
    die('orca-auto', 'command is required: judge-list / judge-apply / judge-model / judge-effort / clear-start')
  const flags = new Map<string, string>()
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i] ?? ''
    const value = argv[i + 1] ?? die('orca-auto', `${flag} requires a value`)
    if (!['--name', '--file', '--key'].includes(flag) || value.startsWith('--'))
      die('orca-auto', `invalid option: ${flag}`)
    flags.set(flag, value)
  }
  const name = flags.get('--name') ?? 'main'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) die('orca-auto', 'invalid name')
  if (command === 'judge-apply' && !flags.get('--file')) die('orca-auto', '--file is required')
  if (command === 'clear-start' && !flags.get('--key')) die('orca-auto', '--key is required')
  if (command === 'tick') return runTick(name)
  if (command === 'status') {
    const state = readState(name)
    console.log(`${name}: ${Object.keys(state.issues).length} 件`)
    for (const issue of Object.values(state.issues))
      console.log(
        `${issue.key}: ${issue.phase} / 世代 ${issue.generation}${issue.startAttempt ? ' / 起動の結果が不明（保留）' : ''}${issue.cleanupPending ? ' / 後片付け待ち' : ''}`,
      )
    return 0
  }
  const config = readAutoConfig(name)
  if (!config) {
    console.error('設定を読めません')
    return 1
  }
  if (command === 'judge-model' || command === 'judge-effort') {
    console.log(command === 'judge-model' ? config.judge.model : config.judge.effort)
    return 0
  }
  if (!takeLockWait(name, LOCK_TTL_MS, envCount('ORCA_AUTO_LOCK_WAIT_MS', AUTO_LOCK_WAIT_MS))) {
    console.error('tick が動いている')
    return 3
  }
  try {
    const state = readState(name)
    const save = () => writeState(name, state)
    if (command === 'clear-start') {
      const issue = state.issues[flags.get('--key') ?? '']
      if (!issue?.startAttempt) return 1
      const old = issue.startAttempt
      issue.startAttempt = null
      save()
      console.log(JSON.stringify(old))
      return 0
    }
    if (command === 'judge-list') {
      const issues = Object.values(state.issues)
        .filter((i) => i.phase === 'judging' && !i.pendingLabel)
        .flatMap((issue) => {
          const detail = asObject(
            readGithub(['issue', 'view', String(issue.number), '--repo', issue.repo, '--json', 'body,labels']),
          )
          if (!detail || typeof detail.body !== 'string' || !Array.isArray(detail.labels)) return []
          return [
            {
              key: issue.key,
              generation: issue.generation,
              title: issue.title,
              body: detail.body,
              labels: labelNames(detail.labels),
              category: issue.category,
              returnedFromEng: issue.returnedFromEng,
              related: config.sources.find((s) => s.repo === issue.repo)?.related ?? [],
            },
          ]
        })
      const output = {
        issues,
        checkouts: Object.fromEntries(Object.entries(config.repos).map(([r, c]) => [r, c.checkout])),
        limits: { defaultMinutes: config.limits.defaultMinutes, maxMinutes: config.limits.maxMinutes },
        decisionsFile: join(autoDir(name), AUTO_FILES.decisions),
      }
      state.judgingSince = autoNow()
      save()
      mkdirSync(join(autoDir(name), 'judge'), { recursive: true })
      if (!writeAtomic(join(autoDir(name), AUTO_FILES.pending), JSON.stringify(output)))
        throw new Error('判定の材料を書けません')
      console.log(JSON.stringify(output))
      return 0
    }
    const rows = asArray(readJson(flags.get('--file') ?? ''))
    if (!rows) {
      console.error('判定結果は JSON の配列にしてください')
      return 1
    }
    let rejected = false
    for (const row of rows) {
      const decision = asObject(row)
      const key = asString(decision?.key)
      const issue = key ? state.issues[key] : null
      const targets = asArray(decision?.targets)
      const related = config.sources.find((s) => s.repo === issue?.repo)?.related ?? []
      if (
        !decision ||
        !issue ||
        issue.phase !== 'judging' ||
        issue.pendingLabel ||
        issue.generation !== decision.generation ||
        !['auto', 'eng'].includes(asString(decision.route) ?? '') ||
        !targets?.length ||
        targets.some((t) => typeof t !== 'string' || !related.includes(t)) ||
        typeof decision.limitMinutes !== 'number' ||
        !Number.isInteger(decision.limitMinutes) ||
        decision.limitMinutes < 1 ||
        decision.limitMinutes > config.limits.maxMinutes ||
        typeof decision.reason !== 'string' ||
        !decision.reason.trim()
      ) {
        console.error(`判定を破棄しました: ${key ?? 'key がありません'}`)
        rejected = true
        continue
      }
      issue.targets = targets as string[]
      issue.limitMinutes = decision.limitMinutes
      issue.reason = decision.reason
      issue.updatedAt = autoNow()
      const feature = issue.category === FEATURE_LABEL && !issue.returnedFromEng
      if (decision.route === 'eng' || targets.length > 1 || feature) {
        const current = viewIssue(issue.repo, issue.number)
        if (!current) {
          rejected = true
          continue
        }
        if (current.state === 'CLOSED') {
          delete state.issues[issue.key]
          save()
          continue
        }
        if (!current.labels.includes(STATUS.ready)) {
          issue.phase = 'stopped'
          save()
          continue
        }
        if (targets.length > 1) issue.reason += '（複数リポジトリの Issue は自動実行の対象外です）'
        if (feature) issue.reason += '（新機能の Issue はエンジニアが対応します）'
        transition(
          issue,
          'judged',
          { reason: issue.reason, limitMinutes: issue.limitMinutes },
          STATUS.ready,
          STATUS.readyEng,
          false,
          'eng',
          save,
        )
      } else {
        issue.phase = 'queued'
        save()
      }
    }
    state.judgingSince = null
    save()
    return rejected ? 1 : 0
  } finally {
    releaseLock(name)
  }
}
try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
