// --auto precheck and difficulty judgment. No runtime npm dependencies.

import { applyFlow, baseLabels, candidatesOf, resolveBases, restrictedBase } from '../lib/auto-base.ts'
import { intakeActiveRepos, pickSources, readAutoConfig, relayAllowance, sourceAutoMerge } from '../lib/auto-config.ts'
import { labelNames, readGithub, viewIssue } from '../lib/auto-github.ts'
import {
  applyLearn,
  decisionRuleIds,
  endRecorder,
  type HistoryRow,
  type LearnStore,
  learnedFor,
  readHistory,
  readStore,
  reflectionsOf,
  shownOf,
} from '../lib/auto-learn.ts'
import { AUTO_FILES, autoDir, autoNow } from '../lib/auto-paths.ts'
import { syncProjects } from '../lib/auto-project.ts'
import { awaitingBase } from '../lib/auto-queue.ts'
import { runSetup } from '../lib/auto-setup.ts'
import {
  AUTO_LOCK_TTL_MS,
  AUTO_LOCK_WAIT_MS,
  readState,
  releaseLock,
  takeLockWait,
  writeState,
} from '../lib/auto-state.ts'
import { runTick } from '../lib/auto-tick.ts'
import { notifyNeedsBase, transition } from '../lib/auto-transition.ts'
import { die } from '../lib/cli.ts'
import { readJson, writeAtomic } from '../lib/fs.ts'
import { asArray, asObject, asString, type Json } from '../lib/json.ts'
import {
  ENTRY_FILE,
  judgeFingerprint,
  judgeRulesProblems,
  LAUNCHER_ENV,
  launcherPaths,
  pluginRoot,
} from '../lib/setup-automation.ts'
import { createPrompter } from '../lib/setup-prompt.ts'
import { FEATURE_LABEL, STATUS } from '../lib/status.ts'
import { envCount } from '../lib/sys.ts'
import { terminalRows, terminalTable } from '../lib/terminals.ts'

import { mkdirSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isatty } from 'node:tty'

// AI の判定に関係なく CLI が eng に回す理由（判定の履歴の forced）
const FORCED_FEATURE = '新機能'
const FORCED_TARGETS = '3 リポジトリ以上'

const main = (argv: string[]): number => {
  const command = argv[0] ?? ''
  if (
    !['setup', 'hosts', 'roles', 'tick', 'status', 'judge-doc', 'judge-list', 'judge-apply', 'clear-start'].includes(
      command,
    )
  )
    die('orca-auto', 'command is required: judge-list / judge-apply / clear-start')
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
  if (command === 'setup' || command === 'hosts' || command === 'roles') {
    if (!isatty(0) && process.env.ORCA_AUTO_TEST_STDIN !== '1') {
      console.error(`ターミナルで make ${command === 'setup' ? 'auto-setup' : command} を実行してください`)
      return 2
    }
    const out = (text: string): void => {
      writeSync(1, text)
    }
    return runSetup(name, createPrompter(0, out), out, command === 'setup' ? undefined : command)
  }
  if (command === 'judge-doc') {
    const prefix = process.env[LAUNCHER_ENV] ? launcherPaths().launcher : `node ${join(pluginRoot(), ENTRY_FILE)}`
    console.log(readFileSync(join(pluginRoot(), 'skills/orca-team-dispatch-task/references/auto-judge.md'), 'utf8'))
    console.log(
      `## Commands\n\n- List: \`${prefix} judge-list --name ${name}\`\n- Apply: \`${prefix} judge-apply --name ${name} --file ${join(autoDir(name), AUTO_FILES.decisions)}\``,
    )
    return 0
  }
  if (command === 'tick') {
    const config = process.env[LAUNCHER_ENV] ? readAutoConfig(name) : null
    if (config) {
      if (!config.automation?.acceptedFingerprint) {
        console.log('判定の権限が承認されていません。make auto-setup で有効にしてください')
        return 1
      }
      if (
        judgeRulesProblems(config, launcherPaths().launcher).length ||
        judgeFingerprint(config) !== config.automation.acceptedFingerprint
      ) {
        console.log('判定の権限が承認したときと違います。make auto-setup をやり直してください')
        return 1
      }
    }
    return runTick(name)
  }
  if (command === 'status') {
    const state = readState(name)
    console.log(`${name}: ${Object.keys(state.issues).length} 件`)
    for (const issue of Object.values(state.issues))
      console.log(
        `${issue.key}: ${issue.phase} / 世代 ${issue.generation}${issue.startAttempt ? ' / 起動の結果が不明（保留）' : ''}${issue.cleanupPending ? ' / 後片付け待ち' : ''}`,
      )
    // 役ごとの端末へ飛ぶコマンド。status dir がまだ無い（起動前の）Issue は行を出さない
    const rows = Object.values(state.issues).flatMap((issue) =>
      issue.statusDir ? terminalRows(issue.statusDir, issue.key) : [],
    )
    if (rows.length > 0) process.stdout.write(`\n${terminalTable(rows)}`)
    // 学びの有効な規則。読めなくても上の出力は残す
    try {
      const rules = readStore(name).rules.filter((rule) => rule.status === 'active')
      if (rules.length > 0) {
        console.log('\n学びの規則（有効なもの）:')
        for (const rule of rules)
          console.log(
            `${rule.repo} ${rule.id} ${rule.direction} 様子見の残り ${rule.probationLeft} 根拠 ${rule.evidence.length} 件: ${rule.topic}`,
          )
      }
    } catch (error) {
      console.log(`学びの規則を読めません（${error instanceof Error ? error.message : String(error)}）`)
    }
    return 0
  }
  const config = readAutoConfig(name)
  if (!config) {
    console.error('設定を読めません')
    return 1
  }
  if (!takeLockWait(name, AUTO_LOCK_TTL_MS, envCount('ORCA_AUTO_LOCK_WAIT_MS', AUTO_LOCK_WAIT_MS))) {
    console.error('tick が動いている')
    return 3
  }
  try {
    const state = readState(name)
    const save = () => writeState(name, state)
    const onEnd = endRecorder(name)
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
      // 学びのデータが読めなくても判定は止めない。1 行出して、規則・事例・振り返りを空にする
      let history: HistoryRow[] = []
      let store: LearnStore = { rules: [], nextRule: 1, nextNotice: 1 }
      try {
        history = readHistory(name)
        store = readStore(name)
      } catch (error) {
        history = []
        console.error(`判定の学びを読めません（${error instanceof Error ? error.message : String(error)}）`)
      }
      const issues = Object.values(state.issues)
        .filter((i) => i.phase === 'judging' && !i.pendingLabel)
        .flatMap((issue) => {
          const detail = asObject(
            readGithub(['issue', 'view', String(issue.number), '--repo', issue.repo, '--json', 'body,labels']),
          )
          if (!detail || typeof detail.body !== 'string' || !Array.isArray(detail.labels)) return []
          const labels = labelNames(detail.labels)
          const source = config.sources.find((s) => s.repo === issue.repo)
          if (awaitingBase(issue, labels, source?.autoReady === true, config.repos)) return []
          const related = source?.related ?? []
          return [
            {
              key: issue.key,
              generation: issue.generation,
              title: issue.title,
              body: detail.body,
              labels,
              category: issue.category,
              returnedFromEng: issue.returnedFromEng,
              autoReady: issue.autoReady,
              related,
              // 対象はまだ決まっていないので、related 全体で向き先の候補と判定の要否を出す
              base: {
                labels: baseLabels(labels),
                candidates: candidatesOf(related, config.repos),
                needed: resolveBases(labels, related, config.repos).kind === 'judge',
                // 対象ごとの普段の向き先（baseBranch）。null は GitHub の既定ブランチ
                usual: Object.fromEntries(related.map((r) => [r, config.repos[r]?.baseBranch ?? null])),
              },
              learned: learnedFor(store, history, issue.repo, issue.title, labels),
            },
          ]
        })
      const output = {
        issues,
        // tick が AI を起こすかと同じリポジトリの一覧で数える
        reflect: reflectionsOf(
          store,
          history,
          config.sources.map((s) => s.repo),
        ),
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
    // 判定結果は今までの配列か、振り返りの案を添えた { decisions, learn }
    const file = readJson(flags.get('--file') ?? '')
    const body = asObject(file)
    const rows = body ? asArray(body.decisions) : asArray(file)
    const proposals: Json[] | null = body ? (body.learn === undefined ? [] : asArray(body.learn)) : []
    if (!rows || !proposals) {
      console.error('判定結果は JSON の配列か { "decisions": [...], "learn": [...] } にしてください')
      return 1
    }
    // judge-list が見せた様子見の規則と振り返りの材料
    const shown = shownOf(readJson(join(autoDir(name), AUTO_FILES.pending)))
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
      // auto の行だけ、頼った auto 向きの規則を読む。eng の行の rules は使わない
      const ruleIds =
        decision.route === 'auto' ? decisionRuleIds(decision.rules, shown.rules(issue.key, issue.generation)) : []
      if (typeof ruleIds === 'string') {
        console.error(`判定を破棄しました: ${issue.key}（${ruleIds}）`)
        rejected = true
        continue
      }
      const uniqueTargets = [...new Set(targets.filter((t): t is string => typeof t === 'string'))]
      const feature = issue.category === FEATURE_LABEL && !issue.returnedFromEng
      const toEng = decision.route === 'eng' || uniqueTargets.length > 2 || feature
      // 向き先を解くのにも、Backlog から動かすのにも今のラベルを読む
      const current = viewIssue(issue.repo, issue.number)
      if (!current) {
        rejected = true
        continue
      }
      if (current.state === 'CLOSED') {
        onEnd(issue, 'stopped', current.labels)
        delete state.issues[issue.key]
        save()
        continue
      }
      // 向き先のラベルを待っている Issue は judge-list に出ない。同じ判定結果を書き直して再実行しても進めない
      if (
        awaitingBase(
          issue,
          current.labels,
          config.sources.find((s) => s.repo === issue.repo)?.autoReady === true,
          config.repos,
        )
      ) {
        console.error(`向き先のラベルを待っているので飛ばしました: ${issue.key}`)
        continue
      }
      // エンジニアに回す Issue の向き先はエンジニアが決める
      const resolution = toEng ? null : resolveBases(current.labels, uniqueTargets, config.repos)
      if (resolution?.kind === 'judge' && !issue.baseAsked && typeof decision.base !== 'string') {
        console.error(`判定を破棄しました: ${issue.key}（base がありません）`)
        rejected = true
        continue
      }
      issue.targets = uniqueTargets
      issue.limitMinutes = decision.limitMinutes
      issue.reason = decision.reason
      issue.updatedAt = autoNow()
      // AI の向きと、AI の判定に関係なく CLI が eng に回す理由を、この世代の結果と一緒に履歴へ残す
      issue.learn = {
        aiRoute: decision.route === 'eng' ? 'eng' : 'auto',
        forced: feature ? FORCED_FEATURE : uniqueTargets.length > 2 ? FORCED_TARGETS : '',
        ruleIds,
        recorded: false,
      }
      // 判定の間に人が Ready にしたら、人が「やる」と決めた通常の Issue として扱う
      if (issue.autoReady && current.labels.includes(STATUS.ready)) issue.autoReady = false
      // auto-ready の Issue と、向き先を尋ねたあと base ラベルが付いて拾い直した Issue は Backlog から動かす
      const fromBacklog = issue.autoReady || (issue.baseAsked && current.labels.includes(STATUS.backlog))
      const from = fromBacklog ? STATUS.backlog : STATUS.ready
      if (toEng) {
        if (!current.labels.includes(from)) {
          issue.phase = 'stopped'
          onEnd(issue, 'stopped', current.labels)
          save()
          continue
        }
        if (uniqueTargets.length > 2) issue.reason += '（3 つ以上のリポジトリの Issue は自動実行の対象外です）'
        if (feature) issue.reason += '（新機能の Issue はエンジニアが対応します）'
        transition(
          issue,
          'judged',
          {
            reason: issue.reason,
            limitMinutes: issue.limitMinutes,
            relayMinutes: relayAllowance(config.roles, config.everyMinutes),
          },
          from,
          STATUS.readyEng,
          false,
          'eng',
          save,
          onEnd,
        )
        continue
      }
      if (fromBacklog && !current.labels.includes(STATUS.backlog)) {
        issue.phase = 'stopped'
        onEnd(issue, 'stopped', current.labels)
        save()
        continue
      }
      // ラベル → 尋ねたあとの既定 → 判定の流れの順に向き先を決める。同じ世代では二度尋ねない
      const bases =
        resolution?.kind === 'ok'
          ? resolution.bases
          : issue.baseAsked
            ? Object.fromEntries(uniqueTargets.map((t) => [t, config.repos[t]?.baseBranch ?? null]))
            : resolution?.kind === 'judge' && typeof decision.base === 'string' && decision.base !== 'ask'
              ? applyFlow(decision.base, uniqueTargets, config.repos)
              : null
      const candidates = [
        ...new Set([
          ...candidatesOf(uniqueTargets, config.repos),
          ...uniqueTargets.flatMap((t) => config.repos[t]?.baseBranch ?? []),
        ]),
      ]
      // 候補が 2 つ未満なら選びようがないので尋ねず、普段の向き先で進める（resolveBases が先に防ぐが念のため）
      const decided =
        bases ??
        (candidates.length < 2
          ? Object.fromEntries(uniqueTargets.map((t) => [t, config.repos[t]?.baseBranch ?? null]))
          : null)
      if (!decided) {
        const source = config.sources.find((s) => s.repo === issue.repo)
        const fallbackOf = (t: string): string => config.repos[t]?.baseBranch ?? '既定のブランチ'
        const why =
          resolution?.kind === 'ask'
            ? resolution.why
            : typeof decision.base === 'string' && decision.base !== 'ask'
              ? `\`${decision.base}\` は候補にありません`
              : ''
        const input = {
          candidates,
          fallback: fallbackOf(uniqueTargets[0] ?? ''),
          ...(uniqueTargets.length > 1
            ? { fallbacks: uniqueTargets.map((t) => ({ repo: t, branch: fallbackOf(t) })) }
            : {}),
          ...(why ? { why } : {}),
          pick: source?.pick ?? STATUS.ready,
          autoReadySource: source?.autoReady === true,
        }
        // 尋ねた印を先に残す。ラベルの遷移が途中で止まっても、tick が続きをやったあと待ちに入る
        issue.baseAsked = true
        save()
        if (fromBacklog) {
          // Backlog のまま判定した Issue はステータスを変えずにコメントだけ書く。書けなければ次の判定で尋ね直す
          if (!notifyNeedsBase(issue, input, save)) {
            issue.baseAsked = false
            save()
          }
        } else transition(issue, 'needs-base', input, STATUS.ready, STATUS.backlog, false, 'judging', save, onEnd)
        continue
      }
      issue.bases = decided
      if (fromBacklog) {
        // コメント → ラベルの順に Backlog から Ready へ。終わると queued になり、途中で止まれば tick が続きをやる
        transition(
          issue,
          'auto-ready',
          {
            reason: issue.reason,
            limitMinutes: issue.limitMinutes,
            relayMinutes: relayAllowance(config.roles, config.everyMinutes),
            // 人が Ready にした Issue（向き先を尋ねて拾い直したもの）は元から AI が merge しうるので、人の確認待ちとは言わない。
            // 普段の向き先でない向き先（hotfix の main など）へは AI が merge しないので、その場合は人の確認待ちと言う
            autoMerge:
              (!issue.autoReady || sourceAutoMerge(config, issue.repo)) &&
              !Object.entries(decided).some(([r, b]) => b !== null && restrictedBase(r, b, config.repos)),
          },
          STATUS.backlog,
          STATUS.ready,
          false,
          'queued',
          save,
          onEnd,
        )
      } else {
        issue.phase = 'queued'
        save()
      }
    }
    // 見せた食い違いは案が無くても振り返り済みにする。学びが保存できなくても判定の結果は残す
    try {
      applyLearn(name, proposals, shown.reflect, autoNow(), console.error)
    } catch (error) {
      console.error(`判定の学びを保存できません（${error instanceof Error ? error.message : String(error)}）`)
    }
    state.judgingSince = null
    save()
    const sources = pickSources(config)
    syncProjects({
      sources: config.sources.filter((s) => sources.includes(s.repo)),
      state,
      save,
      log: console.log,
      active: intakeActiveRepos(config),
      statuses: new Map(),
      failed: new Set(),
      touched: new Set(),
    })
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
