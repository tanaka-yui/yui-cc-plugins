// integration テスト共通ヘルパ
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** apps/token-meter/ からの相対パスを絶対パスに解決する */
export function binPath(rel: string): string {
  // __dirname = apps/token-meter/__tests__/integration/
  return join(__dirname, '..', '..', rel)
}

/** shim を bun で spawn して stdin に payload を流し込み、終了コードと stderr を返す */
export function runHook(bin: string, payload: object, home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, TOKEN_METER_HOME: home }
    const p = spawn('bun', ['run', bin], { env })
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    p.on('close', (code) => resolve({ code, stderr }))
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}

/** shim を bun で spawn して任意の raw 文字列を stdin に流し込み、終了コードを返す */
export function runHookRaw(bin: string, raw: string, home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, TOKEN_METER_HOME: home }
    // bin は絶対パスを期待する
    const p = spawn('bun', ['run', bin], { env })
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    p.on('close', (code) => resolve({ code, stderr }))
    p.stdin.write(raw)
    p.stdin.end()
  })
}
