import { csv, die, parseFlags } from '../cli.ts'
import {
  type Config,
  type CustomCategory,
  categoryIds,
  GLOBAL_SECTIONS,
  isCategoryId,
  loadConfig,
  type Section,
  saveConfig,
} from '../config.ts'
import { NONE_VALUE } from '../defaults.ts'
import { digestHome, homePaths } from '../paths.ts'
import { loadSecrets, removeSectionWebhook } from '../secrets.ts'

const NAME = 'dev-digest category'
const USAGE = '使用法: category <list|set|remove|enable|disable|exclude> [options]'

const listText = (values: string[]): string => (values.length === 0 ? NONE_VALUE : values.join(','))
// `none` は空にする
const listFlag = (value: string): string[] => (value === NONE_VALUE ? [] : csv(value))

const builtin = (name: string, id: string): Section =>
  GLOBAL_SECTIONS.find((section) => section === id) ??
  die(name, `組み込みのカテゴリ（${GLOBAL_SECTIONS.join('|')}）を指定してください: ${id}`)

const isHttpUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const loaded = (name: string): { home: string; config: Config } => {
  const home = digestHome()
  return { home, config: loadConfig(home) ?? die(name, '設定がありません。init を先に実行してください') }
}

const idFlag = (name: string, argv: string[]): string => {
  const { values } = parseFlags(name, { args: argv, options: { id: { type: 'string' } } })
  return values.id ?? die(name, '--id <category> を指定してください')
}

// 1 行 1 カテゴリ。channel は専用チャンネルの有無だけ（URL は出さない）
const list = (): void => {
  const { home, config } = loaded(`${NAME} list`)
  const secrets = loadSecrets(homePaths(home).secrets)
  const tail = (id: string): string =>
    `channel=${secrets.sections[id] === undefined ? 'global' : 'split'}\texclude=${listText(config.categoryExclude[id] ?? [])}`
  const lines = [
    ...GLOBAL_SECTIONS.map(
      (id) => `${id}\tbuiltin\t${config.disabledSections.includes(id) ? 'disabled' : 'enabled'}\t${tail(id)}`,
    ),
    ...config.categories.map(
      (category) =>
        `${category.id}\tcustom\tenabled\ttitle=${category.title}\tfeeds=${listText(category.feeds)}\tkeywords=${listText(category.keywords)}\t${tail(category.id)}`,
    ),
    `exclude_common=${listText(config.excludeWords)}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

// 追加カテゴリを作るか、指定した欄だけ変える
const set = (argv: string[]): void => {
  const name = `${NAME} set`
  const { values } = parseFlags(name, {
    args: argv,
    options: {
      id: { type: 'string' },
      title: { type: 'string' },
      feeds: { type: 'string' },
      keywords: { type: 'string' },
    },
  })
  const id = values.id ?? die(name, '--id <category> を指定してください')
  if (!isCategoryId(id))
    die(name, `--id は英小文字・数字・ハイフンにし、組み込みのカテゴリ名と重ねないでください: ${id}`)
  const { home, config } = loaded(name)
  const current = config.categories.find((category) => category.id === id)
  const title = values.title ?? current?.title ?? die(name, '新しいカテゴリには --title を指定してください')
  const feeds = values.feeds === undefined ? (current?.feeds ?? []) : listFlag(values.feeds)
  const keywords = values.keywords === undefined ? (current?.keywords ?? []) : listFlag(values.keywords)
  const badFeed = feeds.find((url) => !isHttpUrl(url))
  if (badFeed !== undefined) die(name, `--feeds は http / https の URL にしてください: ${badFeed}`)
  if (feeds.length === 0 && keywords.length === 0)
    die(name, '--feeds か --keywords のどちらかは 1 つ以上にしてください')
  const next: CustomCategory = { id, title, feeds: [...new Set(feeds)], keywords: [...new Set(keywords)] }
  const categories =
    current === undefined
      ? [...config.categories, next]
      : config.categories.map((category) => (category.id === id ? next : category))
  saveConfig(home, { ...config, categories })
  process.stdout.write(`saved id=${id} created=${current === undefined}\n`)
}

// 追加カテゴリを消す。そのカテゴリの除外ワードと専用チャンネルの Webhook も消す
const remove = (argv: string[]): void => {
  const name = `${NAME} remove`
  const id = idFlag(name, argv)
  if (GLOBAL_SECTIONS.some((section) => section === id))
    die(name, `組み込みのカテゴリは消せません。止めるなら disable --id ${id}`)
  const { home, config } = loaded(name)
  if (!config.categories.some((category) => category.id === id)) die(name, `無いカテゴリです: ${id}`)
  const { [id]: _removed, ...categoryExclude } = config.categoryExclude
  saveConfig(home, { ...config, categories: config.categories.filter((c) => c.id !== id), categoryExclude })
  const webhook = removeSectionWebhook(homePaths(home).secrets, id)
  process.stdout.write(`removed id=${id} webhook=${webhook}\n`)
}

// 組み込みのカテゴリを止める / 戻す。専用チャンネルの Webhook は残す（戻したときにまた使う）
const toggle = (argv: string[], enabled: boolean): void => {
  const name = `${NAME} ${enabled ? 'enable' : 'disable'}`
  const section = builtin(name, idFlag(name, argv))
  const { home, config } = loaded(name)
  const others = config.disabledSections.filter((entry) => entry !== section)
  saveConfig(home, { ...config, disabledSections: enabled ? others : [...others, section] })
  process.stdout.write(`${enabled ? 'enabled' : 'disabled'} id=${section}\n`)
}

// 除外ワードを置き換える。--id が無ければ全カテゴリ共通のもの
const exclude = (argv: string[]): void => {
  const name = `${NAME} exclude`
  const { values } = parseFlags(name, { args: argv, options: { id: { type: 'string' }, words: { type: 'string' } } })
  const words = listFlag(values.words ?? die(name, `--words <csv|${NONE_VALUE}> を指定してください`))
  const { home, config } = loaded(name)
  const id = values.id
  if (id === undefined) {
    saveConfig(home, { ...config, excludeWords: [...new Set(words)] })
    process.stdout.write(`saved exclude=common words=${listText(words)}\n`)
    return
  }
  // 止めている組み込みのカテゴリにも設定できる（戻したときに効く）
  const known = [...GLOBAL_SECTIONS, ...categoryIds(config)]
  if (!known.includes(id)) die(name, `無いカテゴリです（${[...new Set(known)].join('|')}）: ${id}`)
  const { [id]: _previous, ...rest } = config.categoryExclude
  saveConfig(home, { ...config, categoryExclude: words.length === 0 ? rest : { ...rest, [id]: [...new Set(words)] } })
  process.stdout.write(`saved exclude=${id} words=${listText(words)}\n`)
}

export const run = (argv: string[]): void => {
  const [sub, ...rest] = argv
  if (sub === 'list') list()
  else if (sub === 'set') set(rest)
  else if (sub === 'remove') remove(rest)
  else if (sub === 'enable') toggle(rest, true)
  else if (sub === 'disable') toggle(rest, false)
  else if (sub === 'exclude') exclude(rest)
  else die(NAME, USAGE)
}
