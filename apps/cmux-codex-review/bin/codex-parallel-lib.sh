#!/usr/bin/env bash
# codex-parallel-lib.sh — codex に spawn_agent で並列作業させるディレクティブを組み立てる。
#
# cmux-codex-exec / cmux-codex-review の両プラグインに**同一内容のコピー**として置く。
# 乖離は apps/cmux-codex-review/test/test-cmux-codex-wait.sh の W8 が検出する。
#
# 提供する関数:
#   list_codex_agent_types                   .codex/agents/*.toml を候補行として列挙
#   build_parallel_directive <max> <phases>  プロンプトへ連結するディレクティブを出力
#
# 呼び出し側は set -euo pipefail で動くため、この中でパイプラインの失敗を漏らさないこと
# （grep が no-match で 1 を返すと pipefail + set -e で呼び出し元ごと落ちる）。

# .codex/agents/*.toml から agent_type 候補を "- <stem> — <description>" 形式で列挙する。
# agent_type 名はファイル名 stem。description は toml の description = "..." の 1 行目。
# プロンプトはペインのシェルで再パースされるため、stem は安全な文字だけのものに限る。
list_codex_agent_types() {
  local f stem desc line
  [[ -d .codex/agents ]] || return 0
  for f in .codex/agents/*.toml; do
    [[ -f "$f" && -r "$f" ]] || continue
    stem=$(basename "$f" .toml)
    [[ "$stem" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    desc=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*description[[:space:]]*=[[:space:]]*(.*)$ ]]; then
        desc="${BASH_REMATCH[1]}"
        # description = """ で始まる複数行形式は 1 行目に本文が無いので名前だけにする
        [[ "$desc" == '"""' ]] && desc=""
        desc="${desc#\"}"
        desc="${desc%\"}"
        break
      fi
    done < "$f"
    if [[ -n "$desc" ]]; then
      printf -- '- %s — %s\n' "$stem" "$desc"
    else
      printf -- '- %s\n' "$stem"
    fi
  done
  return 0
}

# 並列実行ディレクティブ本文を出力する。
#   $1: 同時実行の上限（整数）
#   $2: プラグイン固有のフェーズ指示（複数行テキスト）
build_parallel_directive() {
  local max="$1" phases="$2" types agent_block
  types=$(list_codex_agent_types)
  if [[ -n "$types" ]]; then
    agent_block="利用可能な agent_type:
$types
適切なものが無ければ agent_type は省略してよい。"
  else
    agent_block="このリポジトリには agent_type の定義が無い。agent_type は省略して spawn せよ。"
  fi
  printf '%s' "

## 並列実行（必須）

独立して進められる作業が2件以上あるときは、必ず spawn_agent で子エージェントを起動して
並列に進め、wait_agent で結果を回収せよ。逐次で済ませてはならない。
同時に走らせる子エージェントは最大 ${max} 体まで。
ただし、下記のフェーズ指示で逐次と明示された作業はこの原則より優先し、必ず親エージェントが逐次で行え。

${phases}

${agent_block}

最後に、次の表で並列実行サマリーを必ず提示せよ:
| task_name | agent_type | 担当 | 結果 |
|---|---|---|---|
"
}
