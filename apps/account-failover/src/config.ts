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

// resume で引き継ぐ起動フラグ。ps のコマンドラインは引数の境界が失われ、prompt など空白を含む引数を
// 復元できないため、意味の分かるフラグだけを残す
export const CLAUDE_VALUE_FLAGS = ['--model', '--effort', '--permission-mode']
export const CLAUDE_SWITCH_FLAGS = ['--dangerously-skip-permissions']
export const CODEX_VALUE_FLAGS = ['-m', '--model', '-c', '--config', '-s', '--sandbox', '-a', '--ask-for-approval']
export const CODEX_SWITCH_FLAGS = ['--full-auto', '--dangerously-bypass-approvals-and-sandbox']
// Orca の codex シェル関数が毎回付け直すもの。引き継ぐと二重になる
export const CODEX_WRAPPER_CONFIG_PREFIX = 'shell_environment_policy.'

// resume した直後にエージェントへ送る指示
export const RESUME_PROMPT =
  'Your previous turn was interrupted by a usage limit. The session has been resumed on another account. Continue the task from where you left off.'

// 同じペインでの乗り換えの上限。超えたら通知して止める（乗り換え先でもすぐ limit になる場合の無限ループ防止）
export const LOOP_WINDOW_MS = 60 * 60_000
export const MAX_FAILOVERS_PER_WINDOW = 3
// 古いプロセスの終了待ち
export const KILL_POLL_MS = 200
export const KILL_TIMEOUT_MS = 10_000
// プロセス終了後、シェルがプロンプトに戻るまでの待ち
export const SHELL_SETTLE_MS = 1_000
// resume コマンドを送ってから、確認画面で止まっていないかを見るまでの待ち
export const RESUME_CHECK_MS = 20_000
// 乗り換え先のアカウントで初めて開いたときに出て、人の判断が要る確認画面
export const BLOCKING_DIALOG_PATTERNS = [/Is this a project you created or one you trust/, /Hooks need review/]
