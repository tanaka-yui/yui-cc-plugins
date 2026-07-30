Immediately run the following Bash command exactly once. If the argument $ARGUMENTS is given, use it as the split direction; otherwise default to right.

```bash
DIR="${ARGUMENTS:-right}" && S=$(cmux new-split "$DIR" | awk '{print $2}') && cmux send --surface "$S" "claude --continue --fork-session
"
```

No polling needed. Report the result to the user in one line stating the new surface
($S) and the split direction ($DIR). Respond to the user in Japanese.
