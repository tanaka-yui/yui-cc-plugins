// 判定・待機・再起動に使う定数。値の根拠は docs/spike-findings.md と設計書を参照。

// limit の判定に使う、画面末尾の空でない行数。古い limit 表示を拾わないよう末尾だけを見る
export const LIMIT_TAIL_LINES = 15

// Claude: "You've hit your session limit · resets 5:10pm (Asia/Tokyo)"。解除時刻は無いこともある。
// "usage limit" は Codex の文言なので除く
export const CLAUDE_LIMIT_PATTERN =
  /You['’]ve hit your (?!usage limit)(\S+(?: \S+)?) limit(?:\s*[·•]\s*resets\s+([A-Za-z]{3}\s+)?(\d{1,2}(?::\d{2})?\s*[ap]m))?/gi

// Codex: "You've hit your usage limit. ... or try again at Nov 13, 2026 3:45 PM."
export const CODEX_LIMIT_PATTERN = /You['’]ve hit your usage limit(?: for ([^\s.,]+(?:\.[^\s.,]+)*))?\./gi
export const CODEX_RESET_PATTERN = /try again at\s+((?:[A-Za-z]{3} \d{1,2}, \d{4} )?\d{1,2}:\d{2}\s*[AP]M)/i

// 解除時刻を読めなかったときに、そのアカウントを候補から外しておく時間
export const UNKNOWN_RESET_COOLDOWN_MS = 30 * 60_000
// 解除時刻ちょうどではまだ弾かれることがあるので足す余裕
export const RESET_GRACE_MS = 60_000
