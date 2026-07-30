# cfork - fork the conversation into a new cmux pane

Immediately run the following in a single bash call (replace `right` with the
argument's direction, if given):

```bash
S=$(cmux new-split right | awk '{print $2}') && cmux send --surface "$S" "claude --continue --fork-session\n"
```

No polling, Trust detection, or launch confirmation needed. Report the result to the
user in one line. Respond to the user in Japanese.
