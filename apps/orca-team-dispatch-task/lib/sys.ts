// OS との境界の共通部品。bash の `cmd args 2>/dev/null`・`command -v`・`sleep`・`date` の置き換え。
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export type ProcResult = { rc: number; stdout: string; stderr: string }

// ★ spawnSync の既定の上限（1 MiB）を越えると子は殺され、rc が失われる。mailbox の batch は
//   worker の本文を運ぶので、bash（上限なし）と同じく事実上無制限に近い値にする
export const MAX_BUFFER = 64 * 1024 * 1024

// ★ 標準入力を渡さない（lib/orca.ts の runOrca と同じ理由）。stdout と stderr は分けて受ける。
//   起動できなかった（ENOENT など）ときは rc 1 で、stderr に理由を入れる
export const run = (command: string, args: string[], cwd?: string): ProcResult => {
  const child = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
  const stderr = child.error === undefined ? (child.stderr ?? '') : child.error.message
  return { rc: child.status ?? 1, stdout: child.stdout ?? '', stderr }
}

// 別の入口（node で走る .ts）を子プロセスで呼ぶ。bash 版の `bash "$HERE/x.sh" ...` に当たる。
// inherit は出力を受けずに親の stdout / stderr へそのまま流す（長く走る待機の log を溜めないため）
export const runNode = (script: string, args: string[], inherit = false): ProcResult => {
  if (!inherit) return run(process.execPath, [script, ...args])
  const child = spawnSync(process.execPath, [script, ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  return { rc: child.status ?? 1, stdout: '', stderr: '' }
}

// bash の `command -v <name>`。PATH を前から見て、実行できる最初のものを返す
export const which = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // 次の候補へ
    }
  }
  return null
}

// bash の `sleep <秒>`。入口は同期で書くので、イベントループを回さずに止まる
export const sleepSeconds = (seconds: number): void => {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

// bash の `date +%s`
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

// bash の `date -u +%Y-%m-%dT%H:%M:%SZ` と jq の `now | todate`（秒まで、末尾 Z）
export const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

// テスト用の間隔などを環境変数から読む。bash の `${VAR:-既定}` と同じく空文字は未設定として扱い、
// 0 以上の整数でなければ既定値に落とす
export const envCount = (name: string, fallback: number): number => {
  const value = process.env[name] ?? ''
  return /^\d+$/.test(value) ? Number(value) : fallback
}
