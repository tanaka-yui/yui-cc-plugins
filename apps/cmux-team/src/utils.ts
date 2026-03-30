/** unknown な catch 引数からエラーメッセージを安全に取得する */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
