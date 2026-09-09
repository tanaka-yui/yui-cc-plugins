#!/usr/bin/env bash
# config-lib.sh — 設定パスと値検証を 1 箇所に集める。source 専用。実行してはならない。
#
# ★ cmux 版との最大の差: **runner という次元が無い。**
#   cmux は `runners.json` に登録した runner 名を engine (claude|codex) へ写していた。
#   名前と engine を分けていたのは「同じ engine で別アカウントの runner」を持つためだが、
#   Orca にはそれが作れない（実測）:
#     - `worker-start` の flag に account 指定口が無い
#     - `account` 名前空間は `add` / `list` の 2 つだけで、active を選ぶコマンドが無い。
#       active は `account list` の `activeAccountIdsByRuntime` にランタイム単位で出るが、
#       書くのは GUI 側だけである
#   よって runner 名を作る動機が消え、**`--agent <id>` がそのまま runner 兼 engine**になる。
#   レジストリ (`runners.json`) は移植しない。
#
# source する側: config-edit.sh / config-resolve.sh / bin/orca-start.sh

dispatch_config_home() {
  printf '%s\n' "${ORCA_DISPATCH_CONFIG_HOME:-$HOME/.claude/config/orca-team-dispatch-task}"
}

dispatch_config_file() { printf '%s/config.json\n' "$(dispatch_config_home)"; }

dispatch_project_config_file() { printf '%s/.dispatch/config.json\n' "$1"; }

# ★ **「この版が知っているロール」と「今そのタスクで動くロール」は別。**
#   前者は設定できる集合であり、後者は review_mode が決める。混ぜると、review_mode=off の
#   間は design_review を設定できず、**on にする前に準備ができない**状態になる。
dispatch_all_role_names() { printf 'design\ndesign_review\n'; }

# $1=review_mode (既定 off)。dispatch が実際に起動するロールを返す。
dispatch_role_names() {
  printf 'design\n'
  [[ "${1:-off}" == on ]] && printf 'design_review\n'
  return 0
}

# ★ 既定は **off**。Stage A の利用者の挙動を変えないため。model / effort に自動既定を
#   持たせない判断（下記）と同じ理由で、頼まれていないロールを勝手に起こさない。
dispatch_default_review_mode() { printf 'off\n'; }
dispatch_valid_review_mode() { case "$1" in on|off) return 0 ;; *) return 1 ;; esac; }

# 空・前後の空白・シェルメタ文字・制御文字を拒否する。内部の空白は許容する。
# 前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ので、トリムせず弾く。
_dispatch_valid_shell_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  case "$v" in
    [[:space:]]*|*[[:space:]]) return 1 ;;
  esac
  case "$v" in
    *\'*|*\"*|*\`*|*\$*|*\\*|*!*) return 1 ;;
  esac
  case "$v" in
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

dispatch_valid_agent() { _dispatch_valid_shell_value "$1"; }
dispatch_valid_model() { _dispatch_valid_shell_value "$1"; }

# ★ **agent の allowlist は閉じない。**CLI schema が `--agent` の値として名指しするのは
#   claude と codex だけだが (`account add --agent claude|codex` / `worktree create
#   --agent codex` の例)、`worker-start` の注記は Cursor の model id にも触れている。
#   知らない値を弾くと Orca が agent を増やしたとき、ここを直すまで設定できなくなる。
#   知っているかどうかは **既定値を埋められるか**の判定にだけ使い、拒否には使わない。
dispatch_known_agent() { case "$1" in claude|codex) return 0 ;; *) return 1 ;; esac; }

# setup が候補として出す agent。allowlist ではない。1 行 1 候補、先頭が既定。
dispatch_agent_choices() { printf 'claude\ncodex\n'; }

dispatch_normalize_effort() { printf '%s\n' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; }

# ★ 知らない agent の effort は **検証できないので検証しない**（拒否もしない）。
#   呼び出し側は dispatch_known_agent で分岐し、未知なら警告して素通しする。
#   誤った値は Orca が worker-start で弾き、その失敗は resources KEPT として見える。
dispatch_valid_effort() {
  case "$2" in
    claude) case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac ;;
    codex)  case "$1" in minimal|low|medium|high|xhigh) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

# ★ **model と effort に自動既定を持たない。**設定されたときだけ渡す。
#   cmux 版が既定 model を持っていたのは、cmux が CLI を自分で起動するので必ず値が要ったため。
#   Orca は agent を自分で起動するので、`--model` を省けば Orca 側の既定が使われる。
#   ここで勝手に既定を入れると、未設定の利用者の挙動が黙って変わり、Orca の設定とも競合する。
#   したがって未設定 = flag を渡さない。agent だけは worker-start の必須なので claude を既定にする
#   （現行の `--agent claude` 決め打ちと同じ挙動を保つ）。
dispatch_default_agent() { printf 'claude\n'; }

# setup が model を尋ねるときの候補。**allowlist ではない** — 検証は
# dispatch_valid_model が行い、候補外の値も通る。1 行 1 候補。
dispatch_model_choices() {
  case "$1" in
    codex)  printf 'gpt-6-astra\n' ;;
    claude) printf 'opus[1m]\nsonnet\n' ;;
    *) ;;
  esac
}

# ★ **層をまたいだ agent と model の食い違いを塞ぐ。**global が agent=codex、
#   project が model=sonnet を持つと、フィールド単位の解決では codex + sonnet になる。
#   model の綴りから所属 agent が分かるものだけを判定し、分からない綴りには何も言わない
#   （allowlist ではないので、知らない model 名は通す）。
dispatch_model_agent() {
  case "$1" in
    opus|'opus[1m]'|sonnet|haiku|fable|claude-*) printf 'claude\n' ;;
    gpt-*|codex-*|o1*|o3*|o4*)                   printf 'codex\n'  ;;
    *) ;;
  esac
}

# setup が effort を尋ねるときの候補。未知の agent には候補が無い。
dispatch_effort_choices() {
  case "$1" in
    claude) printf 'xhigh\nhigh\nmedium\nlow\nmax\n' ;;
    codex)  printf 'xhigh\nhigh\nmedium\nlow\nminimal\n' ;;
    *) ;;
  esac
}
