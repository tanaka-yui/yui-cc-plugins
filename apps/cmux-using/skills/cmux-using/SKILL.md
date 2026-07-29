---
name: cmux-using
description: "cmux ターミナル内での操作スキル。ペイン分割、サブエージェント起動・監視・結果回収、コマンド送信、画面読み取り、通知に使用。CMUX_* 環境変数が存在する場合にトリガーされる。"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# Using cmux

cmux is a terminal multiplexer. Pane splitting, command dispatch, and screen reading
are controlled via the CLI.
If the `CMUX_SOCKET_PATH` environment variable is present, you are running inside cmux.

## Quick Orientation

```bash
cmux identify                    # Check your own workspace/surface
cmux list-workspaces             # List all workspaces
cmux tree                        # Show topology (hierarchical structure)
```

Resources are referenced with short refs: `window:1`, `workspace:2`, `pane:3`, `surface:4`.
`--id-format uuids` can also output UUID-format identifiers.

> **Note**: Sending multiple lines with `send` requires `send-key return`. See
> "Newline Rules for send" for details.

## Basic Operations

| Operation | Command |
|------|---------|
| Pane split | `cmux new-split right` (left/up/down also work) |
| New workspace | `cmux new-workspace --cwd $(pwd)` |
| Command dispatch | `cmux send --surface surface:N "command\n"` |
| Key dispatch | `cmux send-key --surface surface:N return` / `ctrl+c` / `ctrl+d` |
| Screen read | `cmux read-screen --surface surface:N [--scrollback]` |
| Close surface/workspace | `cmux close-surface` / `cmux close-workspace` |
| Listing | `cmux list-panes` / `cmux list-pane-surfaces` |

## Newline Rules for send

**This is the single most important rule.**

### Single-line commands: `\n` works

```bash
cmux send --surface surface:1 "echo hello\n"
```

The trailing `\n` acts as the Enter key.

### Multi-line text: `send-key return` is required

`\n` is not sent as a line break. Send each line individually and use `send-key return`
between lines.

```bash
# Correct approach
cmux send --surface surface:1 "line 1"
cmux send-key --surface surface:1 return
cmux send --surface surface:1 "line 2"
cmux send-key --surface surface:1 return

# Wrong — \n mid-string does not create a line break
cmux send --surface surface:1 "line 1\nline 2\n"
```

**Rule**: only a single trailing `\n` acts as Enter. Inserting `\n` in the middle of a
string does not create a line break.

## Sending Control Keys

Control keys such as process interruption (Ctrl+C) must be sent with **`send-key`**.
`send` cannot send them.

```bash
# Correct approach
cmux send-key --surface surface:N ctrl+c

# Wrong — sends the literal text only
cmux send --surface surface:N "C-c"
cmux send --surface surface:N "\x03"
cmux send-key --surface surface:N "C-c"   # → Unknown key error
```

Key names include `ctrl+c`, `ctrl+d`, `ctrl+z`, `return`, `tab`, `escape`, etc. Check
`send-key --help` for the full list.

## Cross-Workspace Operation Caveat (Important)

When operating on a surface in a different workspace, **use `--workspace`, not
`--surface`**.

```bash
# Correct approach — specify --workspace (auto-resolves to the focused surface)
cmux send --workspace workspace:N "command\n"
cmux read-screen --workspace workspace:N
cmux send-key --workspace workspace:N return

# Wrong — specifying a surface in another workspace via --surface
cmux send --surface surface:S "command\n"        # → "Surface is not a terminal" error
cmux read-screen --surface surface:S             # → same as above
```

**Reason**: `--surface` is only valid for a surface in the same workspace as the
caller. Specifying a surface in another workspace causes the CLI to return a
"Surface is not a terminal" error. `--workspace` auto-resolves to the workspace's
focused surface and works correctly across workspaces.

## Pane Reuse Principle

Before creating a new pane/workspace, look for an idle pane the user has already
cleared and reuse it.

```bash
cmux list-pane-surfaces                          # List all surfaces
screen=$(cmux read-screen --surface surface:N)   # Check each surface's state
# Shell prompt only ($ or ❯) → idle → reusable
```

If no idle pane exists, create one normally with `new-split` / `new-workspace`.

## Sub-Agent Operation Pattern

The end-to-end procedure for launching a sub-agent, delegating a task, and collecting
the result.

### Choosing a Placement Method

| Method | Advantage | Caveat |
|------|------|------|
| **Same workspace** (`new-split`) | Avoids the PTY lazy-init issue; can be operated directly via `--surface` | If the layout breaks, repair it with `cmux-grid` |
| **Separate workspace** (`new-workspace`) | Can be closed all at once with `close-workspace`; `rename-workspace` makes it easy to identify | Subject to the PTY lazy-init issue (see below) |

### Step 1a: Place in the Same Workspace (Recommended)

```bash
SURF=$(cmux new-split right | awk '{print $2}')
cmux rename-tab --surface $SURF "Researcher-1"
```

### Step 1b: Place in a Separate Workspace

```bash
WS=$(cmux new-workspace --cwd $(pwd) | awk '{print $2}')
cmux rename-workspace --workspace $WS "Researcher-1"
```

> **Note**: Due to the PTY lazy-init issue (see below), the workspace may need to be
> displayed once in the GUI.

### Step 2: Launch Claude Code

```bash
cmux send --workspace $WS "claude --dangerously-skip-permissions\n"
```

> Use `--dangerously-skip-permissions` only for trusted tasks.

### Step 3: Detect Trust Prompt → Approve

A trust confirmation prompt may appear right after launch. Poll with `read-screen`,
and approve once you detect "trust" or "Yes, I trust":

```bash
screen=$(cmux read-screen --workspace $WS)
# "trust" detected → approve
cmux send-key --workspace $WS return
```

### Step 4: Detect Launch Completion

Poll with `read-screen --workspace $WS` until the `❯` prompt appears.

### Step 5: Send the Prompt

```bash
# Single line
cmux send --workspace $WS "instruction text\n"
# The label is shown to the user in the sidebar — write it in Japanese (see Output Language)
cmux set-status $WS "<status label>" --icon hammer

# Multi-line (use send-key return for line breaks)
cmux send --workspace $WS "line 1 instruction"
cmux send-key --workspace $WS return
cmux send --workspace $WS "line 2 instruction"
cmux send-key --workspace $WS return
```

### Step 6: Detect Completion

Poll `read-screen --workspace $WS` to detect the `❯` prompt reappearing.

### Step 7: Result Collection & Cleanup

```bash
cmux clear-status $WS                                      # clear the status
result=$(cmux read-screen --workspace $WS --scrollback)  # get full output

# Cleanup: exit Claude → close the pane
cmux send --workspace $WS "/exit\n"
sleep 2
cmux close-workspace --workspace $WS                      # close the whole workspace
```

> **Important**: `/exit` alone only terminates the Claude process; the pane
> (surface) is left behind. Always close the pane too with `close-workspace` (or
> `close-surface`). The `sleep 2` waits for `/exit` to finish processing.

## PTY Lazy-Init Issue in new-workspace (Issue #1472)

The terminal PTY of a workspace created with `cmux new-workspace` **does not start
until it has been displayed once in the GUI**.
The `select-workspace` API alone is not enough; GUI rendering (SwiftUI rendering) is
required.

### Symptoms

- `cmux send --surface surface:N` → returns OK but the command is not executed (stays queued)
- `cmux read-screen --surface surface:N` → `Surface is not a terminal` error
- Socket API `surface.send_text` → `queued: true` but not delivered
- Socket API `surface.read_text` → `Terminal surface not found`

### Workaround: AppleScript Menu Click

Requires macOS Accessibility permission (System Settings → Privacy & Security →
Accessibility).

> **Note**: `"View"` and `"Workspace $WS_INDEX"` below are placeholders for the menu
> bar item / menu item labels. They are **runtime match keys passed to System
> Events**, not prose — they must be replaced with the **exact strings your own cmux
> app's menu bar actually shows**, which are OS/app-locale dependent (e.g. Japanese
> on a Japanese-locale system). Using these English placeholders verbatim on a
> non-English-locale system will fail with `Can't get menu bar item "View"`. See
> `references/guide-ja.md` for the Japanese-locale label values used in this project.

```bash
# Force GUI display after creating the workspace
WS=$(cmux new-workspace --cwd $(pwd) | awk '{print $2}')

# Get the workspace index
WS_INDEX=$(cmux tree --json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for w in data['windows']:
    for ws in w['workspaces']:
        if ws['ref'] == '$WS':
            print(ws['index'] + 1)")

# Click the menu via AppleScript → PTY init
# NOTE: "View" / "Workspace $WS_INDEX" are placeholders — see the note above for the actual labels
osascript -e "
tell application \"System Events\"
    tell process \"cmux\"
        click menu item \"Workspace $WS_INDEX\" of menu 1 of menu bar item \"View\" of menu bar 1
    end tell
end tell"
sleep 2

# Return to the original workspace
ORIG_INDEX=1  # index+1 of the original workspace
osascript -e "
tell application \"System Events\"
    tell process \"cmux\"
        click menu item \"Workspace $ORIG_INDEX\" of menu 1 of menu bar item \"View\" of menu bar 1
    end tell
end tell"
```

### Note: Socket API Fallback

The socket API `surface.send_text` / `surface.read_text` may **silently fall back to
the caller's surface** when the target surface's PTY is uninitialized. Always check
the response's `surface_ref` to verify the message was actually sent to the intended
surface.

## read-screen Troubleshooting

| Problem | Fix |
|------|------|
| Output is empty / stale | Run `cmux refresh-surfaces`, then re-read |
| Long output gets truncated | Add `--scrollback` |
| Want only a specific number of lines | Specify with `--lines N` |
| Surface not found | Re-check refs with `cmux list-pane-surfaces` |
| `Surface is not a terminal` | PTY lazy-init issue. See the workaround above |

If `read-screen` results look wrong, try `cmux refresh-surfaces` followed by a re-read.

## Monitoring Long-Running Processes

Isolate long-running processes such as dev servers or builds in a dedicated pane, and
monitor them periodically with `read-screen`.

```bash
cmux new-split right              # → surface:N
cmux send --surface surface:N "npm run dev\n"
# Poll for keywords such as "ready"
screen=$(cmux read-screen --surface surface:N)
```

## Notifications

```bash
# In-app notification (pane highlight, sidebar badge. Cmd+Shift+U to navigate)
# The title/body are shown to the user — write them in Japanese (see Output Language)
cmux notify --title "<title>" --body "<body>"

# macOS Notification Center (with sound, shown even while using another app)
# The notification text is shown to the user — write it in Japanese (see Output Language)
osascript -e 'display notification "<message>" with title "Claude" sound name "Glass"'
```

When to use which: to grab attention within cmux → `cmux notify`; when the user is
in another app → `osascript`.

## Status & Progress Display

```bash
# The label is shown to the user in the sidebar — write it in Japanese (see Output Language)
cmux set-status mykey "<status label>" --icon hammer --color "#0099ff"
cmux clear-status mykey
# The label is shown to the user — write it in Japanese (see Output Language)
cmux set-progress 0.5 --label "<progress label>"                # progress bar (0.0-1.0)
cmux clear-progress
```

## Browser

cmux also has browser automation features. See `cmux browser --help` for details.
`cmux new-pane --type browser --url <url>` creates a browser pane.

## Environment Variables

| Variable | Description |
|------|------|
| `CMUX_SOCKET_PATH` | Path to the cmux socket. If present, running inside cmux |
| `CMUX_WORKSPACE_ID` | Current workspace ID |
| `CMUX_SURFACE_ID` | Current surface ID |

## Common Mistakes

| Mistake | Correct approach |
|------|-----------|
| Sending multiple lines with `send "line1\nline2\n"` | Send each line individually with `send`, using `send-key return` between lines |
| Specifying a surface by UUID | Use short refs: `surface:1`, `pane:2` |
| Leaving a broken layout in the same workspace unfixed | Align it with `cmux-grid`, or place it in a separate workspace |
| Giving up when `read-screen` returns empty | Run `refresh-surfaces`, then retry |
| Missing the Trust prompt and hanging | Poll with `read-screen` after launch to detect it |
| Operating on another workspace with `--surface` | Use `--workspace` (see Cross-Workspace Operation Caveat) |
| Sending Ctrl+C via `send "C-c"` or `send "\x03"` | Use `send-key ctrl+c` (see Sending Control Keys) |
| Creating a new split when an idle pane already exists | Find and reuse an idle pane with `list-pane-surfaces` + `read-screen` |
| Not naming the workspace | Give it a name indicating its purpose with `rename-workspace` |
| Assuming `/exit` alone completes cleanup | `/exit` → `sleep 2` → close the pane too with `close-workspace` / `close-surface` |

## Command Quick Reference

| Command | Description |
|---------|------|
| `identify` / `tree` | Environment info / topology display |
| `list-workspaces` / `list-panes` / `list-pane-surfaces` | Listing |
| `new-workspace` / `new-split <dir>` | Create a workspace/pane |
| `send` / `send-key` / `read-screen` | I/O operations |
| `refresh-surfaces` | Force-refresh the screen buffer |
| `close-surface` / `close-workspace` | Terminate resources |
| `select-workspace` / `rename-workspace` / `rename-tab` | Select / rename |
| `cmux-grid` / `cmux-grid 2x3` | Align panes into a grid layout |
| `notify` / `set-status` / `set-progress` | Notifications, status, progress |
| `wait-for` | Wait for a signal |
