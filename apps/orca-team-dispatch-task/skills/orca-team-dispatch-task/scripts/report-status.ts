// 子セッションが status.json を終端状態へ遷移させるための入口（旧版 report-status の移植）。
//
// Usage: node report-status.ts <status-dir> <done|error> [message words...]
// Exit: 0 = 書き込み成功 / 1 = 書き込み失敗 / 2 = 使用法エラー
import { die, log } from '../../../lib/cli.ts'
import { readJson, writeAtomic } from '../../../lib/fs.ts'
import { asObject, type JsonObject } from '../../../lib/json.ts'
import { nowIso } from '../../../lib/sys.ts'

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'report-status'

const nonEmptyFile = (file: string): boolean => {
  try {
    const stat = statSync(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

const main = (argv: string[]): number => {
  const [statusDir = '', status = '', ...words] = argv
  if (statusDir === '') return die(NAME, 'status directory is required')
  if (status === '') return die(NAME, 'status is required (done or error)')
  if (status !== 'done' && status !== 'error') return die(NAME, `status must be done or error (got: ${status})`)
  try {
    mkdirSync(statusDir, { recursive: true })
  } catch {
    log(NAME, `cannot create status dir: ${statusDir}`)
    return 1
  }
  // V3: result.md が無くても done は通す。書けない事情 (sandbox / ディスク) で完了不能にしたくないため
  //     で、代わりに親が検知できる痕跡を残す（2026-09-02 に「result.md written」と報告しながら実ファイルが
  //     無いケースが 3 件あった）
  const resultMissing = status === 'done' && !nonEmptyFile(join(statusDir, 'result.md'))
  if (resultMissing) {
    log(NAME, `warning: ${statusDir}/result.md is missing or empty; recording result_missing`)
  }
  // 既存ファイルが無ければ空オブジェクトから組む。壊れた JSON も同様に扱う
  // （ここで諦めると完了が親に伝わらないため、保存より報告を優先する）
  const file = join(statusDir, 'status.json')
  const next: JsonObject = {
    ...(asObject(readJson(file)) ?? {}),
    status,
    message: words.join(' '),
    timestamp: nowIso(),
  }
  if (resultMissing) next.result_missing = true
  else Reflect.deleteProperty(next, 'result_missing')
  if (!writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)) {
    log(NAME, `failed to replace ${file}`)
    return 1
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
