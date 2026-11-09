import { die, log, parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { X_URL_PREFIX, xHashtagSearchUrl } from '../defaults.ts'
import { asString, get } from '../json.ts'
import { runOrca } from '../orca.ts'
import { digestHome } from '../paths.ts'

const NAME = 'dev-digest x-open'
const EXIT_FAILED = 1
const INDEX_PATTERN = /^\d+$/

// 毎朝の Claude が X のタブを開く唯一の口。URL は argv から受け取らず、設定だけから組み立てる
// （`orca tab create --url` を Claude に許すと、接頭辞一致の後ろに別の URL を足して外へ送り出せる）
const targetUrl = (target: string | undefined, index: string | undefined): string => {
  const config = loadConfig(digestHome()) ?? die(NAME, '設定がありません。init を先に実行してください')
  if (target === 'list') {
    if (index !== undefined) die(NAME, '--target list に --index は付けません')
    const url = config.x.listUrl ?? die(NAME, 'X のリストが設定されていません')
    return url.startsWith(X_URL_PREFIX) ? url : die(NAME, `X のリストの URL が ${X_URL_PREFIX} で始まっていません`)
  }
  if (target === 'hashtag') {
    const position = index !== undefined && INDEX_PATTERN.test(index) ? Number(index) : -1
    const tag =
      config.x.hashtags[position] ?? die(NAME, `--index は 0 から ${config.x.hashtags.length - 1} にしてください`)
    return xHashtagSearchUrl(tag)
  }
  return die(NAME, '使用法: x-open --target list | x-open --target hashtag --index <n>')
}

export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: { target: { type: 'string' }, index: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  const result = runOrca(['tab', 'create', '--url', targetUrl(values.target, values.index)])
  const page = result.ok ? asString(get(result.json ?? undefined, 'result', 'browserPageId')) : null
  if (!page) {
    log(NAME, result.ok ? 'orca tab create の応答に browserPageId がありません' : 'orca tab create に失敗しました')
    process.exitCode = EXIT_FAILED
    return
  }
  process.stdout.write(`page=${page}\n`)
}
