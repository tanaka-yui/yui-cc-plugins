import { BOT_TOKEN_PATTERN } from './defaults.ts'
import { readJson, writeJson } from './fs.ts'
import { asString, get } from './json.ts'
export const isBotToken = (text: string): boolean => BOT_TOKEN_PATTERN.test(text)
export const maskToken = (token: string): string => `${token.slice(0, 5)}***`
export const maskSecrets = (text: string): string => text.replace(/xox[a-z]-[A-Za-z0-9-]+/g, maskToken)
export const loadToken = (file: string): string | null => {
  const token = asString(get(readJson(file) ?? undefined, 'slackBotToken'))
  return token && isBotToken(token) ? token : null
}
export const saveToken = (file: string, token: string): void => writeJson(file, { slackBotToken: token })
