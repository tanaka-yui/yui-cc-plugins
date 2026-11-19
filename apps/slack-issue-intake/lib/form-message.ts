import { FIELD_LABELS, SUBMISSION_MARKER } from './defaults.ts'

import type { FormKind } from './types.ts'

const FENCE = '```'

// 'title' / 'priority' / 'reporter' か、カテゴリ別の項目の name
export type Slot = string
export const REPO_SLOT = 'repo'
export const REPORTER_SLOT = 'reporter'

// 投稿の形。題と優先度の行は titled の種類だけに置く。項目名は太字にし、複数行の値はコードブロックで囲み、カテゴリ別の項目は空行で区切る。
// ワークフローと手で作る手順の両方がこの形を使い、解析器（parseSubmission）が読む
export const renderKindMessage = (kind: FormKind, slot: (name: Slot) => string, withRepo: boolean): string =>
  [
    SUBMISSION_MARKER,
    ...(kind.titled ? [`*${FIELD_LABELS.title}:* ${slot('title')}`] : []),
    `*${FIELD_LABELS.category}:* ${kind.category}`,
    ...(kind.titled ? [`*${FIELD_LABELS.priority}:* ${slot('priority')}`] : []),
    ...(withRepo ? [`*${FIELD_LABELS.repo}:* ${slot(REPO_SLOT)}`] : []),
    `*${FIELD_LABELS.reporter}:* ${slot(REPORTER_SLOT)}`,
    ...kind.items.flatMap((item) =>
      item.long ? ['', `*${item.label}:*`, FENCE, slot(item.name), FENCE] : ['', `*${item.label}:* ${slot(item.name)}`],
    ),
  ].join('\n')
