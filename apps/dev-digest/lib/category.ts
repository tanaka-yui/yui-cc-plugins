import { customFeed } from './defaults.ts'

import type { Config, Section } from './config.ts'

type Classifiable = { sourceId: string; section: Section; title: string; summary: string }

// text にどれかの語を含むか（大文字小文字は区別しない部分一致）。語が空なら false
export const containsAny = (text: string, words: string[]): boolean => {
  const lower = text.toLowerCase()
  return words.some((word) => word !== '' && lower.includes(word.toLowerCase()))
}

const textOf = (item: Pick<Classifiable, 'title' | 'summary'>): string => `${item.title}\n${item.summary}`

// 項目が載るカテゴリを決める関数を作る。キーワードが合う追加カテゴリ（設定の順で最初のもの）→
// 追加カテゴリのフィードの項目ならそのカテゴリ → 取得元のセクション、の順
export const categoryResolver = (config: Config): ((item: Classifiable) => string) => {
  const byFeed = new Map<string, string>()
  for (const category of config.categories) {
    for (const url of category.feeds) {
      const { storeAs } = customFeed(url)
      if (!byFeed.has(storeAs)) byFeed.set(storeAs, category.id)
    }
  }
  const keywordCategories = config.categories.filter((category) => category.keywords.length > 0)
  return (item) => {
    const text = textOf(item)
    const matched = keywordCategories.find((category) => containsAny(text, category.keywords))
    return matched?.id ?? byFeed.get(item.sourceId) ?? item.section
  }
}

// 除外ワード（共通 ＋ その項目のカテゴリのもの）をタイトルか要約に含むか
export const isExcluded = (config: Config, item: Pick<Classifiable, 'title' | 'summary'>, category: string): boolean =>
  containsAny(textOf(item), [...config.excludeWords, ...(config.categoryExclude[category] ?? [])])

// 重複を見るための URL。host を小文字にし、クエリ・# 以降・末尾の / を除く。URL として読めなければそのまま
export const normalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url.trim())
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : ''
    return `${parsed.protocol}//${parsed.host}${path}`
  } catch {
    return url.trim()
  }
}
