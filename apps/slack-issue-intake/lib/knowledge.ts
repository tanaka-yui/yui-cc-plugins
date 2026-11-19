import {
  FAQ_MAX_ENTRIES,
  FAQ_TEXT_MAX_CHARS,
  GITHUB_BLOB_URL,
  KNOWLEDGE_CLAUDE_BIN,
  KNOWLEDGE_CLAUDE_ENV,
  KNOWLEDGE_CLAUDE_TIMEOUT_MS,
  KNOWLEDGE_CLONE_TIMEOUT_MS,
  KNOWLEDGE_COMMIT_PATTERN,
  KNOWLEDGE_DOC_EXTENSIONS,
  KNOWLEDGE_DROP,
  KNOWLEDGE_ERRORS,
  KNOWLEDGE_FILES,
  KNOWLEDGE_GIT_BIN,
  KNOWLEDGE_GIT_TIMEOUT_MS,
  KNOWLEDGE_INDEX_TEXT,
  KNOWLEDGE_MAX_BUFFER,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_MAX_FILES,
  KNOWLEDGE_MAX_TOTAL_BYTES,
  KNOWLEDGE_OVERVIEW_MAX_CHARS,
  KNOWLEDGE_PROMPT,
  KNOWLEDGE_STALE_DAYS,
  KNOWLEDGE_TEXT_MAX_CHARS,
  KNOWLEDGE_TOOLS,
  MSG_KNOWLEDGE_EMPTY,
  MSG_KNOWLEDGE_FAILED,
} from './defaults.ts'
import { ensurePrivateDir, readJson, writeAtomic, writeJson } from './fs.ts'
import { truncate } from './issue-body.ts'
import { asArray, asObject, asString, parseJson } from './json.ts'
import { homePaths } from './paths.ts'
import { maskSecrets } from './secrets.ts'
import { makeCommand } from './workspace.ts'

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, sep } from 'node:path'

import type { Json } from './json.ts'

// 仕様の索引（knowledge）の置き場所と読み方。作るのは buildKnowledge（setup・form・knowledge サブコマンド）、
// 読むのは collect（work.json に場所を書く）と無人の Claude（INDEX.md・docs/・faq.jsonl）、FAQ に足すのは回答の投稿

export type KnowledgeMeta = { commit: string; builtAt: string; files: string[] }
// work.json の質問の item に付ける。index・faq・docs は無ければ null。files は根拠に使えるリポジトリ内のパス
export type WorkKnowledge = {
  repo: string
  index: string | null
  faq: string | null
  docs: string | null
  commit: string | null
  builtAt: string | null
  stale: boolean
  files: string[]
}
export type FaqEntry = {
  at: string
  repo: string
  questionKind: string
  question: string
  answer: string
  sources: string[]
  permalink: string
}

export const knowledgeDir = (home: string, repo: string): string =>
  join(homePaths(home).knowledgeDir, ...repo.split('/'))
export const knowledgeFile = (dir: string, name: keyof typeof KNOWLEDGE_FILES): string =>
  join(dir, KNOWLEDGE_FILES[name])

export const readKnowledgeMeta = (dir: string): KnowledgeMeta | null => {
  const o = asObject(readJson(knowledgeFile(dir, 'meta')))
  const commit = asString(o?.commit)
  const builtAt = asString(o?.builtAt)
  const files = asArray(o?.files)
  if (!commit || !builtAt || !files || files.some((f) => typeof f !== 'string')) return null
  return { commit, builtAt, files: files as string[] }
}

export const workKnowledge = (home: string, repo: string, now: Date): WorkKnowledge => {
  const dir = knowledgeDir(home, repo)
  const meta = readKnowledgeMeta(dir)
  const existing = (name: keyof typeof KNOWLEDGE_FILES): string | null =>
    existsSync(knowledgeFile(dir, name)) ? knowledgeFile(dir, name) : null
  return {
    repo,
    index: meta ? existing('index') : null,
    faq: existing('faq'),
    docs: meta ? existing('docs') : null,
    commit: meta?.commit ?? null,
    builtAt: meta?.builtAt ?? null,
    stale: !meta || now.getTime() - Date.parse(meta.builtAt) > KNOWLEDGE_STALE_DAYS * 86_400_000,
    files: meta?.files ?? [],
  }
}

export const sourceLink = (repo: string, commit: string, path: string): string =>
  GITHUB_BLOB_URL.replace('{repo}', repo)
    .replace('{commit}', commit)
    .replace('{path}', path.split('/').map(encodeURIComponent).join('/'))

// 答えた質問を faq.jsonl に足す。件数の上限を超えたら古い順に捨てる。作り直し（buildKnowledge）では消さない
export const appendFaq = (home: string, entry: FaqEntry): void => {
  const file = knowledgeFile(knowledgeDir(home, entry.repo), 'faq')
  const text = (s: string): string => truncate(maskSecrets(s), FAQ_TEXT_MAX_CHARS)
  const line = JSON.stringify({
    ...entry,
    question: text(entry.question),
    answer: text(entry.answer),
    sources: entry.sources.map(maskSecrets),
  })
  const previous = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  writeAtomic(file, `${[...previous, line].slice(-FAQ_MAX_ENTRIES).join('\n')}\n`)
}

// AI が作る索引の形（コードが検査したあとの値）
export type KnowledgeIndex = {
  overview: string
  topics: Array<{ name: string; files: string[] }>
  glossary: Array<{ term: string; meaning: string }>
  docs: Array<{ path: string; title: string; summary: string; topics: string[] }>
}
export type BuildResult =
  | { ok: true; commit: string; files: string[]; dropped: Array<{ path: string; reason: string }> }
  | { ok: false; error: string }

const run = (bin: string, args: string[], cwd: string | undefined, timeout: number) =>
  spawnSync(bin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: KNOWLEDGE_MAX_BUFFER,
  })
const text = (value: Json | undefined, max = KNOWLEDGE_TEXT_MAX_CHARS): string | null => {
  const s = asString(value)
  return s === null ? null : truncate(maskSecrets(s), max)
}
const strings = (value: Json | undefined): string[] | null => {
  const array = asArray(value)
  return array?.every((v) => typeof v === 'string') ? (array as string[]) : null
}
// AI が ./docs/a.md のように書いたパスは、先頭の ./ を外して docs/a.md として扱う
const repoPath = (path: string): string => path.replace(/^(?:\.\/)+/, '')
// claude の出力（--output-format json）から索引の JSON を取り出し、形を確かめる。文字列は maskSecrets を通す
export const parseIndex = (stdout: string): KnowledgeIndex | null => {
  const result = asString(asObject(parseJson(stdout))?.result)
  if (result === null) return null
  const start = result.indexOf('{')
  const end = result.lastIndexOf('}')
  const o = asObject(start >= 0 && end > start ? parseJson(result.slice(start, end + 1)) : null)
  const overview = text(o?.overview, KNOWLEDGE_OVERVIEW_MAX_CHARS)
  const topics = asArray(o?.topics)
  const glossary = asArray(o?.glossary)
  const docs = asArray(o?.docs)
  if (overview === null || !topics || !glossary || !docs) return null
  const index: KnowledgeIndex = { overview, topics: [], glossary: [], docs: [] }
  for (const t of topics) {
    const name = text(asObject(t)?.name)
    const files = strings(asObject(t)?.files)
    if (name === null || !files) return null
    index.topics.push({ name, files: files.map(repoPath) })
  }
  for (const g of glossary) {
    const term = text(asObject(g)?.term)
    const meaning = text(asObject(g)?.meaning)
    if (term === null || meaning === null) return null
    index.glossary.push({ term, meaning })
  }
  for (const d of docs) {
    const path = asString(asObject(d)?.path)
    const title = text(asObject(d)?.title)
    const summary = text(asObject(d)?.summary)
    const docTopics = strings(asObject(d)?.topics)
    if (path === null || title === null || summary === null || !docTopics) return null
    index.docs.push({ path: repoPath(path), title, summary, topics: docTopics.map((t) => text(t) ?? '') })
  }
  return index
}

// 写してよいドキュメントか。clone の中の通常のファイル（symlink でなく、realpath も clone の内側）で、拡張子がドキュメント
const checkDoc = (root: string, path: string): { size: number } | { reason: string } => {
  const normalized = normalize(path)
  if (
    !path ||
    isAbsolute(path) ||
    normalized !== path ||
    normalized.split(sep).some((part) => part === '..' || part === '.git')
  )
    return { reason: KNOWLEDGE_DROP.path }
  const full = join(root, path)
  try {
    const stat = lstatSync(full)
    if (!stat.isFile() || !realpathSync(full).startsWith(realpathSync(root) + sep))
      return { reason: KNOWLEDGE_DROP.missing }
    if (!KNOWLEDGE_DOC_EXTENSIONS.includes(extname(path).toLowerCase())) return { reason: KNOWLEDGE_DROP.ext }
    if (stat.size > KNOWLEDGE_MAX_FILE_BYTES) return { reason: KNOWLEDGE_DROP.size }
    return { size: stat.size }
  } catch {
    return { reason: KNOWLEDGE_DROP.missing }
  }
}

const renderIndex = (repo: string, commit: string, builtAt: string, index: KnowledgeIndex): string => {
  const t = KNOWLEDGE_INDEX_TEXT
  return [
    t.heading.replace('{repo}', repo),
    t.built.replace('{commit}', commit).replace('{at}', builtAt),
    t.overview,
    index.overview,
    t.topics,
    index.topics.map((topic) => `- **${topic.name}**: ${topic.files.map((f) => `\`${f}\``).join(', ')}`).join('\n'),
    t.glossary,
    index.glossary.map((g) => `- **${g.term}**: ${g.meaning}`).join('\n'),
    t.docs,
    index.docs
      .map(
        (d) =>
          `### ${d.title}（\`${d.path}\`）\n\n${d.summary}${d.topics.length ? `\n\n${t.topicsLabel}: ${d.topics.join(', ')}` : ''}`,
      )
      .join('\n\n'),
  ].join('\n\n')
}

// リポジトリを浅く clone し、読み取りだけの claude -p にドキュメントの索引を作らせ、検査を通ったドキュメントだけを写す。
// 古い docs/ と置き換えるのは、新しい版を全部書けたあと。faq.jsonl には触れない。clone はいつも消す
export const buildKnowledge = (home: string, repo: string, ghPath: string, now: Date): BuildResult => {
  const tmp = homePaths(home).tmpDir
  ensurePrivateDir(tmp)
  const work = mkdtempSync(join(tmp, 'knowledge-'))
  const dir = knowledgeDir(home, repo)
  let staging: string | null = null
  try {
    const checkout = join(work, 'repo')
    const clone = run(
      ghPath,
      ['repo', 'clone', repo, checkout, '--', '--depth', '1'],
      undefined,
      KNOWLEDGE_CLONE_TIMEOUT_MS,
    )
    if (clone.status !== 0)
      return { ok: false, error: `${KNOWLEDGE_ERRORS.clone}: ${maskSecrets((clone.stderr ?? '').trim())}` }
    const head = run(KNOWLEDGE_GIT_BIN, ['-C', checkout, 'rev-parse', 'HEAD'], undefined, KNOWLEDGE_GIT_TIMEOUT_MS)
    const commit = (head.stdout ?? '').trim()
    if (head.status !== 0 || !KNOWLEDGE_COMMIT_PATTERN.test(commit))
      return { ok: false, error: KNOWLEDGE_ERRORS.commit }
    const claude = run(
      process.env[KNOWLEDGE_CLAUDE_ENV] || KNOWLEDGE_CLAUDE_BIN,
      [
        '-p',
        KNOWLEDGE_PROMPT,
        '--output-format',
        'json',
        '--tools',
        KNOWLEDGE_TOOLS,
        '--allowedTools',
        KNOWLEDGE_TOOLS,
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
      ],
      checkout,
      KNOWLEDGE_CLAUDE_TIMEOUT_MS,
    )
    if (claude.error)
      return {
        ok: false,
        error:
          'code' in claude.error && claude.error.code === 'ETIMEDOUT'
            ? KNOWLEDGE_ERRORS.timeout
            : KNOWLEDGE_ERRORS.start,
      }
    if (claude.status !== 0) return { ok: false, error: KNOWLEDGE_ERRORS.claude }
    const parsed = parseIndex(claude.stdout ?? '')
    if (!parsed) return { ok: false, error: KNOWLEDGE_ERRORS.shape }
    const dropped: Array<{ path: string; reason: string }> = []
    const files: string[] = []
    let total = 0
    for (const path of new Set(parsed.docs.map((d) => d.path))) {
      const checked = checkDoc(checkout, path)
      const reason =
        'reason' in checked
          ? checked.reason
          : files.length >= KNOWLEDGE_MAX_FILES
            ? KNOWLEDGE_DROP.count
            : total + checked.size > KNOWLEDGE_MAX_TOTAL_BYTES
              ? KNOWLEDGE_DROP.total
              : null
      if (reason !== null || 'reason' in checked) {
        dropped.push({ path: maskSecrets(path), reason: reason ?? '' })
        continue
      }
      files.push(path)
      total += checked.size
    }
    const index: KnowledgeIndex = {
      overview: parsed.overview,
      topics: parsed.topics.map((t) => ({ ...t, files: t.files.filter((f) => files.includes(f)) })),
      glossary: parsed.glossary,
      docs: parsed.docs.filter(
        (d, i) => files.includes(d.path) && parsed.docs.findIndex((x) => x.path === d.path) === i,
      ),
    }
    ensurePrivateDir(dir)
    staging = join(dir, `${KNOWLEDGE_FILES.docs}.new-${randomUUID()}`)
    ensurePrivateDir(staging)
    for (const path of files) writeAtomic(join(staging, path), maskSecrets(readFileSync(join(checkout, path), 'utf8')))
    const builtAt = now.toISOString()
    const docs = knowledgeFile(dir, 'docs')
    const old = join(dir, `${KNOWLEDGE_FILES.docs}.old-${randomUUID()}`)
    if (existsSync(docs)) renameSync(docs, old)
    renameSync(staging, docs)
    staging = null
    rmSync(old, { recursive: true, force: true })
    writeJson(knowledgeFile(dir, 'indexJson'), index)
    writeAtomic(knowledgeFile(dir, 'index'), `${renderIndex(repo, commit, builtAt, index)}\n`)
    // meta.json は最後に書く（collect はこれを見て索引があるとみなし、commit で permalink を作る）
    writeJson(knowledgeFile(dir, 'meta'), { commit, builtAt, files })
    return { ok: true, commit, files, dropped }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

// 設定のリポジトリの索引を順に作る。結果を 1 行ずつ log に、失敗を warn に出し、すべて作れたら true
export const buildRepos = (
  home: string,
  repos: readonly string[],
  ghPath: string,
  log: (line: string) => void,
  warn: (line: string) => void,
): boolean => {
  let ok = true
  for (const repo of repos) {
    const built = buildKnowledge(home, repo, ghPath, new Date())
    if (!built.ok) {
      ok = false
      warn(
        MSG_KNOWLEDGE_FAILED.replace('{repo}', repo)
          .replace('{error}', built.error)
          .replace('{knowledge}', makeCommand(home, 'knowledge')),
      )
      continue
    }
    for (const d of built.dropped) log(`dropped repo=${repo} path=${d.path} reason=${d.reason}`)
    log(`knowledge repo=${repo} files=${built.files.length} commit=${built.commit}`)
    if (!built.files.length)
      warn(MSG_KNOWLEDGE_EMPTY.replace('{repo}', repo).replace('{knowledge}', makeCommand(home, 'knowledge')))
  }
  return ok
}
