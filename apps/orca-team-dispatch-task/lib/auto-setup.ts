import { intakeRepoNames, parseAutoConfig, readAutoConfig } from './auto-config.ts'
import { ensureStatusLabels, github } from './auto-github.ts'
import { hostsOf, LOCAL_HOST } from './auto-hosts.ts'
import { AUTO_FILES, autoDir, autoNow } from './auto-paths.ts'
import { AUTO_LOCK_TTL_MS, AUTO_LOCK_WAIT_MS, readState, releaseLock, takeLockWait } from './auto-state.ts'
import { readJson, writeAtomic } from './fs.ts'
import { listIntakeConfigs } from './intake-homes.ts'
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
  SETUP_DRAFT_FILE,
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
  swapWarning,
} from './setup-host.ts'
import { recommendLanes, worktreeCost, worktreesPerIssue } from './setup-lanes.ts'
import {
  addStatusOptions,
  ghHasProjectScope,
  missingStatusOptions,
  PROJECT_STATUS_COLORS,
  readStatusOptions,
} from './setup-project.ts'
import { suggestVerify } from './setup-suggest.ts'
import { runVerifyLocal, VERIFY_SCRIPT_FAILED, verifyRemote } from './setup-verify.ts'
import { STATUS_LABELS } from './status.ts'
import { envCount, run, runNode } from './sys.ts'

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { AutoConfig } from './auto-config.ts'
import type { HostConfig, RepoMeasure } from './auto-hosts.ts'
import type { JsonObject } from './json.ts'
import type { SetupDraft } from './setup-draft.ts'
import type { Prompter } from './setup-prompt.ts'
import type { VerifySuggestion } from './setup-suggest.ts'
import type { VerifyResult } from './setup-verify.ts'

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
// 設定を終えたあとで一部だけ変えるコマンド。保存の段を通るので、差の確認と実行中の Issue の検査は setup と同じ。
// hosts は組の selector が変わると verified を落とす verify の段と、マシンごとの並列数の段まで回す
export type SetupCommand = 'hosts' | 'roles'
const COMMAND_STEPS: Record<SetupCommand, ReadonlyArray<{ id: string; title: string }>> = {
  hosts: [
    { id: 'hosts', title: 'マシン' },
    { id: 'verify', title: 'リポジトリごとの確認' },
    { id: 'lanes', title: '並列数' },
    { id: 'save', title: '設定を保存する' },
  ],
  roles: [
    { id: 'modes', title: 'レビューモード' },
    { id: 'save', title: '設定を保存する' },
  ],
}
const CONFIG_RESOLVE_SCRIPT = 'skills/orca-team-dispatch-task/scripts/config-resolve.ts'
// 向き先の候補として探す名前（既定ブランチに加えて）
const BASE_CANDIDATES = ['develop', 'main', 'master']
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/
export const runSetup = (
  name: string,
  prompter: Prompter,
  out: (text: string) => void,
  command?: SetupCommand,
): number => {
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
  // 一部だけのコマンドは config.json から始め、下書きを読みも書きもしない（途中の setup の下書きを混ぜない・消さない）
  if (command && existsSync(join(autoDir(name), SETUP_DRAFT_FILE))) {
    say(`make setup ${name} が途中です。先に最後まで実行してください`)
    return 1
  }
  if (command && !base) {
    say(`先に make setup ${name} を最後まで実行してください`)
    return 1
  }
  const draft: SetupDraft =
    (command ? null : readDraft(name)) ?? (base ? draftFromConfig(base) : { version: 1, name, done: [], values: {} })
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
    let chosen: string[] = []
    for (;;) {
      const listed = [...new Set([...listIntakeConfigs(homedir()), ...(v.intakeConfigs ?? [])])]
      chosen = []
      if (listed.length) {
        listed.forEach((path, i) => {
          say(`  ${i + 1}. ${path}`)
        })
        const defaults = v.intakeConfigs ?? listed
        chosen = choose(
          'intake の設定ファイルの番号',
          listed.length,
          defaults.map((path) => String(listed.indexOf(path) + 1)).join(','),
          true,
        ).map((index) => listed[index] ?? fail('intake の設定ファイルがありません'))
        const unreadable = chosen.filter((path) => !intakeRepoNames(path)?.length)
        if (unreadable.length) {
          for (const path of unreadable) say(`intake の repos[].name を読めません: ${path}`)
          continue
        }
      }
      for (;;) {
        const path = ask('ほかの intake の設定ファイル（無ければ -）', '-')
        if (path === '-') break
        if (!isAbsolute(path)) {
          say('絶対パスを入力してください')
          continue
        }
        if (!intakeRepoNames(path)?.length) {
          say(`intake の repos[].name を読めません: ${path}`)
          continue
        }
        if (!chosen.includes(path)) chosen.push(path)
      }
      if (chosen.length) break
      say('intake の設定ファイルを 1 つ以上選んでください')
    }
    const available = [...new Set(chosen.flatMap((path) => intakeRepoNames(path) ?? []))]
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
      // auto-ready は Backlog を Ready へ上げるので、Ready を拾う元にだけ意味がある
      const autoReady =
        pick === 'Ready' &&
        yes(
          `${repo} で auto-ready を使いますか（Backlog の Issue を AI が判定し、自動で対応できるものを Ready にする。PR は人が確認してから merge）`,
          old?.autoReady ?? false,
        )
      next.push({ repo, pick, related: old?.related ?? [repo], project: old?.project ?? null, autoReady })
    }
    v.intakeConfigs = chosen
    v.sources = next
  }
  // origin の既定ブランチと develop / main / master のうち在るものを候補にする。2 つ以上のときだけ尋ねる
  const pickBases = (
    repo: string,
    previous: AutoConfig['repos'][string] | undefined,
  ): Pick<AutoConfig['repos'][string], 'baseBranch' | 'branches'> => {
    const kept = { baseBranch: previous?.baseBranch ?? null, branches: previous?.branches ?? [] }
    const listed = github(['api', '--paginate', '--jq', '.[].name', `repos/${repo}/branches`])
    if (listed.rc !== 0) return kept
    const existing = listed.stdout.split('\n').map((line) => line.trim())
    const defaultBranch = asString(
      get(parseJson(github(['repo', 'view', '--json', 'defaultBranchRef', repo]).stdout), 'defaultBranchRef', 'name'),
    )
    const found = [...new Set([defaultBranch, ...BASE_CANDIDATES])].filter(
      (name): name is string => !!name && existing.includes(name),
    )
    if (found.length < 2) return kept
    const usual = found.includes('develop') ? 'develop' : (defaultBranch ?? found[0] ?? '')
    for (;;) {
      const baseBranch = ask(
        `${repo} の普段の向き先ブランチ（PR の向き先と AI が merge してよい先）`,
        previous?.baseBranch ?? usual,
      ).trim()
      const branches = ask(
        `${repo} の向き先の候補（カンマ区切り）`,
        (previous?.branches.length ? previous.branches : found).join(','),
      )
        .split(',')
        .map((name) => name.trim())
      if (!baseBranch || branches.some((name) => !name)) say('ブランチ名を空にはできません')
      else if (new Set(branches).size !== branches.length) say('候補に重複があります')
      else if (!branches.includes(baseBranch)) say('普段の向き先は候補に含めてください')
      else return { baseBranch, branches }
    }
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
        ...pickBases(repo, previous),
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
            measure: old?.repos[repo]?.measure ?? null,
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
            host.repos[repo] = {
              selector,
              verified: old?.repos[repo]?.verified ?? false,
              measure: old?.repos[repo]?.measure ?? null,
            }
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
    const judge =
      (base ?? parseAutoConfig({ version: 1, name, repos: {}, sources: [] }, name))?.judge ??
      fail('判定の設定を読めません')
    const listed = new Map<string, ReturnType<typeof listRemoteRepos>>()
    const measureOf = (result: VerifyResult): RepoMeasure | null =>
      result.ok && result.peakMemoryMb !== null
        ? { peakMemoryMb: result.peakMemoryMb, diskGrowthMb: result.diskGrowthMb ?? 0, measuredAt: autoNow() }
        : null
    const report = (where: string, result: VerifyResult) => {
      if (result.ok) {
        const memory = result.peakMemoryMb === null ? '最大メモリ 不明' : `最大メモリ ${result.peakMemoryMb} MB`
        const disk = result.diskGrowthMb === null ? 'ディスク 不明' : `ディスク +${result.diskGrowthMb} MB`
        say(`${where}: 通りました（${memory}、${disk}）`)
      } else {
        say(`${where}: ${result.failed ?? '確認'} が失敗しました`)
        if (result.failed === VERIFY_SCRIPT_FAILED && result.tmpPath)
          say(`一時ディレクトリが残っていれば消してください: ${result.tmpPath}`)
      }
      if (result.missingTools.length) say(`${where}: 足りない道具: ${result.missingTools.join(', ')}`)
    }
    for (const [repo, r] of Object.entries(repos())) {
      const previous = base?.repos[repo]
      let suggestion: VerifySuggestion | null = null
      if (yes(`${repo} の確認コマンドを AI に割り出させますか`, r.verify.length === 0)) {
        say('AI に割り出させています…')
        const result = suggestVerify(r.checkout, judge)
        if ('error' in result) say(`AI の案を作れませんでした: ${result.error}`)
        else {
          suggestion = result
          say(`AI の案: ${result.commands.join(' / ') || 'なし'}`)
          say(`必要な道具: ${result.tools.join(', ') || 'なし'}`)
          if (result.notes) say(`メモ: ${result.notes}`)
        }
      }
      const defaultsCommands = suggestion?.commands.length ? suggestion.commands : r.verify
      const commands: string[] = []
      for (let i = 0; ; i++) {
        const command = ask(`${repo} の確認コマンド ${i + 1}（終わりは -）`, defaultsCommands[i] ?? '-')
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
      const remote: Array<{ host: HostConfig; pair: HostConfig['repos'][string]; keep: boolean }> = []
      for (const host of v.hosts ?? []) {
        const pair = host.repos[repo]
        if (!pair) continue
        const old = oldHosts.find((h) => h.id === host.id)?.repos[repo]
        const unchanged = sameCommands && old?.selector === pair.selector && (host.id !== LOCAL_HOST || sameRepo)
        pair.verified = unchanged ? (old?.verified ?? false) : false
        pair.measure = unchanged ? (old?.measure ?? null) : null
        if (host.id === LOCAL_HOST) localUnchanged = unchanged
        else remote.push({ host, pair, keep: unchanged && old?.verified === true })
      }
      const localHost = v.hosts?.find((h) => h.id === LOCAL_HOST)
      const local = localHost?.repos[repo]
      if (
        (!v.hosts || local) &&
        commands.length &&
        yes(`${repo} の確認コマンドをこのマシンで走らせて確かめますか`, !localUnchanged)
      ) {
        const result = runVerifyLocal(r.checkout, commands, suggestion?.tools ?? [])
        r.verified = result.ok
        if (local) {
          local.verified = result.ok
          local.measure = measureOf(result)
        }
        report(localHost?.name ?? 'このマシン', result)
      }
      for (const { host, pair, keep } of remote) {
        if (!commands.length || !yes(`${repo} を ${host.name} で走らせて確かめますか`, !keep)) continue
        pair.verified = false
        pair.measure = null
        if (!listed.has(host.id)) listed.set(host.id, listRemoteRepos(host.id))
        const row = listed.get(host.id)?.find((r) => `id:${r.id}` === pair.selector)
        if (!row) {
          say(`${host.name}: ${repo} の置き場所を Orca の一覧から読めないため確かめられませんでした`)
          continue
        }
        const result = verifyRemote(host.id, `path:${row.path}`, commands, suggestion?.tools ?? [], (m) =>
          say(`${host.name} で確認中（${m} 分）`),
        )
        if (result.result) {
          pair.verified = result.result.ok
          pair.measure = measureOf(result.result)
          report(host.name, result.result)
        } else if (result.timedOut) {
          say(`${host.name}: 時間内に終わりませんでした`)
          if (result.tmpPath) say(`一時ディレクトリが残っていれば消してください: ${result.tmpPath}`)
        } else say(`${host.name}: 確認の端末を作れませんでした`)
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
      const cost = worktreeCost(Object.values(host.repos).map((p) => p.measure))
      if (host.spec) {
        say(
          `${host.name}: 推奨 ${recommendLanes(host.spec, cost)}（メモリ ${host.spec.memoryTotalMb} MB、ディスク ${host.spec.diskFreeMb} MB、CPU ${host.spec.cpus}）`,
        )
        say(
          `  1 worktree: メモリ ${cost.memoryMb} MB・ディスク ${cost.diskMb} MB（${cost.source === 'measured' ? '測った値' : '既定値'}）`,
        )
      }
      const old = base?.hosts?.find((h) => h.id === host.id)
      host.lanes = number(
        `${host.name} の並列数`,
        old?.lanes ??
          (base?.hosts === null && host.id === LOCAL_HOST
            ? base.lanes
            : host.spec
              ? recommendLanes(host.spec, cost)
              : 1),
        valid,
      )
    }
  }
  const modes = () => {
    const defaults =
      v.roles ??
      asObject(parseJson(runNode(join(pluginRoot(), CONFIG_RESOLVE_SCRIPT), ['--project-root', autoDir(name)]).stdout))
    const toggle = (key: 'review_mode' | 'phase_b'): 'on' | 'off' => {
      for (;;) {
        const value = ask(key, defaults?.[key] === 'on' ? 'on' : 'off')
        if (value === 'on' || value === 'off') return value
        say('on または off を入力してください')
      }
    }
    v.roles = { review_mode: toggle('review_mode'), phase_b: toggle('phase_b') }
  }
  const roles = () => {
    modes()
    v.everyMinutes = number('判定の間隔（分）', v.everyMinutes ?? 5, isAllowedEvery)
  }
  const save = () => {
    const next = configJsonFromDraft(draft, asObject(readJson(configFile))) ?? fail('下書きから有効な設定を作れません')
    const parsed = parseAutoConfig(next, name)
    const previous = readAutoConfig(name)
    if (isDeepStrictEqual(parsed, previous)) {
      if (!Object.hasOwn(asObject(readJson(configFile)) ?? {}, 'intakeConfig')) {
        say('変わる所はありません')
        return
      }
      lock(() => {
        const raw =
          asObject(readJson(configFile)) ??
          fail('config.json が setup の途中で変わりました。make setup をやり直してください')
        const latest = parseAutoConfig(raw, name)
        if (!latest || !isDeepStrictEqual(latest, previous))
          fail('config.json が setup の途中で変わりました。make setup をやり直してください')
        if (raw.intakeConfig === undefined) {
          say('変わる所はありません')
          return
        }
        const migrated: JsonObject = {}
        for (const [key, value] of Object.entries(raw))
          migrated[key === 'intakeConfig' ? 'intakeConfigs' : key] = key === 'intakeConfig' ? [value] : value
        if (!isDeepStrictEqual(parseAutoConfig(migrated, name), previous)) fail('設定を書けません')
        const conflicts = inUseConflicts(readState(name), migrated)
        if (conflicts.length) {
          conflicts.forEach(say)
          fail('その Issue が終わってからやり直してください')
        }
        say('変わる所はありません（古い intakeConfig を intakeConfigs に書き換えます）')
        if (!writeAtomic(configFile, `${JSON.stringify(migrated, null, 2)}\n`) || !readAutoConfig(name))
          fail('設定を書けません')
      })
      return
    }
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
    modes: () => {
      modes()
      const r = v.roles ?? fail('レビューモードがありません')
      say(`1 件が使う worktree: 対象1つ=${worktreesPerIssue(r, 1)}、対象2つ=${worktreesPerIssue(r, 2)}`)
    },
    save,
    automation,
    enable,
  }
  try {
    if (command) {
      const steps = COMMAND_STEPS[command]
      for (const [index, step] of steps.entries()) {
        say(`[${index + 1}/${steps.length}] ${step.title}`)
        actions[step.id]?.()
      }
      say(`config=${configFile}`)
      return 0
    }
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
