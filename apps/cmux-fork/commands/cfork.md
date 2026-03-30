即座に以下の Bash コマンドを1回だけ実行してください。引数 $ARGUMENTS があれば分割方向に使い、なければ right をデフォルトにしてください。

```bash
DIR="${ARGUMENTS:-right}" && S=$(cmux new-split "$DIR" | awk '{print $2}') && cmux send --surface "$S" "claude --continue --fork-session
"
```

ポーリング不要。結果を「フォーク起動: $S (方向: $DIR)」の1行で報告してください。
