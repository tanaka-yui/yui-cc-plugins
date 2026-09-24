// ある役の成果がレビューを経たかを 1 語で言う（旧版 review-state の移植）。
// Usage: node review-state.ts --status-dir <d> --role <r>
// 出力: reviewed / unreviewed / none（レビューを求めていない）。改行は付けない
// Exit: 0 = 判定した / 2 = 使用法エラー
//
// ★ **判定を 1 箇所に置く。**orca-wait.ts は受理時の警告と最終行に、orca-merge.ts は取り込みの gate に、
//   **同じ問い**を使う。2 箇所に書くと必ず片方だけ直されてドリフトする。
//
// ★ **「findings が在る」は「レビューされた」ではない。**依頼側が先に決着していれば verdict は受け取られない
//   （実測 2026-09-12: 3 Run 中 2 Run で未配送）。配送された記録（sent.json）まで揃って初めて reviewed である。
import { die } from '../lib/cli.ts'
import { readJson } from '../lib/fs.ts'
import { asArray, asString, get } from '../lib/json.ts'

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'review-state'
const PREFIX: { [role: string]: string } = { design: 'plan', exec: 'code' }

const hasVerdict = (reviewDir: string, prefix: string): boolean => {
  let names: string[] = []
  try {
    names = readdirSync(reviewDir)
  } catch {
    return false
  }
  const pattern = new RegExp(`^${prefix}-round-.*-findings\\.md$`)
  return names
    .filter((name) => pattern.test(name))
    .some((name) => {
      try {
        return readFileSync(join(reviewDir, name), 'utf8')
          .split('\n')
          .some((line) => line.startsWith('VERDICT: '))
      } catch {
        return false
      }
    })
}

const main = (argv: string[]): number => {
  let statusDir = ''
  let role = ''
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? ''
    const value = argv[index + 1]
    if (flag !== '--status-dir' && flag !== '--role') return die(NAME, `unknown option: ${flag}`)
    if (value === undefined) return die(NAME, `${flag} requires a value`)
    if (flag === '--status-dir') statusDir = value
    else role = value
  }
  if (statusDir === '' || role === '') return die(NAME, '--status-dir and --role are required')
  const answer = (word: string): number => {
    process.stdout.write(word)
    return 0
  }
  // レビューされうるのは成果を作る役だけである。reviewer 自身は対象ではない
  const prefix = PREFIX[role]
  if (prefix === undefined) return answer('none')
  // その役の reviewer が起きていなければ、そもそもレビューを求めていない
  const reviewer = asString(get(readJson(join(statusDir, 'workers.json')), 'roles', `${role}_review`, 'dispatch')) ?? ''
  if (reviewer === '') return answer('none')
  if (!hasVerdict(join(statusDir, 'review'), prefix)) return answer('unreviewed')
  // ★ **ここが「findings が在る」と「届いた」を分ける。**記録が無ければ未配送として扱う —
  //   取り違えるなら、通してしまうより止めるほうへ倒す（gate は override を持っている）
  const delivered = (asArray(readJson(join(statusDir, 'sent.json'))) ?? []).some(
    (entry) =>
      (asString(get(entry, 'to')) ?? '') === role &&
      (asString(get(entry, 'subject')) ?? '').startsWith('review-verdict:'),
  )
  return answer(delivered ? 'reviewed' : 'unreviewed')
}

process.exitCode = main(process.argv.slice(2))
