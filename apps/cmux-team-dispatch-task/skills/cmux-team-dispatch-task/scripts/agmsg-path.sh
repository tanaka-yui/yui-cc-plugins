#!/usr/bin/env bash
# agmsg-path.sh — agmsg の ready sentinel パスを組み立てる source 専用ヘルパー。
#
# agmsg 本体は ~/.agents/skills/agmsg/scripts/lib/actas-lock.sh:43-73 の
# _actas_lock_encode / agmsg_ready_path で [A-Za-z0-9._-] 以外を %XX へ変換した
# パスを作る。send-prompt.sh は長らく生連結しており、team 名に空白や非 ASCII が
# 入ると watcher が動いていても sentinel を見つけられなかった。
# 本ファイルはその規則を 1 箇所に置く send-prompt.sh 専用のヘルパーである。guard
# (ensure-agmsg-ready.sh) は --name を ^[A-Za-z0-9._-]+$ に値域検証済みでエンコードが
# 恒等写像になるため、本ファイルには依存しない。
# 上流の規則が変わっても検出できないので、追跡点として上記の行番号を残す。
#
# 提供関数:
#   agmsg_encode_component <s>              → %XX エンコード済み文字列
#   agmsg_ready_path <ready_dir> <t> <a>    → <ready_dir>/ready.<t>__<a>
#
# SKILL_DIR にも AGMSG_DIR にも依存しない純粋な文字列変換である。

agmsg_encode_component() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { for (n = 0; n < 256; n++) ord[sprintf("%c", n)] = n }
    {
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c ~ /[A-Za-z0-9._\-]/) printf "%s", c
        else printf "%%%02X", ord[c]
      }
    }
  '
}

agmsg_ready_path() {
  local dir="$1" team agent
  team="$(agmsg_encode_component "$2")"
  agent="$(agmsg_encode_component "$3")"
  printf '%s/ready.%s__%s' "$dir" "$team" "$agent"
}
