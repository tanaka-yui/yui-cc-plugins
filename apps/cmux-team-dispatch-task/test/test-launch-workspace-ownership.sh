#!/usr/bin/env bash
# launch-workspace.sh の「作成したリソースの所有権判定」の回帰テスト。
#
# 守っている不変条件:
#   OW1.  自分の ref が inventory 差分に含まれれば所有できる
#   OW2.  **同時に別 ref が増えていても所有できる**（並列ディスパッチの正常系）
#   OW3.  差分に無い ref は所有できない
#   OW4.  ref の書式が不正なら所有できない
#   OW5.  stdout が使えないとき、差分が唯一ならそれを回収できる（複数なら回収しない）
#   OW6.  暫定所有は before に無い ID に限る
#   OW7.  「追加はちょうど 1 件」を所有権の条件に戻していない
#
# OW2 が本体。旧実装は「追加はちょうど 1 件」を所有権の条件にしていたため、2 タスクを
# 同時に起動して workspace が 2 つ増えた瞬間に die し、しかも CREATED_WORKSPACE_ID を
# 立てる前だったので EXIT trap が自分の workspace を閉じられず孤児化した。並列ディスパッチは
# このプラグインの中核機能なので、常に固定する。
#
# ただし OW5 / OW6 を同時に満たす必要がある。追加件数は「所有権の条件」にはしないが、
# 「stdout が壊れたときの回収手段」としては手放せない（test-launch-workspace-layout.sh
# の L9-L12 が、解析不能・既存 ID を返す成功 payload でもリソースを閉じることを固定して
# いる）。所有は stdout ∈ 差分 で決め、それが使えないときだけ唯一の差分へ落とす。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
fail=0

bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

[[ -f "$LAUNCH" ]] || { echo "FAIL: launch-workspace.sh が無い: $LAUNCH"; exit 2; }

# 対象関数だけを取り出して評価する。スクリプト本体は source すると cmux を叩き始めるので、
# 関数定義の範囲を切り出して読み込む。
for fn in added_refs ref_was_added sole_added_ref provisional_ref; do
  SRC=$(awk -v f="$fn" '$0 ~ "^"f"\\(\\) \\{",/^\}/' "$LAUNCH")
  [[ -n "$SRC" ]] || { echo "FAIL: $fn() を抽出できない（関数名が変わった？）"; exit 2; }
  eval "$SRC"
done

BEFORE=$'workspace:1\nworkspace:6'

# OW1: 単独追加
AFTER=$'workspace:1\nworkspace:6\nworkspace:7'
if ref_was_added workspace 'workspace:7' "$BEFORE" "$AFTER"; then
  ok 'OW1: 単独で増えた自分の ref を所有できる'
else
  bad 'OW1: 単独追加を所有できない'
fi

# OW2: 並列追加（回帰の本体）— 自分 workspace:7 と他タスク workspace:8 が同時に増える
AFTER=$'workspace:1\nworkspace:6\nworkspace:7\nworkspace:8'
if ref_was_added workspace 'workspace:7' "$BEFORE" "$AFTER"; then
  ok 'OW2: 同時に別 workspace が増えても自分の ref を所有できる'
else
  bad 'OW2: 並列追加で所有権判定が失敗した（並列ディスパッチが壊れる）'
fi
# 相手側も同じ inventory で自分を所有できること（対称性）
if ref_was_added workspace 'workspace:8' "$BEFORE" "$AFTER"; then
  ok 'OW2b: 同時起動した他タスク側も自分の ref を所有できる'
else
  bad 'OW2b: 並列追加の対称性が壊れている'
fi

# OW3: 増えていない ref は所有できない
if ref_was_added workspace 'workspace:6' "$BEFORE" "$AFTER"; then
  bad 'OW3: 既存の ref を「新規作成した」と誤認した'
else
  ok 'OW3: 差分に無い ref は所有できない'
fi

# OW4: 書式不正
if ref_was_added workspace 'surface:7' "$BEFORE" "$AFTER"; then
  bad 'OW4: kind の違う ref を受理した'
else
  ok 'OW4: kind の違う ref を拒否する'
fi
if ref_was_added workspace 'workspace:abc' "$BEFORE" "$AFTER"; then
  bad 'OW4b: 書式不正な ref を受理した'
else
  ok 'OW4b: 書式不正な ref を拒否する'
fi

# surface 側も同じ関数で同じ性質を持つこと
S_BEFORE=$'surface:1'
S_AFTER=$'surface:1\nsurface:2\nsurface:3'
if ref_was_added surface 'surface:2' "$S_BEFORE" "$S_AFTER"; then
  ok 'OW4c: surface でも並列追加を所有できる'
else
  bad 'OW4c: surface 側の並列追加が失敗した'
fi

# OW5: stdout が使えないときの回収 — 差分が唯一ならそれを所有できる（L9-L12 の性質）
if got=$(sole_added_ref workspace "$BEFORE" $'workspace:1\nworkspace:6\nworkspace:9') \
   && [[ "$got" == 'workspace:9' ]]; then
  ok 'OW5: 差分が唯一なら stdout 不良でも回収対象を特定できる'
else
  bad "OW5: 唯一の差分を回収できない (got=${got:-<none>})"
fi
# 差分が複数のときは他人のリソースを掴む危険があるので回収しない
if sole_added_ref workspace "$BEFORE" $'workspace:1\nworkspace:6\nworkspace:9\nworkspace:10' >/dev/null; then
  bad 'OW5b: 差分が複数なのに回収対象を 1 つに決めてしまった'
else
  ok 'OW5b: 差分が複数なら回収せず（他人のリソースを閉じない）'
fi

# OW6: 暫定所有は「before に無い ID」に限ること（misleading stdout で既存を掴まない）
if provisional_ref workspace 'workspace:9' "$BEFORE"; then
  ok 'OW6: 新規 ID は暫定所有できる'
else
  bad 'OW6: 新規 ID を暫定所有できない（inventory 失敗時に孤児化する）'
fi
if provisional_ref workspace 'workspace:6' "$BEFORE"; then
  bad 'OW6b: 既存 ID を暫定所有した（他人のリソースを閉じうる）'
else
  ok 'OW6b: 既存 ID は暫定所有しない'
fi
if provisional_ref workspace '' "$BEFORE"; then
  bad 'OW6c: 空の ID を暫定所有した'
else
  ok 'OW6c: 解析不能な ID は暫定所有しない'
fi

# 旧実装の残骸が戻っていないこと
if grep -qE "(^|[^_])single_added_ref" "$LAUNCH"; then
  bad 'OW7: 「追加はちょうど 1 件」を所有権の条件にする実装が復活している'
else
  ok 'OW7: 所有権の条件に追加件数を使っていない'
fi

exit "$fail"
