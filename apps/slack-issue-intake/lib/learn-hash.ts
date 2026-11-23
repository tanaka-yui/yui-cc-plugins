import { createHash } from 'node:crypto'

// 学びの知らせと依頼を、人が Slack で見た中身に結びつけるハッシュ（sha256 の 16 進）。
// learnItemHash は orca-team-dispatch-task の lib/auto-learn.ts の同名の関数と同じ値になる
// （決まった形は JSON.stringify([kind, ruleId, direction, text, body])。scripts/check-shared-contracts.mjs が fixture で確かめる）

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

type HashedItem = { kind: string; ruleId: string; direction: string; text: string; body: string }
export const learnItemHash = (item: HashedItem): string =>
  sha256(JSON.stringify([item.kind, item.ruleId, item.direction, item.text, item.body]))

// 投稿した知らせの指紋。スレッドの返信を読むときに、今の notices.json の同じ id の知らせが投稿したものと同じかを見る
type FingerprintedNotice = {
  id: number
  repo: string
  at: string
  items: Array<HashedItem & { n: number; evidence: string[]; url: string }>
}
export const noticeFingerprint = (notice: FingerprintedNotice): string =>
  sha256(
    JSON.stringify([
      notice.id,
      notice.repo,
      notice.at,
      notice.items.map((item) => [
        item.n,
        item.kind,
        item.ruleId,
        item.direction,
        item.text,
        item.body,
        item.evidence,
        item.url,
      ]),
    ]),
  )
