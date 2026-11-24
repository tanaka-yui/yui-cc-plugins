import { parseFlags, parseNow } from '../cli.ts'
import { getSubmission, transition } from '../db.ts'
import { validateDecisions } from '../decisions.ts'
import {
  APPLY_LEASE_MS,
  COMMAND_DEADLINE_MS,
  MAX_TITLE_CHARS,
  QUESTION_ISSUE_CATEGORY,
  QUESTION_ISSUE_PRIORITY,
  RUN_ID_PATTERN,
  TITLE_ELLIPSIS,
} from '../defaults.ts'
import { driveItem } from '../drive.ts'
import { readJson } from '../fs.ts'
import { withoutBase } from '../issue-body.ts'
import { claimApply, releaseLease, renewLease } from '../lease.ts'
import { rememberOrcaBin } from '../orca.ts'
import { intakeHome, runPaths } from '../paths.ts'
import { removeRun } from '../runs.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { readWork } from '../work.ts'
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('apply', { args: argv, options: { run: { type: 'string' }, now: { type: 'string' } } })
  const runId = values.run
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    console.error('--run に今回のUUIDを指定してください')
    process.exitCode = 2
    return
  }
  const at = parseNow('apply', values.now)
  const now = () => (values.now ? new Date(at) : new Date())
  const opened = openRuntime(intakeHome())
  if (!opened.ok) {
    console.error(opened.reason)
    process.exitCode = 2
    return
  }
  const rt = opened.runtime
  rememberOrcaBin(rt.db)
  try {
    const paths = runPaths(rt.paths.runsDir, runId)
    const work = readWork(paths.workFile)
    if (!work || work.runId !== runId) {
      console.error('今回の work.json がありません。collect からやり直してください')
      process.exitCode = 2
      return
    }
    const validated = validateDecisions(readJson(paths.decisionsFile), work)
    if (!validated.ok) {
      for (const error of validated.errors) console.error(error)
      process.exitCode = 3
      return
    }
    const claim = claimApply(rt.db, runId, now())
    if (!claim.ok) {
      console.error(claim.reason)
      process.exitCode = 2
      return
    }
    const ctx = { rt, token: claim.token, ttlMs: APPLY_LEASE_MS, now, deadline: Date.now() + COMMAND_DEADLINE_MS }
    let pending = false
    let stopped = false
    try {
      for (const d of validated.value.decisions) {
        const item = work.items.find((i) => i.id === d.id)
        const s = getSubmission(rt.db, d.id)
        if (!item || !s) {
          console.log(`pending id=${d.id} state=missing error=state changed`)
          pending = true
          continue
        }
        if (stopped) {
          console.log(`pending id=${s.id} state=${s.state} error=前の処理を中断しました`)
          pending = true
          continue
        }
        // 質問から起票するときは、バグ・優先度 middle・決定の題の Issue にする（ラベルと本文の表もこの値を使う）。
        // 向き先は持ち込まない（おまかせ）
        const title = d.action === 'create' && d.title ? [...d.title] : null
        const fields =
          title && s.fields
            ? {
                fields: {
                  ...withoutBase(s.fields),
                  category: QUESTION_ISSUE_CATEGORY,
                  priority: QUESTION_ISSUE_PRIORITY,
                  fullTitle: title.join(''),
                  title:
                    title.length > MAX_TITLE_CHARS
                      ? title.slice(0, MAX_TITLE_CHARS - 1).join('') + TITLE_ELLIPSIS
                      : title.join(''),
                },
              }
            : {}
        const patch =
          d.action === 'ask' || d.action === 'answer'
            ? { state: 'asking' as const, decision: d }
            : d.action === 'close'
              ? { state: 'closing' as const, decision: d }
              : {
                  state: 'creating' as const,
                  decision: d,
                  ...fields,
                  createStartedAt: s.createStartedAt ?? now().toISOString(),
                  createLogin: s.createLogin ?? rt.config.github.login,
                }
        if (!transition(rt.db, claim.token, s.id, item.kind, patch, now().toISOString())) {
          const alive = renewLease(rt.db, claim.token, now(), APPLY_LEASE_MS)
          console.log(`pending id=${s.id} state=${s.state} error=${alive ? 'state changed' : 'lease lost'}`)
          pending = true
          if (!alive) stopped = true
          continue
        }
        const changed = getSubmission(rt.db, s.id)
        const outcomes = changed ? await driveItem(ctx, changed) : []
        const updated = getSubmission(rt.db, s.id)
        const last = outcomes.at(-1)
        for (const o of outcomes) if (o.warning) console.error(maskSecrets(o.warning))
        if (updated?.state === 'waiting') console.log(`${d.action === 'answer' ? 'answered' : 'asked'} id=${s.id}`)
        else if (updated?.state === 'created') console.log(`created id=${s.id} url=${updated.issueUrl}`)
        else if (updated?.state === 'closed') console.log(`closed id=${s.id}`)
        else {
          console.log(
            `pending id=${s.id} state=${updated?.state ?? s.state} error=${maskSecrets(last?.error ?? '処理を完了できません')}`,
          )
          pending = true
        }
        if (last?.stop) stopped = true
      }
    } finally {
      removeRun(rt.db, rt.paths.runsDir, runId)
      releaseLease(rt.db, claim.token)
    }
    process.exitCode = pending ? 1 : 0
  } finally {
    rt.db.close()
  }
}
