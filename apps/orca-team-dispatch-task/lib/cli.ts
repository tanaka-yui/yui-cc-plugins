import { type ParseArgsConfig, parseArgs } from 'node:util'

// 今の bash スクリプトと同じ `<name>: <message>` の形で stderr に出す
export const log = (name: string, message: string): void => {
  process.stderr.write(`${name}: ${message}\n`)
}

// 使用法の誤りは exit 2（既存スクリプトの die と同じ）
export const die = (name: string, message: string): never => {
  log(name, message)
  process.exit(2)
}

// node:util の parseArgs の薄い包み。解析できない引数は die へ回す
export const parseFlags = <T extends ParseArgsConfig>(name: string, config: T): ReturnType<typeof parseArgs<T>> => {
  try {
    return parseArgs(config)
  } catch (error) {
    return die(name, error instanceof Error ? error.message : String(error))
  }
}
