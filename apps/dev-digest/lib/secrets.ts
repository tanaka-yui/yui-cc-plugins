import { GLOBAL_TARGET, SECRET_DIR_MODE, SECRET_FILE_MODE, SECTION_TARGET_PREFIX } from './defaults.ts'
import { asObject, asString, parseJson } from './json.ts'

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// sections: 専用チャンネルに分けたカテゴリの id → Webhook
export type Secrets = {
  global: string | null
  sections: Record<string, string>
  repos: Record<string, string>
}

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

// `section:<id>` のカテゴリ id。そうでなければ null（id が今あるカテゴリかは呼び出し側が確かめる）
export const sectionOfTarget = (target: string): string | null =>
  target.startsWith(SECTION_TARGET_PREFIX) ? target.slice(SECTION_TARGET_PREFIX.length) : null

export const loadSecrets = (file: string): Secrets => {
  const empty: Secrets = { global: null, sections: {}, repos: {} }
  try {
    const root = asObject(parseJson(readFileSync(file, 'utf8')))
    if (root === null) return empty
    const repos: Record<string, string> = {}
    for (const [slug, value] of Object.entries(asObject(root.repos) ?? {})) {
      const url = asString(value)
      if (url !== null) repos[slug] = url
    }
    // sections より前に作ったファイルには無い
    const sections: Record<string, string> = {}
    for (const [id, value] of Object.entries(asObject(root.sections) ?? {})) {
      const url = asString(value)
      if (url !== null && url !== '') sections[id] = url
    }
    return { global: asString(root.global), sections, repos }
  } catch {
    return empty
  }
}

// 一時ファイルに 0600 で書いてから rename する。既存ファイルの権限も締め直す
const writeSecrets = (file: string, next: Secrets): void => {
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

// target は global・section:<name>・owner/repo のどれか（呼び出し側が確かめてから渡す）
export const saveWebhook = (file: string, target: string, url: string): void => {
  const current = loadSecrets(file)
  const section = sectionOfTarget(target)
  if (target === GLOBAL_TARGET) writeSecrets(file, { ...current, global: url })
  else if (section !== null) writeSecrets(file, { ...current, sections: { ...current.sections, [section]: url } })
  else writeSecrets(file, { ...current, repos: { ...current.repos, [target]: url } })
}

// セクション専用の Webhook を消す（そのセクションは全体のチャンネルに戻る）。無ければ何も書かず false
export const removeSectionWebhook = (file: string, section: string): boolean => {
  const current = loadSecrets(file)
  if (!Object.hasOwn(current.sections, section)) return false
  const { [section]: _removed, ...rest } = current.sections
  writeSecrets(file, { ...current, sections: rest })
  return true
}

// リポジトリ専用の Webhook を消す。無ければ何も書かず false
export const removeRepoWebhook = (file: string, slug: string): boolean => {
  const current = loadSecrets(file)
  if (!Object.hasOwn(current.repos, slug)) return false
  const { [slug]: _removed, ...rest } = current.repos
  writeSecrets(file, { ...current, repos: rest })
  return true
}

const knownUrls = (secrets: Secrets): string[] =>
  [secrets.global, ...Object.values(secrets.sections), ...Object.values(secrets.repos)].filter(
    (url): url is string => url !== null && url !== '',
  )

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
