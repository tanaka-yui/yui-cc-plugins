// ステータスラベル（slack-issue-intake と共通。spec 5.1）。プラグインは別々に入るので、共有のパッケージは作らず
// 同じ値を写して持つ。2 つの一致はルートの scripts/check-shared-contracts.mjs が確かめる。
// 並びは、2 つ以上付いているときに使う優先順。slug は Issue のコメントのマーカーに書く形
export const STATUS_LABELS: ReadonlyArray<{ name: string; slug: string; color: string; description: string }> = [
  { name: 'Done', slug: 'done', color: '0e8a16', description: '完了' },
  { name: 'Failed', slug: 'failed', color: 'b60205', description: 'AI が失敗した' },
  { name: 'In review', slug: 'in-review', color: 'fbca04', description: 'PR を出して人の判断待ち' },
  { name: 'Ready_Eng', slug: 'ready-eng', color: '5319e7', description: 'エンジニアが対応する' },
  { name: 'In progress', slug: 'in-progress', color: '1d76db', description: 'AI が実装中' },
  { name: 'Pending', slug: 'pending', color: 'c2e0c6', description: '後回し' },
  { name: 'Ready', slug: 'ready', color: '0e8a16', description: 'やる。AI が拾う対象' },
  { name: 'Backlog', slug: 'backlog', color: 'ededed', description: '起票直後。人の判断待ち' },
]
export const STATUS = {
  backlog: 'Backlog',
  ready: 'Ready',
  readyEng: 'Ready_Eng',
  inProgress: 'In progress',
  inReview: 'In review',
  pending: 'Pending',
  done: 'Done',
  failed: 'Failed',
} as const
// 3.10 までの issue モードが使っていたラベル。すでに付いている Issue を拾わないよう、検索の除外に残す
export const LEGACY_DISPATCH_LABELS: readonly string[] = ['dispatch/in-progress', 'dispatch/done', 'dispatch/failed']
// --issue の検索で除外するもの。Ready は人が「やる」と決めた印なので除外しない
export const ISSUE_EXCLUDED_LABELS: readonly string[] = [
  ...STATUS_LABELS.map((l) => l.name).filter((name) => name !== STATUS.ready),
  ...LEGACY_DISPATCH_LABELS,
]
// gh の検索式。空白を含む名前（In progress など）があるので、すべて引用符で囲む
export const searchExclusion = (labels: readonly string[]): string => labels.map((name) => `-label:"${name}"`).join(' ')
