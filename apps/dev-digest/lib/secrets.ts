import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './defaults.ts'
import { asObject, asString, parseJson } from './json.ts'

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Secrets = { global: string | null; repos: Record<string, string> }

const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/\S+$/
const WEBHOOK_PARTS = /^https:\/\/hooks\.slack\.com\/services\/([^/\s]+)\/([^/\s]+)\/\S+$/
const MASKED_ANY = '***'
// origin が書き換えられた URL や、URL の一部だけが残った文字列も伏せる
const SERVICES_PATH = /(?:https?:\/\/[^\s/"'<>|]+)?\/services\/[^\s"'<>|)]+/g
const SERVICES_MARK = '/services/'

export const isWebhookUrl = (text: string): boolean => WEBHOOK_PATTERN.test(text)

export const maskWebhook = (url: string): string => {
  const parts = WEBHOOK_PARTS.exec(url)
  const team = parts?.[1]
  if (team === undefined || team === '') return MASKED_ANY
  return `https://hooks.slack.com/services/${team.slice(0, 1)}***/…`
}

export const loadSecrets = (file: string): Secrets => {
  const empty: Secrets = { global: null, repos: {} }
  try {
    const root = asObject(parseJson(readFileSync(file, 'utf8')))
    if (root === null) return empty
    const repos: Record<string, string> = {}
    for (const [slug, value] of Object.entries(asObject(root.repos) ?? {})) {
      const url = asString(value)
      if (url !== null) repos[slug] = url
    }
    return { global: asString(root.global), repos }
  } catch {
    return empty
  }
}

// 一時ファイルに 0600 で書いてから rename する。既存ファイルの権限も締め直す
export const saveWebhook = (file: string, target: 'global' | string, url: string): void => {
  const current = loadSecrets(file)
  const next: Secrets =
    target === 'global' ? { ...current, global: url } : { ...current, repos: { ...current.repos, [target]: url } }
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE })
  chmodSync(dir, SECRET_DIR_MODE)
  const temp = `${file}.${process.pid}.tmp`
  // 前回の残骸を消してから排他的に作る（他人が置いたファイルを開かない）
  rmSync(temp, { force: true })
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: SECRET_FILE_MODE, flag: 'wx' })
  chmodSync(temp, SECRET_FILE_MODE)
  renameSync(temp, file)
  chmodSync(file, SECRET_FILE_MODE)
}

const knownUrls = (secrets: Secrets): string[] =>
  [secrets.global, ...Object.values(secrets.repos)].filter((url): url is string => url !== null && url !== '')

export const maskSecrets = (text: string, secrets: Secrets): string => {
  let masked = text
  for (const url of knownUrls(secrets)) {
    masked = masked.split(url).join(maskWebhook(url))
    // origin だけ違う形（テストの差し替えなど）や path 単独の出力も伏せる
    const at = url.indexOf(SERVICES_MARK)
    if (at >= 0) masked = masked.split(url.slice(at)).join(`${SERVICES_MARK}${MASKED_ANY}`)
  }
  return masked.replace(SERVICES_PATH, (match) => {
    const origin = match.slice(0, match.indexOf(SERVICES_MARK))
    return `${origin}${SERVICES_MARK}${MASKED_ANY}`
  })
}

export const webhookFor = (secrets: Secrets, slug: string | null): { url: string; viaGlobal: boolean } | null => {
  const own = slug === null ? undefined : secrets.repos[slug]
  if (own !== undefined && own !== '') return { url: own, viaGlobal: false }
  return secrets.global === null || secrets.global === '' ? null : { url: secrets.global, viaGlobal: true }
}
