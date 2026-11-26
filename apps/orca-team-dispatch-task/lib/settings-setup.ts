// make setup（普段の設定）。worker のモデル・取りかかり方などの既定・--auto の判定役のモデル・worktree を作る場所を
// 対話で設定し直す。--auto の 12 段は make auto-setup（lib/auto-setup.ts）。
//
// ★ global 層は config-edit.ts を 1 回だけ呼んで書く（検証・原子的な書き込み・未知キーの保持をそのまま使う）。
// ★ 判定役は tick と同じロックの中で config.json を読み直し、judge だけを置き換える。auto-setup の途中（setup.json）は触らない
//   （auto-setup の保存の段は始めに読んだ config.json と比べて止まるので、壊れはしないがやり直しになる）。
// ★ 作業場所は Orca の project setup の worktreeBasePath。Orca が worktree を作るので、プラグインは場所を持たない。
import { parseAutoConfig, readAutoConfig } from './auto-config.ts'
import { AUTO_FILES, autoDir } from './auto-paths.ts'
import { AUTO_LOCK_TTL_MS, AUTO_LOCK_WAIT_MS, releaseLock, takeLockWait } from './auto-state.ts'
import {
  ALL_ROLES,
  DEFAULT_TUPLES,
  EFFORT_CHOICES,
  globalConfigFile,
  knownAgent,
  MODEL_CHOICES,
  modelAgent,
  normalizeEffort,
  projectConfigFile,
  TOGGLE_KEYS,
  TOGGLES,
  type Toggle,
  validAgent,
  validEffort,
  validModel,
  validShellValue,
  validToggle,
} from './config.ts'
import { readJson, writeAtomic } from './fs.ts'
import { asObject, asString, get, type JsonObject } from './json.ts'
import { receiptArray, receiptOk, runOrca } from './orca.ts'
import { pluginRoot } from './setup-automation.ts'
import { SETUP_DRAFT_FILE } from './setup-draft.ts'
import { envCount, runNode } from './sys.ts'

import { existsSync, mkdirSync, statfsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { Prompter } from './setup-prompt.ts'

const CONFIG_EDIT_SCRIPT = 'skills/orca-team-dispatch-task/scripts/config-edit.ts'
const MIB = 1024 * 1024
const TOGGLE_HELP: { [key in Toggle]: string } = {
  review_mode: 'レビュー役を付けるか',
  phase_b: '計画役と実装役に分けるか',
  integration: '成果の取り込み方（merge か PR）',
  setup: 'worktree を作ったあとリポジトリの setup hook を走らせるか',
  design_mode: '取りかかり方（direct / plan / brainstorm）',
  ask_via: 'brainstorm の質問をどこで尋ねるか（worker の端末か親か）',
  cleanup: 'PR のタスクの後片付けの時機',
  close_on_merge: '--issue で merge した issue を閉じるか（off なら Testing のまま人の動作確認を待つ）',
}

const noInput = Symbol('noInput')
export const runSettings = (name: string, prompter: Prompter, out: (text: string) => void): number => {
  const say = (text: string): void => out(`${text}\n`)
  const ask = (question: string, fallback: string | undefined, valid: (value: string) => string | null): string => {
    for (;;) {
      const answer = prompter.ask(question, fallback)
      if (answer === null) throw noInput
      const problem = answer === '' ? '値を入力してください' : valid(answer)
      if (problem === null) return answer
      say(problem)
    }
  }
  const confirm = (question: string): boolean => {
    const answer = prompter.confirm(question)
    if (answer === null) throw noInput
    return answer
  }
  let failed = false

  const workerAndToggles = (): void => {
    const current = asObject(readJson(globalConfigFile())) ?? {}
    const sets: string[] = []
    say('[1/4] worker のモデル（Enter で今の値のまま）')
    for (const role of ALL_ROLES) {
      const stored = asObject(get(current, 'roles', role)) ?? {}
      const def = DEFAULT_TUPLES[role]
      const storedAgent = asString(stored.agent)
      const effectiveAgent = storedAgent ?? def.agent
      const agent = ask(`${role} の agent（claude / codex）`, effectiveAgent, (v) =>
        validAgent(v) ? null : '空白や記号（\' " ` $ \\ !）を含まない値を入力してください',
      )
      if (!knownAgent(agent)) say(`  ${agent} は知らない agent です。Orca が受け付けるかは起動のときに分かります`)
      // 既定の model / effort は、agent が既定の agent と同じときだけ使う（lib/config.ts の DEFAULT_TUPLES）
      const effective = (field: 'model' | 'effort'): string | undefined =>
        asString(stored[field]) ?? (agent === def.agent ? def[field] : undefined)
      const fallback = (field: 'model' | 'effort'): string | undefined =>
        agent === effectiveAgent
          ? effective(field)
          : agent === def.agent
            ? def[field]
            : field === 'model'
              ? MODEL_CHOICES[agent]?.[0]
              : EFFORT_CHOICES[agent]?.[0]
      const models = MODEL_CHOICES[agent]
      const model = ask(`${role} の model${models ? `（例: ${models.join(' / ')}）` : ''}`, fallback('model'), (v) => {
        if (!validModel(v)) return '空白や記号を含まない値を入力してください'
        const owner = modelAgent(v)
        return owner && knownAgent(agent) && owner !== agent ? `${v} は ${owner} の model です` : null
      })
      const efforts = EFFORT_CHOICES[agent]
      const effort = normalizeEffort(
        ask(`${role} の effort${efforts ? `（${efforts.join(' / ')}）` : ''}`, fallback('effort'), (v) =>
          knownAgent(agent)
            ? validEffort(normalizeEffort(v), agent)
              ? null
              : `${agent} の effort ではありません`
            : validShellValue(v)
              ? null
              : '空白や記号を含まない値を入力してください',
        ),
      )
      if (agent !== effectiveAgent) sets.push(`roles.${role}.agent=${agent}`)
      if (model !== effective('model')) sets.push(`roles.${role}.model=${model}`)
      if (effort !== effective('effort')) sets.push(`roles.${role}.effort=${effort}`)
    }
    say('[2/4] 取りかかり方などの既定（手動の dispatch の既定。--auto の review_mode / phase_b は make roles の値）')
    for (const key of TOGGLE_KEYS) {
      const spec = TOGGLES[key]
      const now = asString(current[key]) ?? spec.fallback
      const value = ask(`${key}: ${TOGGLE_HELP[key]}（${spec.values.join(' / ')}）`, now, (v) =>
        validToggle(key, v) ? null : `${spec.values.join(' / ')} のどれかを入力してください`,
      )
      if (value !== now) sets.push(`${key}=${value}`)
    }
    if (!sets.length) {
      say('worker のモデルと既定は変わる所がありません')
      return
    }
    for (const set of sets) say(`  ${set}`)
    if (!confirm(`${globalConfigFile()} に書きますか`)) {
      say('書きませんでした')
      return
    }
    const result = runNode(join(pluginRoot(), CONFIG_EDIT_SCRIPT), [
      '--layer',
      'global',
      ...sets.flatMap((set) => ['--set', set]),
    ])
    if (result.rc !== 0) {
      say(`書けませんでした: ${(result.stderr || result.stdout).trim()}`)
      failed = true
      return
    }
    say('書きました')
    for (const repo of Object.values(readAutoConfig(name)?.repos ?? {}))
      if (existsSync(projectConfigFile(repo.checkout)))
        say(`  ${projectConfigFile(repo.checkout)} があり、そのリポジトリではこちらの値が global より勝ちます`)
  }

  const judge = (): void => {
    say(`[3/4] --auto の判定役のモデル（${name}）`)
    const file = join(autoDir(name), AUTO_FILES.config)
    const config = readAutoConfig(name)
    if (!config) {
      say(`  ${file} がありません。--auto を使うなら make auto-setup ${name} を先に実行してください`)
      return
    }
    if (existsSync(join(autoDir(name), SETUP_DRAFT_FILE))) {
      say(`  make auto-setup ${name} が途中です。この段は飛ばします（先に auto-setup を最後まで実行してください）`)
      return
    }
    const model = ask('判定役の model（claude で起こします）', config.judge.model, (v) => {
      if (!validModel(v)) return '空白や記号を含まない値を入力してください'
      const owner = modelAgent(v)
      return owner && owner !== 'claude' ? `${v} は ${owner} の model です` : null
    })
    const effort = normalizeEffort(
      ask(`判定役の effort（${EFFORT_CHOICES.claude?.join(' / ')}）`, config.judge.effort, (v) =>
        validEffort(normalizeEffort(v), 'claude') ? null : 'claude の effort ではありません',
      ),
    )
    if (model === config.judge.model && effort === config.judge.effort) {
      say('  変わる所はありません')
      return
    }
    while (!takeLockWait(name, AUTO_LOCK_TTL_MS, envCount('ORCA_AUTO_LOCK_WAIT_MS', AUTO_LOCK_WAIT_MS))) {
      if (!confirm('tick が動いています。もう一度待ちますか')) {
        say('  書きませんでした')
        failed = true
        return
      }
    }
    try {
      const raw = asObject(readJson(file))
      const next: JsonObject | null = raw ? { ...raw, judge: { ...(asObject(raw.judge) ?? {}), model, effort } } : null
      if (!next || !parseAutoConfig(next, name) || !writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)) {
        say(`  ${file} を書けませんでした`)
        failed = true
        return
      }
      say('  書きました')
    } finally {
      releaseLock(name)
    }
  }

  type Setup = { id: string; name: string; path: string; base: string | null }
  const readSetups = (): Setup[] | null => {
    const rows = receiptArray(runOrca(['project', 'setups', '--json']), 'setups')
    if (!rows) return null
    const setups: Setup[] = []
    for (const row of rows) {
      const o = asObject(row)
      const id = asString(o?.id)
      const path = asString(o?.path)
      if (!o || !id || !path || o.hostId !== 'local' || o.kind !== 'git') continue
      setups.push({ id, path, name: asString(o.displayName) ?? path, base: asString(o.worktreeBasePath) })
    }
    return setups
  }
  const workspace = (): void => {
    say('[4/4] worker の worktree を作る場所（Orca のリポジトリごとの設定）')
    let setups = readSetups()
    if (!setups) {
      say('  Orca からリポジトリの一覧を読めません。Orca が動いているか確かめてください')
      failed = true
      return
    }
    if (!setups.length) {
      say('  Orca に登録されたこのマシンのリポジトリがありません')
      return
    }
    for (;;) {
      for (const [index, s] of setups.entries())
        say(`  ${index + 1}. ${s.name}  ${s.path}  作業場所: ${s.base ?? 'Orca の既定'}`)
      const answer = prompter.ask('変えるリポジトリの番号（終わるなら Enter）', '')
      if (answer === null) throw noInput
      if (answer === '') return
      const target = setups[Number(answer) - 1]
      if (!/^[1-9]\d*$/.test(answer) || !target) {
        say('一覧の番号を入力してください')
        continue
      }
      const path = ask('worktree を作るディレクトリ（絶対パス）', target.base ?? undefined, (v) =>
        isAbsolute(v) && validShellValue(v) ? null : '空白や記号を含まない絶対パスを入力してください',
      )
      if (!existsSync(path)) {
        if (!confirm(`${path} はありません。作りますか`)) continue
        mkdirSync(path, { recursive: true })
      }
      if (!statSync(path).isDirectory()) {
        say(`${path} はディレクトリではありません`)
        continue
      }
      const fs = statfsSync(path)
      const same = existsSync(target.path) ? statSync(path).dev === statSync(target.path).dev : null
      say(
        `  空き ${Math.floor((fs.bavail * fs.bsize) / MIB)} MB${same === null ? '' : same ? '（checkout と同じディスク）' : '（checkout とは別のディスク）'}`,
      )
      if (!confirm(`${target.name} の worktree を ${path} に作るようにしますか`)) continue
      const updated = runOrca(['project', 'setup-update', '--setup', target.id, '--worktree-base-path', path, '--json'])
      setups = readSetups() ?? setups
      if (!receiptOk(updated) || setups.find((s) => s.id === target.id)?.base !== path) {
        say(`  Orca が作業場所を変えませんでした: ${(updated.stderr || updated.stdout).trim()}`)
        failed = true
        continue
      }
      say('  変えました。次に作る worktree から効きます（今ある worktree は動きません）')
    }
  }

  try {
    workerAndToggles()
    judge()
    workspace()
    return failed ? 1 : 0
  } catch (error) {
    if (error === noInput) return 2
    say(error instanceof Error ? error.message : String(error))
    return 1
  }
}
