import { die, log, parseFlags } from '../cli.ts'
import { loadRepos, parseRepoConfig, type RepoConfig, removeRepo, saveRepo } from '../config.ts'
import { asObject, type Json, parseJson } from '../json.ts'
import { digestHome, homePaths } from '../paths.ts'
import { loadSecrets, maskWebhook, removeRepoWebhook } from '../secrets.ts'

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const NAME = 'dev-digest repo'
const SLUG_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/
const GITHUB_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const TAG_PATTERN = /^[a-z0-9]+$/
// git@host:owner/repo / https://host/owner/repo / ssh://git@host/owner/repo（末尾の .git は除く）
const REMOTE_PATTERNS = [
  /^[^@/\s]+@[^:/\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/,
  /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?[^/\s]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/,
]

const directory = (path: string): string | null => {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : null
  } catch {
    return null
  }
}

export const slugFromRemote = (url: string): string | null => {
  for (const pattern of REMOTE_PATTERNS) {
    const slug = pattern.exec(url.trim())?.[1]
    if (slug !== undefined) return slug
  }
  return null
}

const deriveSlug = (path: string): string => {
  const real = directory(path) ?? die(`${NAME} slug`, `--path がディレクトリではありません: ${path}`)
  const result = spawnSync('git', ['-C', real, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const fromRemote = result.status === 0 ? slugFromRemote(result.stdout) : null
  return fromRemote ?? basename(real)
}

// candidate は AI が書くので、URL やファイル名に埋め込まれる値は欄の名前つきで拒む
const validate = (value: Json | null): RepoConfig | string => {
  const root = asObject(value ?? undefined)
  if (root === null) return 'candidate: オブジェクトではありません'
  // addedAt は candidate に含めず、こちらで決める
  const parsed = parseRepoConfig({ ...root, addedAt: '' })
  if (typeof parsed === 'string') return parsed
  if (!SLUG_PATTERN.test(parsed.slug)) return `slug: ${SLUG_PATTERN} に合いません`
  for (const tag of parsed.devtoTags) {
    if (!TAG_PATTERN.test(tag)) return `devtoTags: ${TAG_PATTERN} に合いません: ${tag}`
  }
  for (const pkg of parsed.watch.packages) {
    if (pkg.github !== null && !GITHUB_PATTERN.test(pkg.github))
      return `watch.packages[${pkg.name}].github: owner/repo の形か null にしてください`
  }
  const real = directory(parsed.path)
  if (real === null) return `path: 既存のディレクトリではありません: ${parsed.path}`
  return { ...parsed, path: real }
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const names = (repo: RepoConfig): string[] => repo.watch.packages.map((pkg) => pkg.name)

const save = (argv: string[]): void => {
  const name = `${NAME} save`
  const { values } = parseFlags(name, { args: argv, options: { file: { type: 'string' } } })
  const file = values.file ?? die(name, '--file <candidate.json> を指定してください')
  const text = readText(file) ?? die(name, `--file を読めません: ${file}`)
  const validated = validate(parseJson(text))
  const candidate = typeof validated === 'string' ? die(name, validated) : validated
  const home = digestHome()
  const existing = loadRepos(home).find((repo) => repo.slug === candidate.slug)
  const repo: RepoConfig = { ...candidate, addedAt: existing?.addedAt ?? new Date().toISOString() }
  saveRepo(home, repo)
  const before = existing === undefined ? [] : names(existing)
  const after = names(repo)
  const added = after.filter((n) => !before.includes(n)).join(',')
  const removed = before.filter((n) => !after.includes(n)).join(',')
  process.stdout.write(`slug=${repo.slug}\ncreated=${existing === undefined}\nadded=${added}\nremoved=${removed}\n`)
}

const list = (): void => {
  const home = digestHome()
  const secrets = loadSecrets(homePaths(home).secrets)
  const lines = loadRepos(home).map((repo) => {
    const own = secrets.repos[repo.slug]
    const webhook = own === undefined || own === '' ? 'global' : maskWebhook(own)
    const jvn = repo.jvnMinSeverity ?? 'global'
    return `${repo.slug}\t${repo.path}\twebhook=${webhook}\tjvn=${jvn}\tpackages=${repo.watch.packages.length}\n`
  })
  process.stdout.write(lines.join(''))
}

const slugOf = (name: string, argv: string[]): string => {
  const { values } = parseFlags(name, { args: argv, options: { slug: { type: 'string' } } })
  return values.slug ?? die(name, '--slug <owner/repo> を指定してください')
}

const show = (argv: string[]): void => {
  const name = `${NAME} show`
  const slug = slugOf(name, argv)
  const repo = loadRepos(digestHome()).find((r) => r.slug === slug) ?? die(name, `未登録の slug です: ${slug}`)
  process.stdout.write(`${JSON.stringify(repo, null, 2)}\n`)
}

const remove = (argv: string[]): void => {
  const name = `${NAME} remove`
  const slug = slugOf(name, argv)
  const home = digestHome()
  const removedRepo = removeRepo(home, slug)
  const removedSecret = removeRepoWebhook(homePaths(home).secrets, slug)
  if (!removedRepo && !removedSecret) die(name, `未登録の slug です: ${slug}`)
  if (!removedRepo) log(name, '設定は無く、残っていた専用 Webhook だけ消しました')
  process.stdout.write(`removed slug=${slug} webhook=${removedSecret}\n`)
}

export const run = (argv: string[]): void => {
  const [sub, ...rest] = argv
  if (sub === 'slug') {
    const { values } = parseFlags(`${NAME} slug`, { args: rest, options: { path: { type: 'string' } } })
    const path = values.path ?? die(`${NAME} slug`, '--path <dir> を指定してください')
    process.stdout.write(`slug=${deriveSlug(path)}\n`)
  } else if (sub === 'save') save(rest)
  else if (sub === 'list') list()
  else if (sub === 'show') show(rest)
  else if (sub === 'remove') remove(rest)
  else die(NAME, '使用法: repo <slug|save|list|show|remove> [options]')
}
