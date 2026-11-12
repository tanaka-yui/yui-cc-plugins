import { PROMPT_READ_CHUNK, PROMPT_RETRY_MS } from './defaults.ts'

import { readSync } from 'node:fs'

export type Prompter = {
  ask: (question: string, fallback?: string) => string | null
  confirm: (question: string) => boolean | null
}

const NEWLINE = 0x0a
const YES = ['y', 'yes']

const errorCode = (error: Error): string | undefined => ('code' in error ? String(error.code) : undefined)

// 標準入力は非ブロッキングで開かれていることがある。EAGAIN は少し待って読み直す
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 答えは fd から1行ずつ同期で読む（process.stdin は使わない）。
// 読み残しは次の呼び出しへ持ち越す。日本語が読み取りの境目で割れないよう、バイトのまま貯めて行ごとに文字へ戻す
export const createPrompter = (fd: number, out: (text: string) => void): Prompter => {
  let pending = Buffer.alloc(0)
  let ended = false
  const readLine = (): string | null => {
    for (;;) {
      const at = pending.indexOf(NEWLINE)
      if (at >= 0) {
        const line = pending.subarray(0, at).toString('utf8')
        pending = pending.subarray(at + 1)
        return line.trim()
      }
      if (ended) {
        if (pending.length === 0) return null
        const rest = pending.toString('utf8')
        pending = Buffer.alloc(0)
        return rest.trim()
      }
      const chunk = Buffer.alloc(PROMPT_READ_CHUNK)
      let read: number
      try {
        read = readSync(fd, chunk, 0, chunk.length, null)
      } catch (error) {
        if (error instanceof Error && errorCode(error) === 'EAGAIN') {
          pause(PROMPT_RETRY_MS)
          continue
        }
        throw error
      }
      if (read === 0) ended = true
      else pending = Buffer.concat([pending, chunk.subarray(0, read)])
    }
  }
  return {
    ask: (question, fallback) => {
      out(`${question}${fallback === undefined ? '' : ` [${fallback}]`}: `)
      const line = readLine()
      if (line === null) return null
      return line === '' ? (fallback ?? '') : line
    },
    confirm: (question) => {
      out(`${question} [y/N]: `)
      const line = readLine()
      return line === null ? null : YES.includes(line.toLowerCase())
    },
  }
}
