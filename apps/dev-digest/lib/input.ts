import { WEBHOOK_DIALOG_TITLE } from './defaults.ts'

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export type InputMode = 'dialog' | 'clipboard' | 'stdin'

// value: 読めた値（trim 済み）/ cancelled: ユーザーがダイアログを閉じた / unavailable: その方式が使えない
export type SecretResult = { kind: 'value'; value: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

const UNAVAILABLE: SecretResult = { kind: 'unavailable' }
const OSASCRIPT_CANCEL_CODE = '-128'
const WSL_MARKER = 'microsoft'
const PROC_VERSION = '/proc/version'

// 値は子プロセスの argv に載せない。ここで渡すのは表示用の文言だけ
const DIALOG_SCRIPT = [
  'on run argv',
  `text returned of (display dialog (item 1 of argv) default answer "" with hidden answer with title "${WEBHOOK_DIALOG_TITLE}")`,
  'end run',
]

const CLIPBOARD_COMMANDS_LINUX: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['wl-paste', ['--no-newline']],
  ['xclip', ['-o', '-selection', 'clipboard']],
]
const CLIPBOARD_COMMAND_WSL: readonly [string, readonly string[]] = [
  'powershell.exe',
  ['-NoProfile', '-Command', 'Get-Clipboard'],
]
const CLIPBOARD_COMMAND_DARWIN: readonly [string, readonly string[]] = ['pbpaste', []]

export const isWsl = (): boolean => {
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return readFileSync(PROC_VERSION, 'utf8').toLowerCase().includes(WSL_MARKER)
  } catch {
    return false
  }
}

// 標準入力は無視し、出力だけを受け取る。失敗したら null
const capture = (command: string, args: readonly string[]): { stdout: string; stderr: string } | null => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined || result.status !== 0) return null
  return { stdout: result.stdout, stderr: result.stderr }
}

const fromValue = (text: string): SecretResult => ({ kind: 'value', value: text.replace(/[\r\n]+$/, '').trim() })

const readDialog = (prompt: string): SecretResult => {
  const args = DIALOG_SCRIPT.flatMap((line) => ['-e', line])
  const result = spawnSync('osascript', [...args, '--', prompt], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) return UNAVAILABLE
  if (result.status === 0) return fromValue(result.stdout)
  // ユーザーのキャンセルは AppleScript のエラー -128 で終わる
  return result.stderr.includes(OSASCRIPT_CANCEL_CODE) ? { kind: 'cancelled' } : UNAVAILABLE
}

const readClipboard = (): SecretResult => {
  const candidates = isWsl()
    ? [CLIPBOARD_COMMAND_WSL]
    : process.platform === 'darwin'
      ? [CLIPBOARD_COMMAND_DARWIN]
      : CLIPBOARD_COMMANDS_LINUX
  for (const [command, args] of candidates) {
    const output = capture(command, args)
    if (output !== null) return fromValue(output.stdout)
  }
  return UNAVAILABLE
}

const readStdin = (): SecretResult => {
  try {
    return fromValue(readFileSync(0, 'utf8'))
  } catch {
    return UNAVAILABLE
  }
}

export const readSecret = (mode: InputMode, prompt: string): SecretResult => {
  if (mode === 'dialog') return readDialog(prompt)
  if (mode === 'clipboard') return readClipboard()
  return readStdin()
}
