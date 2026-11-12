// JSON の値を型で表し、any / unknown を書かずに絞り込むための部品。
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

// 読めない文字列は null。JSON の null と区別しないのは、呼び出し側がどちらも「使えない」と扱うため
export const parseJson = (text: string): Json | null => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const asObject = (value: Json | undefined): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null

export const asArray = (value: Json | undefined): Json[] | null => (Array.isArray(value) ? value : null)

export const asString = (value: Json | undefined): string | null => (typeof value === 'string' ? value : null)

// jq の `.a.b.c` と同じく、途中がオブジェクトでなければ undefined を返す
export const get = (value: Json | undefined, ...keys: string[]): Json | undefined => {
  let current = value
  for (const key of keys) {
    const object = asObject(current)
    if (object === null) return undefined
    current = object[key]
  }
  return current
}
