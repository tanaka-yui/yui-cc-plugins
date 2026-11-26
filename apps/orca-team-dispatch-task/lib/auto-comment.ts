import { STATUS, STATUS_LABELS } from './status.ts'

export type AutoEvent =
  | 'auto-ready'
  | 'judged'
  | 'started'
  | 'needs-review'
  | 'partial-merge'
  | 'ai-merged'
  | 'human-merged'
  | 'failed'
  | 'stalled'
  | 'needs-base'
type Pr = { repo: string; number: number; url: string }
export type CommentInput = {
  event: AutoEvent
  generation: number
  reason?: string
  limitMinutes?: number
  relayMinutes?: number
  branch?: string
  branches?: Array<{ repo: string; branch: string }>
  prs?: Pr[]
  decisions?: string[]
  reviewPoints?: string[]
  summary?: string
  mergedPrs?: Pr[]
  unmergedPrs?: Array<Pr & { why: string }>
  elapsedMinutes?: number
  pushed?: boolean
  // needs-base: 向き先の候補と、ラベル無しで Ready に戻されたときに進める向き先
  candidates?: string[]
  fallback?: string
  // needs-base: 対象が 2 つのときのリポジトリごとの fallback、決められなかった理由、拾う元の pick と auto-ready か。
  // 無ければ共有の fixture と同じ本文になる
  fallbacks?: Array<{ repo: string; branch: string }>
  why?: string
  pick?: string
  autoReadySource?: boolean
  // human-merged / ai-merged: 普段の向き先へ取り込む PR の結果（作れたもの・作れなかったもの）
  backPrs?: Array<{ repo: string; url: string }>
  backFailures?: Array<{ repo: string; why: string }>
  // auto-ready: 条件がそろえば AI が merge する Issue か（人が確認してから merge する Issue か）
  autoMerge?: boolean
}
const TESTING_NEXT = '確認が済んだら Done にしてください。'
const clean = (text: string): string =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<!--', '＜!--')
    .replaceAll('-->', '--＞')
export const limitBreakdown = (limitMinutes: number, relayMinutes = 0): string =>
  relayMinutes > 0 ? `（見積もり ${limitMinutes} 分 + 取り次ぎ ${relayMinutes} 分）` : ''
const list = (title: string, items?: string[]): string =>
  items?.length ? `${title}:\n${items.map((d) => `- ${clean(d)}`).join('\n')}` : ''
const link = (p: Pr): string => `[${clean(p.repo)}#${p.number}](${clean(p.url)})`
export const statusOfEvent = (event: AutoEvent): string =>
  ({
    'auto-ready': STATUS.ready,
    judged: STATUS.readyEng,
    started: STATUS.inProgress,
    stalled: STATUS.inProgress,
    'needs-base': STATUS.backlog,
    'needs-review': STATUS.inReview,
    'partial-merge': STATUS.inReview,
    // merge したら人の動作確認を待つ。Done にするのは確認した人
    'ai-merged': STATUS.testing,
    'human-merged': STATUS.testing,
    failed: STATUS.failed,
  })[event]
export const renderComment = (input: CommentInput): { status: string; body: string } => {
  const { event, generation } = input
  const status = STATUS_LABELS.find((l) => l.name === statusOfEvent(event))?.slug ?? ''
  const prs = input.prs?.map(link).join(', ')
  const branch = input.branches?.length
    ? `ブランチ: ${input.branches.map((b) => `\`${clean(b.branch)}\`（${clean(b.repo)}）`).join('、')}`
    : input.branch
      ? `ブランチ: \`${clean(input.branch)}\``
      : ''
  let body: string
  switch (event) {
    case 'auto-ready':
      body = [
        '**Ready にしました**',
        '',
        input.autoMerge
          ? 'AI が自動で対応できると判断しました。条件がそろえば AI が merge します。'
          : 'AI が自動で対応できると判断しました。PR は人が確認してから merge します。',
        input.reason ? `判定の理由: ${clean(input.reason)}` : '',
        input.limitMinutes
          ? `推奨の上限時間: ${input.limitMinutes + (input.relayMinutes ?? 0)} 分${limitBreakdown(input.limitMinutes, input.relayMinutes)}`
          : '',
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'judged':
      body = [
        '**Ready_Eng にしました**',
        '',
        input.reason ? `判定の理由: ${clean(input.reason)}` : '',
        input.limitMinutes
          ? `推奨の上限時間: ${input.limitMinutes + (input.relayMinutes ?? 0)} 分${limitBreakdown(input.limitMinutes, input.relayMinutes)}`
          : '',
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'started':
      body = [
        '**実装を始めました**',
        '',
        input.reason ? `判定の理由: ${clean(input.reason)}` : '',
        input.limitMinutes
          ? `上限時間: ${input.limitMinutes + (input.relayMinutes ?? 0)} 分${limitBreakdown(input.limitMinutes, input.relayMinutes)}`
          : '',
        branch,
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'needs-review': {
      if (!input.reason && !input.decisions?.length && !input.reviewPoints?.length)
        throw new Error('needs-review requires a reason, review points or decisions')
      body = [
        '**確認をお願いします**',
        prs ? `PR: ${prs}` : '',
        input.reason ? `理由: ${clean(input.reason)}` : '',
        list('確認してほしい点', input.reviewPoints),
        list('AI が決めた点', input.decisions),
      ]
        .filter(Boolean)
        .join('\n\n')
      break
    }
    case 'partial-merge':
      body = `**一部だけ merge しました**\n\nmerge 済み: ${input.mergedPrs?.map(link).join(', ')}\nmerge できなかった PR: ${input.unmergedPrs?.map((p) => `${link(p)}（${clean(p.why)}）`).join(', ')}`
      break
    case 'ai-merged':
      body = [
        '**merge しました。動作確認をお願いします**',
        '',
        prs ? `PR: ${prs}` : '',
        input.summary ? `変更の要約: ${clean(input.summary)}` : '',
        TESTING_NEXT,
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'human-merged':
      body = `PR ${prs} が merge されたので Testing にしました。動作確認をお願いします。${TESTING_NEXT}`
      break
    case 'failed':
      body = [
        '**失敗しました**',
        '',
        input.reason ? `理由: ${clean(input.reason)}` : '',
        branch ? `${branch}（${input.pushed ? 'push 済み' : 'push できていません'}）` : '',
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'stalled':
      body = `**作業が進んでいません**${input.reason ? `\n\n理由: ${clean(input.reason)}` : ''}\n\n経過時間: ${input.elapsedMinutes} 分 / 上限時間: ${(input.limitMinutes ?? 0) + (input.relayMinutes ?? 0)} 分${limitBreakdown(input.limitMinutes ?? 0, input.relayMinutes)}`
      break
    case 'needs-base': {
      const labels = (input.candidates ?? []).map((c) => `\`base:${clean(c)}\``)
      const pick = clean(input.pick ?? STATUS.ready)
      // auto-ready の拾う元はラベルだけで拾い直す。そうでない拾う元は、人が pick に戻すまで待つ
      const next =
        input.autoReadySource === true
          ? 'ラベルを付けると、その向き先で自動で進めます。'
          : input.pick !== undefined
            ? `ラベルを付けたあと ${pick} に戻すと、その向き先で進めます。`
            : ''
      const fallback =
        input.fallbacks && input.fallbacks.length > 1
          ? input.fallbacks.map((f) => `${clean(f.repo)} は ${clean(f.branch)}`).join('、')
          : clean(input.fallback ?? '')
      body = `向き先のブランチを決められませんでした${input.why ? `（${clean(input.why)}）` : ''}。${labels.join(' か ')} の${labels.length === 2 ? 'どちら' : 'いずれ'}かのラベルを付けてください。${next}ラベルを付けずに ${pick} に戻すと ${fallback} で進めます。`
      break
    }
  }
  if (event === 'ai-merged' || event === 'human-merged') {
    const back = [
      ...(input.backPrs ?? []).map((p) => `${clean(p.repo)} へ取り込む PR: ${clean(p.url)}`),
      ...(input.backFailures ?? []).map((f) => `${clean(f.repo)} へ取り込む PR を作れませんでした: ${clean(f.why)}`),
    ]
    if (back.length) body += `\n\n${back.join('\n')}`
  }
  if (event === 'ai-merged' || event === 'partial-merge') {
    const decisions = list('AI が決めた点', input.decisions)
    if (decisions) body += `\n\n${decisions}`
  }
  return { status, body: `${body}\n\n<!-- orca-auto:${status}:${generation}:${event} -->` }
}
