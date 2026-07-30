# cmux quick reference

First run `cmux identify` to check the current environment, and show the result.

Then help the user with their operation using the quick reference below.

---

## Basic Operations

| Operation | Command |
|------|---------|
| Check environment | `cmux identify` |
| List workspaces | `cmux list-workspaces` |
| Pane split (right) | `cmux new-split right` |
| Pane split (down) | `cmux new-split down` |
| Screen read | `cmux read-screen --surface surface:N` |
| Including scrollback | `cmux read-screen --surface surface:N --scrollback` |
| Send text | `cmux send --surface surface:N "text\n"` |
| Send key | `cmux send-key --surface surface:N return` |
| Close surface | `cmux close-surface --surface surface:N` |
| Notification | `cmux notify --title "<title>" --body "<body>"` |

## Newline Rules for send (important)

**Single line**: can be sent with a trailing `\n`.

```bash
cmux send --surface surface:N "echo hello\n"
```

**Multiple lines cannot be sent with `\n`**. Send each line individually with
`send-key return`:

```bash
cmux send --surface surface:N "echo line1"
cmux send-key --surface surface:N return
cmux send --surface surface:N "echo line2"
cmux send-key --surface surface:N return
```

## Minimal Sub-Agent Launch Procedure

1. **Pane split**: `cmux new-split right` → get surface:N
2. **Launch Claude**: `cmux send --surface surface:N "claude --dangerously-skip-permissions\n"`
3. **Trust detection**: poll `cmux read-screen --surface surface:N`, and when the trust prompt appears, send `cmux send --surface surface:N "trust\n"`
4. **Launch confirmation**: use `read-screen` to detect that Claude Code has finished launching (`$` or the input prompt `>`)
5. **Send the prompt**: `cmux send --surface surface:N "<instructions>"` + `cmux send-key --surface surface:N return`
6. **Wait for completion**: poll `read-screen` to detect the completion marker
7. **Result collection**: `cmux read-screen --surface surface:N --scrollback`

## Troubleshooting

| Symptom | Fix |
|------|------|
| read-screen is empty | Run `cmux refresh-surfaces`, then retry |
| Surface not found | Check the latest ref with `cmux list-pane-surfaces` |
| Multi-line text gets garbled | Switch to `send` + `send-key return` |
| Operating on the wrong target | Re-check caller/focused with `cmux identify` |

## Environment Variables

| Variable | Purpose |
|------|------|
| `CMUX_SOCKET_PATH` | cmux socket path (auto-set inside cmux) |
| `CMUX_WORKSPACE_ID` | Current workspace UUID |
| `CMUX_SURFACE_ID` | Current surface UUID |

See the cmux-using skill (SKILL.md) for details.
