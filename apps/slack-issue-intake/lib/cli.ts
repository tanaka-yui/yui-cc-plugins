import { MSG_TEST_CLOCK_ONLY, SLACK_API_BASE } from './defaults.ts'
import { maskSecrets } from './secrets.ts'
import { slackApiBase } from './slack-api.ts'

import { type ParseArgsConfig, parseArgs } from 'node:util'

// 今の bash スクリプトと同じ `<name>: <message>` の形で stderr に出す
export const log = (name: string, message: string): void => {
  process.stderr.write(`${name}: ${maskSecrets(message)}\n`)
}

// 使用法の誤りは exit 2（既存スクリプトの die と同じ）
export const die = (name: string, message: string): never => {
  log(name, message)
  process.exit(2)
}

// `--now <ISO>` の解析。省略時は現在時刻。DB の時刻は UTC の ISO 文字列で揃える
export const parseNow = (name: string, value: string | undefined): string => {
  if (value !== undefined && slackApiBase() === SLACK_API_BASE) return die(name, MSG_TEST_CLOCK_ONLY)
  const date = value === undefined ? new Date() : new Date(value)
  if (Number.isNaN(date.getTime())) return die(name, `--now が日付として読めません: ${value}`)
  return date.toISOString()
}

// node:util の parseArgs の薄い包み。解析できない引数は die へ回す
export const parseFlags = <T extends ParseArgsConfig>(name: string, config: T): ReturnType<typeof parseArgs<T>> => {
  try {
    return parseArgs(config)
  } catch (error) {
    return die(name, error instanceof Error ? error.message : String(error))
  }
}

// カンマ区切りの値を、空白を除いた空でない要素の配列にする
export const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
