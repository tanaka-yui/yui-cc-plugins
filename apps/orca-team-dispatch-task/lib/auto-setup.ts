import { parseAutoConfig, readAutoConfig } from './auto-config.ts'
import { ensureStatusLabels, github } from './auto-github.ts'
import { hostsOf, LOCAL_HOST } from './auto-hosts.ts'
import { AUTO_FILES, autoDir, autoNow } from './auto-paths.ts'
import { AUTO_LOCK_TTL_MS, AUTO_LOCK_WAIT_MS, readState, releaseLock, takeLockWait } from './auto-state.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { orcaBin, receiptArray, receiptOk, runOrca } from './orca.ts'
import {
  applyJudgeRules,
  automationName,
  createAutomationArgs,
  editAutomationArgs,
  enableAutomationArgs,
  installLauncher,
  isAllowedEvery,
  judgeFingerprint,
  judgeRules,
  judgeRulesProblems,
  launcherPaths,
  pluginRoot,
  registerWorkspace,
} from './setup-automation.ts'
import {
  configJsonFromDraft,
  draftFromConfig,
  inUseConflicts,
  readDraft,
  removeDraft,
  writeDraft,
} from './setup-draft.ts'
import {
  addRepo,
  checkoutProblem,
  checkRemoteRepo,
  hostReachable,
  listHostChoices,
  listRemoteRepos,
  measureLocal,
  probeRemote,
  repoDefaults,
  runVerifyLocal,
  swapWarning,
} from './setup-host.ts'
import { recommendLanes, worktreesPerIssue } from './setup-lanes.ts'
import {
  addStatusOptions,
  ghHasProjectScope,
  missingStatusOptions,
  PROJECT_STATUS_COLORS,
  readStatusOptions,
} from './setup-project.ts'
import { STATUS_LABELS } from './status.ts'
import { envCount, run, runNode } from './sys.ts'

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { AutoConfig } from './auto-config.ts'
import type { HostConfig } from './auto-hosts.ts'
import type { SetupDraft } from './setup-draft.ts'
import type { Prompter } from './setup-prompt.ts'

export const SETUP_STEPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'prereq', title: '前提の確認' },
  { id: 'sources', title: '拾う元' },
  { id: 'repos', title: '関連リポジトリ' },
  { id: 'project', title: 'Project' },
  { id: 'labels', title: 'ステータスラベル' },
  { id: 'hosts', title: 'マシン' },
  { id: 'verify', title: 'リポジトリごとの確認' },
  { id: 'lanes', title: '並列数' },
  { id: 'roles', title: 'レビューモードと間隔' },
  { id: 'save', title: '設定を保存する' },
  { id: 'automation', title: 'automation の登録' },
  { id: 'enable', title: '有効化' },
]
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/
export const runSetup = (name: string, prompter: Prompter, out: (text: string) => void): number => {
  const noInput = new Error('入力が尽きました')
  const say = (text: string): void => {
    out(`${text}\n`)
  }
  const fail = (text: string): never => {
    throw new Error(text)
  }
  const ask = (question: string, fallback?: string): string => {
    const value = prompter.ask(question, fallback)
    if (value === null) throw noInput
    return value
  }
  const confirm = (question: string): boolean => {
    const value = prompter.confirm(question)
    if (value === null) throw noInput
    return value
  }
  const yes = (question: string, fallback: boolean): boolean => {
    for (;;) {
      const value = ask(question, fallback ? 'y' : 'n').toLowerCase()
      if (['y', 'yes', 'n', 'no'].includes(value)) return value === 'y' || value === 'yes'
      say('y または n を入力してください')
    }
  }
  const number = (question: string, fallback: number, valid: (n: number) => boolean): number => {
    for (;;) {
      const value = Number(ask(question, String(fallback)))
      if (valid(value)) return value
      say('有効な整数を入力してください')
    }
  }
  const choose = (question: string, count: number, fallback: string, none = false): number[] => {
    for (;;) {
      const value = ask(question, fallback).replaceAll(' ', '')
      if (none && value === '-') return []
      const values = value.split(',').map(Number)
      if (
        value &&
        values.length &&
        new Set(values).size === values.length &&
        values.every((n) => Number.isInteger(n) && n >= 1 && n <= count)
      )
        return values.map((n) => n - 1)
      say('一覧の番号を重複せずカンマ区切りで入力してください')
    }
  }
  const base = readAutoConfig(name)
  const draft: SetupDraft =
    readDraft(name) ?? (base ? draftFromConfig(base) : { version: 1, name, done: [], values: {} })
  const v = draft.values
  const configFile = join(autoDir(name), AUTO_FILES.config)
  const repos = () => v.repos ?? fail('関連リポジトリがありません')
  const sources = () => v.sources ?? fail('拾う元がありません')
  const lock = <T>(action: () => T): T => {
    while (!takeLockWait(name, AUTO_LOCK_TTL_MS, envCount('ORCA_AUTO_LOCK_WAIT_MS', AUTO_LOCK_WAIT_MS))) {
      if (!confirm('tick が動いています。もう一度待ちますか')) fail('tick の終了を待ってやり直してください')
    }
    try {
      return action()
    } finally {
      releaseLock(name)
    }
  }
  const current = (): AutoConfig => readAutoConfig(name) ?? fail('設定を読めません')
  const updateAutomation = (automation: NonNullable<AutoConfig['automation']>): void => {
    lock(() => {
      const raw = asObject(readJson(configFile)) ?? fail('設定を読めません')
      if (!writeAtomic(configFile, `${JSON.stringify({ ...raw, automation }, null, 2)}\n`) || !readAutoConfig(name))
        fail('automation の設定を書けません')
    })
    v.automation = automation
  }
  const prereq = () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 18)) fail('node 22.18 以上が必要です')
    if (run('git', ['--version']).rc !== 0) fail('git がありません')
    const auth = github(['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
    const account = asArray(get(parseJson(auth.stdout), 'hosts', 'github.com'))?.find(
      (row) => get(row, 'active') === true,
    )
    if (auth.rc !== 0 || get(account, 'state') !== 'success') fail('gh auth login を実行してください')
    if (!hostReachable(LOCAL_HOST)) fail(`orca に接続できません: ${orcaBin()}`)
  }
  const pickSources = () => {
    let available: string[] = []
    let path = v.intakeConfig ?? join(homedir(), '.slack-issue-intake/config.json')
    for (;;) {
      path = ask('intake の設定ファイル', path)
      available =
        asArray(get(readJson(path), 'repos'))?.flatMap((row) => {
          const repo = asString(get(row, 'name'))
          return repo && REPO_PATTERN.test(repo) ? [repo] : []
        }) ?? []
      if (available.length) break
      say('intake の repos[].name を読めません')
    }
    for (const source of v.sources ?? [])
      if (!available.includes(source.repo)) say(`${source.repo} は intake に無いため選べません`)
    available.forEach((repo, i) => {
      say(`  ${i + 1}. ${repo}`)
    })
    const selected =
      v.sources?.flatMap((source) => {
        const index = available.indexOf(source.repo)
        return index >= 0 ? [String(index + 1)] : []
      }) ?? []
    const indices = choose('拾う元の番号', available.length, selected.join(',') || '1')
    const next: AutoConfig['sources'] = []
    for (const index of indices) {
      const repo = available[index] ?? fail('拾う元がありません')
      const old = v.sources?.find((s) => s.repo === repo)
      let pick: string
      do {
        pick = ask(`${repo} の拾う条件`, old?.pick ?? 'Ready')
      } while (!pick)
      next.push({ repo, pick, related: old?.related ?? [repo], project: old?.project ?? null })
    }
    v.intakeConfig = path
    v.sources = next
  }
  const pickRepos = () => {
    for (const source of sources()) {
      for (;;) {
        const names = ask(`${source.repo} の関連リポジトリ`, source.related.join(','))
          .split(',')
          .map((s) => s.trim())
        if (names.length && names.every((r) => REPO_PATTERN.test(r))) {
          source.related = [...new Set(names)]
          break
        }
        say('owner/name をカンマ区切りで入力してください')
      }
    }
    const next: AutoConfig['repos'] = {}
    for (const repo of new Set(sources().flatMap((source) => source.related))) {
      const previous = v.repos?.[repo]
      let checkout: string
      for (;;) {
        checkout = ask(`${repo} のこのマシンの checkout`, previous?.checkout)
        const problem = checkoutProblem(repo, checkout)
        if (!problem) break
        say(problem)
      }
      next[repo] = {
        checkout,
        verify: previous?.verify ?? [],
        infra: previous?.infra ?? false,
        verified: previous?.verified ?? false,
        ci: previous?.ci ?? repoDefaults(checkout).ci,
      }
    }
    v.repos = next
  }
  const pickProject = () => {
    for (const source of sources()) {
      for (;;) {
        const answer = ask(
          `${source.repo} の Project（owner/番号、使わないなら -）`,
          source.project ? `${source.project.owner}/${source.project.number}` : '-',
        )
        if (answer === '-') {
          source.project = null
          break
        }
        const match = answer.match(/^([^/\s]+)\/([1-9]\d*)$/)
        if (!match?.[1] || !match[2]) {
          say('owner/番号 または - を入力してください')
          continue
        }
        const ref = { owner: match[1], number: Number(match[2]) }
        source.project = null
        if (ghHasProjectScope() !== true) {
          say('gh auth refresh -h github.com -s project を実行してからやり直してください')
          break
        }
        const options = readStatusOptions(ref)
        if ('error' in options) {
          say(options.error)
          break
        }
        const missing = missingStatusOptions(options)
        if (missing.length) {
          for (const label of STATUS_LABELS.filter((l) => missing.includes(l.name)))
            say(`  ${label.name}: ${PROJECT_STATUS_COLORS[label.name]} / ${label.description}`)
          if (!confirm('この Status の選択肢を足しますか') || !addStatusOptions(options, missing)) break
        }
        source.project = ref
        break
      }
    }
    if (sources().some((s) => s.project))
      say('GitHub の組み込みの Project workflow（Todo・Done への自動移動など）を止めてください')
  }
  const pickHosts = () => {
    if (base?.hosts === null && !v.hosts && !confirm('マシンの構成を変えますか')) {
      for (const repo of Object.values(repos()))
        if (!addRepo(LOCAL_HOST, repo.checkout)) fail('このマシンのリポジトリを登録できません')
      return
    }
    const choices = listHostChoices() ?? fail('マシンの一覧を読めません')
    for (const host of v.hosts ?? [])
      if (!choices.some((choice) => choice.id === host.id)) say(`${host.name} は Orca の一覧に無いため選べません`)
    choices.forEach((host, i) => {
      say(`  ${i + 1}. ${host.name}`)
    })
    const previous = v.hosts
    const defaults = previous
      ? previous.flatMap((host) => {
          const index = choices.findIndex((choice) => choice.id === host.id)
          return index >= 0 ? [String(index + 1)] : []
        })
      : choices.flatMap((host, i) => (host.id === LOCAL_HOST ? [String(i + 1)] : []))
    const selected = choose('使うマシンの番号', choices.length, defaults.join(',') || '1')
    const next: HostConfig[] = []
    const names = Object.keys(repos())
    for (const index of selected) {
      const choice = choices[index] ?? fail('マシンがありません')
      const old = previous?.find((host) => host.id === choice.id)
      const name = old?.name ?? choice.name
      if (!hostReachable(choice.id)) {
        if (confirm(`${name} に接続できません。このマシンを外しますか`)) continue
        fail(`${name} に接続してからやり直してください`)
      }
      const host: HostConfig = {
        id: choice.id,
        name,
        lanes: old?.lanes ?? (base?.hosts === null && choice.id === LOCAL_HOST ? base.lanes : 1),
        orcaBin: old?.orcaBin ?? orcaBin(),
        repos: {},
        spec: old?.spec ?? null,
      }
      let measured = false,
        platform = process.platform as string
      if (choice.id === LOCAL_HOST) {
        names.forEach((repo, i) => {
          say(`  ${i + 1}. ${repo}`)
        })
        const defaultRepos = names.flatMap((repo, i) =>
          !old || old.repos[repo] || !base?.repos[repo] ? [String(i + 1)] : [],
        )
        const indices = choose(`${name} で扱うリポジトリの番号`, names.length, defaultRepos.join(',') || '-', true)
        for (const i of indices) {
          const repo = names[i] ?? fail('リポジトリがありません'),
            r = repos()[repo] ?? fail('リポジトリがありません')
          if (!addRepo(LOCAL_HOST, r.checkout)) fail(`${repo} を登録できません`)
          const unchanged = base?.repos[repo]?.checkout === r.checkout
          host.repos[repo] = {
            selector: unchanged && old?.repos[repo] ? old.repos[repo].selector : `path:${r.checkout}`,
            verified:
              old?.repos[repo]?.verified ??
              (base?.hosts === null && unchanged ? (base.repos[repo]?.verified ?? false) : false),
          }
        }
        measured = !old || confirm(`${name} のスペックを測り直しますか`)
        if (measured) host.spec = measureLocal(autoNow())
      } else {
        const listed = listRemoteRepos(choice.id)
        if (!listed) {
          if (confirm(`${name} のリポジトリの一覧を読めません。このマシンを外しますか`)) continue
          return fail('リポジトリの一覧を読めません')
        }
        const paths = new Map<string, string>()
        for (const repo of names) {
          const candidates = listed.filter((r) => r.repo?.toLowerCase() === repo.toLowerCase())
          candidates.forEach((r, i) => {
            say(`  ${i + 1}. ${r.path} (${r.id})`)
          })
          let fallback = old?.repos[repo]?.selector ?? (candidates.length === 1 ? '1' : '-')
          for (;;) {
            const answer = ask(`${name} の ${repo} の checkout（番号・絶対パス・セレクタ・-）`, fallback)
            if (answer === '-') break
            let selector: string | null = null,
              path: string | null = null
            if (answer.startsWith('id:')) {
              const row = listed.find((r) => `id:${r.id}` === answer)
              if (row) {
                selector = answer
                path = row.path
              } else {
                say(`${answer} は一覧にありません`)
                fallback = '-'
                continue
              }
            } else if (/^[1-9]\d*$/.test(answer)) {
              const row = candidates[Number(answer) - 1]
              if (row) {
                selector = `id:${row.id}`
                path = row.path
              }
            } else if (isAbsolute(answer)) {
              selector = addRepo(choice.id, answer)
              path = answer
              if (selector) {
                const identity = checkRemoteRepo(choice.id, selector, repo)
                if (identity === 'mismatch') {
                  say(`${answer} の origin は ${repo} ではありません`)
                  continue
                }
                if (
                  identity === 'unknown' &&
                  !confirm(`${answer} の origin を確かめられません。${repo} の checkout として使いますか`)
                )
                  continue
              }
            }
            if (!selector || !path) {
              say('checkout を一覧の番号か絶対パスで入力してください')
              continue
            }
            host.repos[repo] = { selector, verified: old?.repos[repo]?.verified ?? false }
            paths.set(selector, path)
            break
          }
        }
        const first = Object.values(host.repos)[0]
        if (!first) {
          say(`${name} は扱うリポジトリが無いため外します`)
          continue
        }
        measured = !old || confirm(`${name} のスペックを測り直しますか`)
        const probe = measured ? probeRemote(choice.id, `path:${paths.get(first.selector)}`, autoNow()) : null
        if (probe) {
          host.spec = probe.spec
          platform = probe.platform ?? ''
          if (!probe.spec) say(`${name} のスペックを測れませんでした。並列数を直接入力してください`)
        }
        host.orcaBin = ask(`${name} の orca の場所`, probe?.orcaBin ?? old?.orcaBin ?? 'orca')
        if (!host.orcaBin) fail('orca の場所が空です')
        if (probe?.ghAuthOk === false) {
          if (confirm(`${name} で gh の認証が通りません。このマシンを外しますか`)) continue
          fail(`${name} で gh auth login を実行してください`)
        }
        if (
          probe &&
          probe.ghAuthOk === null &&
          !confirm(`${name} で gh の認証を確かめられませんでした。このまま使いますか`)
        )
          continue
      }
      if (measured && host.spec && swapWarning(host.spec, platform))
        say(`${name} は swap が 0 です。メモリ不足に注意してください`)
      next.push(host)
    }
    if (!next.length) fail('使うマシンがありません')
    v.hosts = next
  }
  const verify = () => {
    const oldHosts = base ? hostsOf(base) : []
    for (const [repo, r] of Object.entries(repos())) {
      const previous = base?.repos[repo]
      const commands: string[] = []
      for (let i = 0; ; i++) {
        const command = ask(`${repo} の確認コマンド ${i + 1}（終わりは -）`, r.verify[i] ?? '-')
        if (command === '-') break
        if (command) commands.push(command)
      }
      r.verify = commands
      const defaults = repoDefaults(r.checkout)
      r.infra = yes(`${repo} はインフラですか`, previous?.infra ?? defaults.infra)
      r.ci = yes(`${repo} に CI がありますか`, previous?.ci ?? defaults.ci)
      const sameCommands = previous !== undefined && isDeepStrictEqual(previous.verify, commands)
      const sameRepo = sameCommands && previous?.checkout === r.checkout
      r.verified = sameRepo ? (previous?.verified ?? false) : false
      let localUnchanged = v.hosts ? false : sameRepo
      for (const host of v.hosts ?? []) {
        const pair = host.repos[repo]
        if (!pair) continue
        const old = oldHosts.find((h) => h.id === host.id)?.repos[repo]
        const unchanged = sameCommands && old?.selector === pair.selector && (host.id !== LOCAL_HOST || sameRepo)
        pair.verified = unchanged ? (old?.verified ?? false) : false
        if (host.id === LOCAL_HOST) localUnchanged = unchanged
      }
      const local = v.hosts?.find((h) => h.id === LOCAL_HOST)?.repos[repo]
      if (
        (!v.hosts || local) &&
        commands.length &&
        yes(`${repo} の確認コマンドをこのマシンで走らせて確かめますか`, !localUnchanged)
      ) {
        const result = runVerifyLocal(r.checkout, commands)
        r.verified = result.ok
        if (local) local.verified = result.ok
        if (!result.ok) say(`${result.failed} が失敗しました`)
      }
    }
  }
  const lanes = () => {
    say('並列数は worktree の数で数える（1 件が使う数）')
    for (const review_mode of ['off', 'on'] as const)
      for (const phase_b of ['off', 'on'] as const)
        say(
          `  ${review_mode}/${phase_b}: 対象1つ=${worktreesPerIssue({ review_mode, phase_b }, 1)}、対象2つ=${worktreesPerIssue({ review_mode, phase_b }, 2)}`,
        )
    const valid = (n: number) => Number.isInteger(n) && n >= 1
    if (!v.hosts) {
      v.lanes = number('全体の並列数', v.lanes ?? base?.lanes ?? 1, valid)
      return
    }
    for (const host of v.hosts) {
      if (host.spec)
        say(
          `${host.name}: 推奨 ${recommendLanes(host.spec)}（メモリ ${host.spec.memoryTotalMb} MB、ディスク ${host.spec.diskFreeMb} MB、CPU ${host.spec.cpus}）`,
        )
      const old = base?.hosts?.find((h) => h.id === host.id)
      host.lanes = number(
        `${host.name} の並列数`,
        old?.lanes ??
          (base?.hosts === null && host.id === LOCAL_HOST ? base.lanes : host.spec ? recommendLanes(host.spec) : 1),
        valid,
      )
    }
  }
  const roles = () => {
    const defaults =
      v.roles ??
      asObject(
        parseJson(runNode(join(pluginRoot(), 'bin/config-resolve.ts'), ['--project-root', autoDir(name)]).stdout),
      )
    const toggle = (key: 'review_mode' | 'phase_b'): 'on' | 'off' => {
      for (;;) {
        const value = ask(key, defaults?.[key] === 'on' ? 'on' : 'off')
        if (value === 'on' || value === 'off') return value
        say('on または off を入力してください')
      }
    }
    v.roles = { review_mode: toggle('review_mode'), phase_b: toggle('phase_b') }
    v.everyMinutes = number('判定の間隔（分）', v.everyMinutes ?? 5, isAllowedEvery)
  }
  const save = () => {
    const next = configJsonFromDraft(draft, asObject(readJson(configFile))) ?? fail('下書きから有効な設定を作れません')
    const parsed = parseAutoConfig(next, name)
    if (isDeepStrictEqual(parsed, readAutoConfig(name))) {
      say('変わる所はありません')
      return
    }
    const previous = readAutoConfig(name)
    if (!previous) say(JSON.stringify(next, null, 2))
    else
      for (const key of Object.keys(parsed ?? {}) as Array<keyof AutoConfig>)
        if (!isDeepStrictEqual(previous[key], parsed?.[key]))
          say(`${key}: ${JSON.stringify(previous[key])} → ${JSON.stringify(parsed?.[key])}`)
    if (!confirm('この内容で config.json を書きますか')) fail('設定は保存していません')
    lock(() => {
      const conflicts = inUseConflicts(readState(name), next)
      if (conflicts.length) {
        conflicts.forEach(say)
        fail('その Issue が終わってからやり直してください')
      }
      if (!writeAtomic(configFile, `${JSON.stringify(next, null, 2)}\n`) || !readAutoConfig(name))
        fail('設定を書けません')
    })
  }
  const automation = () => {
    if (!installLauncher() || !registerWorkspace(name)) fail('ランチャーまたは作業場所を登録できません')
    const config = current(),
      launcher = launcherPaths().launcher
    let id = v.automation?.id ?? config.automation?.id ?? null
    const edit = (id: string) => receiptOk(runOrca(editAutomationArgs(id, config, launcher, autoDir(name))))
    const list = () =>
      receiptArray(runOrca(['automations', 'list', '--json']), 'automations') ?? fail('automation の一覧を読めません')
    if (id && !edit(id)) {
      if (list().some((a) => get(a, 'id') === id)) fail('automation を更新できません')
      id = null
    }
    v.automationCreated = false
    if (!id) {
      const found = list().find((a) => get(a, 'name') === automationName(name))
      const foundId = asString(get(found, 'id'))
      if (foundId) {
        if (!confirm(`automation ${automationName(name)}（id ${foundId}）がすでにあります。書き換えて使いますか`))
          fail('automation は変えていません')
        if (!edit(foundId)) fail('automation を更新できません')
        id = foundId
      } else {
        const created = runOrca(createAutomationArgs(config, launcher, autoDir(name)))
        id = receiptOk(created) ? asString(get(created.json, 'result', 'automation', 'id')) : null
        if (!id) fail('automation を作れません')
        v.automationCreated = true
      }
    }
    updateAutomation({
      id: id ?? fail('automation の id がありません'),
      acceptedFingerprint: config.automation?.id === id ? config.automation.acceptedFingerprint : null,
    })
  }
  let enabled = false
  const enable = () => {
    const config = current(),
      launcher = launcherPaths().launcher,
      rules = judgeRules(config, launcher)
    const automation = config.automation ?? fail('automation がありません')
    const approved =
      automation.acceptedFingerprint &&
      !judgeRulesProblems(config, launcher).length &&
      judgeFingerprint(config) === automation.acceptedFingerprint
    if (approved) say('判定の権限は承認済みです')
    else {
      say(JSON.stringify(rules, null, 2))
      if (!confirm('この権限を書いて automation を有効にしますか')) return
      if (!applyJudgeRules(rules)) fail('判定の権限を書けません')
      const problems = judgeRulesProblems(config, launcher)
      if (problems.length) {
        problems.forEach(say)
        fail('これらを直してから make setup をやり直してください')
      }
      const fingerprint = judgeFingerprint(config) ?? fail('判定の権限の指紋を読めません')
      updateAutomation({ id: automation.id, acceptedFingerprint: fingerprint })
    }
    if (!receiptOk(runOrca(enableAutomationArgs(automation.id)))) fail('automation を有効にできません')
    enabled = true
  }
  const actions: Record<string, () => void> = {
    prereq,
    sources: pickSources,
    repos: pickRepos,
    project: pickProject,
    labels: () => {
      for (const source of sources())
        if (!ensureStatusLabels(source.repo)) fail(`${source.repo} のラベルを揃えられません`)
    },
    hosts: pickHosts,
    verify,
    lanes,
    roles,
    save,
    automation,
    enable,
  }
  try {
    for (const [index, step] of SETUP_STEPS.entries()) {
      const done = draft.done.includes(step.id)
      say(`[${index + 1}/${SETUP_STEPS.length}] ${step.title}${done ? ' … 済み' : ''}`)
      if (done) continue
      actions[step.id]?.()
      draft.done.push(step.id)
      writeDraft(draft)
    }
    say(`config=${configFile}\nautomation=${v.automation?.id}\nlauncher=${launcherPaths().launcher}`)
    for (const source of sources().filter((s) => !s.project))
      say(
        `${source.repo}: Project は登録していません。必要なら gh auth refresh -h github.com -s project のあと make setup をやり直してください`,
      )
    say(
      enabled
        ? 'automation を有効にしました'
        : v.automationCreated
          ? 'automation は無効のままです。make setup をやり直すと有効化の段まで進みます'
          : 'automation の有効・無効は変えていません。権限が承認と違う（または未承認の）間は、ランチャー経由の tick が判定を始めません。make setup をやり直して承認してください',
    )
    removeDraft(name)
    return 0
  } catch (error) {
    if (error === noInput) return 2
    say(error instanceof Error ? error.message : String(error))
    return 1
  }
}
