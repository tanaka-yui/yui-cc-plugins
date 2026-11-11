import type { JsonObject, JsonValue } from './types.ts'

export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: JsonValue | undefined): string | null => (typeof value === 'string' ? value : null)

export const asNumber = (value: JsonValue | undefined): number | null => (typeof value === 'number' ? value : null)

export const asArray = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : [])

export function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}
