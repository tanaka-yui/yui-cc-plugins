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
}
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
    'needs-review': STATUS.inReview,
    'partial-merge': STATUS.inReview,
    'ai-merged': STATUS.done,
    'human-merged': STATUS.done,
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
        'AI が自動で対応できると判断しました。PR は人が確認してから merge します。',
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
        '**merge して完了にしました**',
        '',
        prs ? `PR: ${prs}` : '',
        input.summary ? `変更の要約: ${clean(input.summary)}` : '',
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'human-merged':
      body = `PR ${prs} が merge されたので Done にして閉じます。`
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
  }
  if (event === 'ai-merged' || event === 'partial-merge') {
    const decisions = list('AI が決めた点', input.decisions)
    if (decisions) body += `\n\n${decisions}`
  }
  return { status, body: `${body}\n\n<!-- orca-auto:${status}:${generation}:${event} -->` }
}
