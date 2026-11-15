import { STATUS, STATUS_LABELS } from './status.ts'

export type AutoEvent =
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
  branch?: string
  prs?: Pr[]
  decisions?: string[]
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
const link = (p: Pr): string => `[${clean(p.repo)}#${p.number}](${clean(p.url)})`
export const statusOfEvent = (event: AutoEvent): string =>
  ({
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
  const branch = input.branch ? `ブランチ: \`${clean(input.branch)}\`` : ''
  let body: string
  switch (event) {
    case 'judged':
      body = [
        '**Ready_Eng にしました**',
        '',
        input.reason ? `判定の理由: ${clean(input.reason)}` : '',
        input.limitMinutes ? `推奨の上限時間: ${input.limitMinutes} 分` : '',
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'started':
      body = [
        '**実装を始めました**',
        '',
        input.reason ? `判定の理由: ${clean(input.reason)}` : '',
        input.limitMinutes ? `上限時間: ${input.limitMinutes} 分` : '',
        branch,
      ]
        .filter((line, i) => line !== '' || i === 1)
        .join('\n')
      break
    case 'needs-review': {
      if (!input.reason && !input.decisions?.length) throw new Error('needs-review requires a reason or decisions')
      body = [
        '**確認をお願いします**',
        prs ? `PR: ${prs}` : '',
        input.reason ? `理由: ${clean(input.reason)}` : '',
        input.decisions?.length ? `AI が決めた点:\n${input.decisions.map((d) => `- ${clean(d)}`).join('\n')}` : '',
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
      body = `**作業が進んでいません**${input.reason ? `\n\n理由: ${clean(input.reason)}` : ''}\n\n経過時間: ${input.elapsedMinutes} 分 / 上限時間: ${input.limitMinutes} 分`
      break
  }
  return { status, body: `${body}\n\n<!-- orca-auto:${status}:${generation}:${event} -->` }
}
