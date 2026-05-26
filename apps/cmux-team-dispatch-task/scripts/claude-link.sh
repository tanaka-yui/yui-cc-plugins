#!/usr/bin/env bash
# claude-link: Share common Claude resources from a main ~/.claude into per-account
# config dirs (CLAUDE_CONFIG_DIR) via symlinks while keeping auth/sessions private.
set -euo pipefail
IFS=$'\n\t'

# --- Constants ----------------------------------------------------------------

DEFAULT_BASE_DIR="${HOME}/.claude-config"
DEFAULT_SOURCE_DIR="${HOME}/.claude"

# Always shared (skip if absent in source).
SHARE_ITEMS=(
  "skills"
  "plugins"
  "commands"
  "agents"
  "CLAUDE.md"
  "settings.json"
  "config"
  "keybindings.json"
  # Session continuity: shared so sessions/history can be inherited across accounts.
  "projects"
  "sessions"
  "todos"
  "history.jsonl"
  "tasks"
)

# Never touched (account-private). Defensive guard against accidental sharing.
PROTECTED_ITEMS=(
  ".claude.json"
  ".claude.json.backup"
  "settings.local.json"
  "backups"
  "cache"
  "shell-snapshots"
  "session-env"
  "paste-cache"
  "policy-limits.json"
  "statistics"
  "file-history"
  "debug"
  "ide"
)
# mcp-needs-auth-cache*.json is also protected (glob).

# --- Globals (set by parse_args / validate) -----------------------------------

ACCOUNT_NAME=""
BASE_DIR="$DEFAULT_BASE_DIR"
SOURCE_DIR="$DEFAULT_SOURCE_DIR"
DRY_RUN=0
SOURCE_DIR_REAL=""
ACCOUNT_DIR=""
ACCOUNT_DIR_REAL=""
BACKUP_TS=""
BACKUP_DIR=""

COUNT_LINK=0
COUNT_RELINK=0
COUNT_BACKUP=0
COUNT_SKIP_OK=0
COUNT_SKIP_NOSRC=0

# --- Logging ------------------------------------------------------------------

log_info() { printf '\033[34m[info]\033[0m %s\n' "$*" >&2; }
log_warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
log_err()  { printf '\033[31m[err ]\033[0m %s\n' "$*" >&2; }
die()      { log_err "$*"; exit 1; }

trap 'log_err "abort at line $LINENO"; exit 1' ERR

# --- Helpers ------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: claude-link <account-name> [options]

Shares common Claude resources from ~/.claude into per-account config dirs
via symlinks. Auth (.claude.json) and sessions/history remain account-private.

Options:
  --base-dir DIR     Parent dir for account configs (default: ~/.claude-config)
  --source DIR       Source of shared resources (default: realpath of ~/.claude)
  --dry-run          Show plan only, no changes
  -h, --help         Show this help

Always shared (skipped if absent in source):
  skills/  plugins/  commands/  agents/
  CLAUDE.md  settings.json  config/  keybindings.json
  projects/  sessions/  todos/  history.jsonl  tasks/

Never touched (account-private):
  .claude.json  .claude.json.backup  settings.local.json
  backups/  cache/  shell-snapshots/  session-env/  paste-cache/
  mcp-needs-auth-cache*.json  policy-limits.json
  statistics/  file-history/  debug/  ide/

Rollback (manual, after a run):
  cd ~/.claude-config/<account>
  rm skills plugins commands agents CLAUDE.md settings.json config keybindings.json \
     projects sessions todos history.jsonl tasks 2>/dev/null
  mv .pre-link-backup-<TS>/* .   # restore originals
  rmdir .pre-link-backup-<TS>
EOF
}

realpath_compat() {
  # macOS BSD readlink has no -f. Use python3 for portability.
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

is_protected() {
  local name="$1"
  local p
  for p in "${PROTECTED_ITEMS[@]}"; do
    [[ "$name" == "$p" ]] && return 0
  done
  case "$name" in
    mcp-needs-auth-cache*.json) return 0 ;;
  esac
  return 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --base-dir)
        [[ $# -ge 2 ]] || die "--base-dir requires an argument"
        BASE_DIR="$2"
        shift 2
        ;;
      --source)
        [[ $# -ge 2 ]] || die "--source requires an argument"
        SOURCE_DIR="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -*)
        die "unknown option: $1 (try --help)"
        ;;
      *)
        if [[ -z "$ACCOUNT_NAME" ]]; then
          ACCOUNT_NAME="$1"
          shift
        else
          die "unexpected argument: $1"
        fi
        ;;
    esac
  done

  [[ -n "$ACCOUNT_NAME" ]] || { usage; die "account-name is required"; }
  [[ "$ACCOUNT_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] \
    || die "invalid account name: '$ACCOUNT_NAME' (allowed: [A-Za-z0-9_.-]+)"
  [[ "$ACCOUNT_NAME" != "." && "$ACCOUNT_NAME" != ".." ]] \
    || die "invalid account name: '$ACCOUNT_NAME'"
}

validate_environment() {
  [[ -e "$SOURCE_DIR" ]] || die "source does not exist: $SOURCE_DIR"
  SOURCE_DIR_REAL="$(realpath_compat "$SOURCE_DIR")"
  [[ -d "$SOURCE_DIR_REAL" ]] || die "source is not a directory: $SOURCE_DIR_REAL"

  ACCOUNT_DIR="${BASE_DIR%/}/$ACCOUNT_NAME"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    mkdir -p "$ACCOUNT_DIR"
  fi

  if [[ -d "$ACCOUNT_DIR" ]]; then
    ACCOUNT_DIR_REAL="$(realpath_compat "$ACCOUNT_DIR")"
  else
    # dry-run with non-existing dir: synthesize a real-ish path for comparison.
    ACCOUNT_DIR_REAL="$(realpath_compat "$(dirname "$ACCOUNT_DIR")")/$(basename "$ACCOUNT_DIR")"
  fi

  [[ "$ACCOUNT_DIR_REAL" != "$SOURCE_DIR_REAL" ]] \
    || die "account dir equals source dir: $ACCOUNT_DIR_REAL"

  BACKUP_TS="$(date +%Y%m%d-%H%M%S)-$$"
  BACKUP_DIR="$ACCOUNT_DIR/.pre-link-backup-$BACKUP_TS"
}

# Lazily create backup dir on first need.
ensure_backup_dir() {
  if [[ ! -d "$BACKUP_DIR" ]]; then
    if [[ "$DRY_RUN" -eq 0 ]]; then
      mkdir -p "$BACKUP_DIR"
    fi
  fi
}

process_one_entry() {
  local name="$1"
  local src="$SOURCE_DIR_REAL/$name"
  local dst="$ACCOUNT_DIR/$name"

  if is_protected "$name"; then
    die "refusing to share protected item: $name (programmer error)"
  fi

  # Source missing -> skip.
  if [[ ! -e "$src" && ! -L "$src" ]]; then
    printf '[PLAN] %-12s %-22s : source does not exist\n' "SKIP-NOSRC" "$name"
    COUNT_SKIP_NOSRC=$((COUNT_SKIP_NOSRC + 1))
    return 0
  fi

  # Destination is a symlink.
  if [[ -L "$dst" ]]; then
    local current
    current="$(readlink "$dst")"
    local current_real=""
    if [[ -e "$dst" ]]; then
      current_real="$(realpath_compat "$dst")"
    fi
    if [[ "$current_real" == "$src" ]]; then
      printf '[PLAN] %-12s %-22s : already symlinked to source\n' "SKIP-OK" "$name"
      COUNT_SKIP_OK=$((COUNT_SKIP_OK + 1))
      return 0
    fi
    printf '[PLAN] %-12s %-22s : was -> %s, now -> %s\n' "RELINK" "$name" "$current" "$src"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      rm "$dst"
      ln -s "$src" "$dst"
    fi
    COUNT_RELINK=$((COUNT_RELINK + 1))
    return 0
  fi

  # Destination is a real file/dir.
  if [[ -e "$dst" ]]; then
    printf '[PLAN] %-12s %-22s : mv to %s ; ln -s %s\n' \
      "BACKUP+LINK" "$name" "$BACKUP_DIR/$name" "$src"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      ensure_backup_dir
      mv "$dst" "$BACKUP_DIR/$name"
      ln -s "$src" "$dst"
    fi
    COUNT_BACKUP=$((COUNT_BACKUP + 1))
    return 0
  fi

  # Destination absent.
  printf '[PLAN] %-12s %-22s : ln -s %s\n' "LINK" "$name" "$src"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ln -s "$src" "$dst"
  fi
  COUNT_LINK=$((COUNT_LINK + 1))
  return 0
}

emit_summary() {
  printf '\nSummary: %d linked, %d relinked, %d backed-up, %d skipped(ok), %d skipped(no-source)\n' \
    "$COUNT_LINK" "$COUNT_RELINK" "$COUNT_BACKUP" "$COUNT_SKIP_OK" "$COUNT_SKIP_NOSRC" >&2

  if [[ "$COUNT_BACKUP" -gt 0 && "$DRY_RUN" -eq 0 ]]; then
    log_info "originals backed up under: $BACKUP_DIR"
  fi
}

short_name_for() {
  # f-stack -> fstack, my-team -> myteam
  printf '%s' "$1" | tr -d '_-' | tr '[:upper:]' '[:lower:]'
}

emit_zshrc_snippet() {
  local short
  short="$(short_name_for "$ACCOUNT_NAME")"
  local prefix=""
  if [[ "$DRY_RUN" -eq 1 ]]; then
    prefix="# [dry-run] "
  fi
  cat <<EOF >&2

${prefix}---- copy below into ~/.zshrc (adjust function name if you prefer a shorter alias) ----
cc${short}() {
 unset ANTHROPIC_API_KEY
 unset ANTHROPIC_BASE_URL
 export CLAUDE_CONFIG_DIR=~/.claude-config/${ACCOUNT_NAME}
 ~/.local/bin/claude "\$@"
}
${prefix}---- end ----
EOF
}

main() {
  parse_args "$@"
  validate_environment

  log_info "source : $SOURCE_DIR_REAL"
  log_info "account: $ACCOUNT_DIR"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log_info "mode   : dry-run (no changes will be made)"
  fi
  echo

  local name
  for name in "${SHARE_ITEMS[@]}"; do
    process_one_entry "$name"
  done

  emit_summary
  emit_zshrc_snippet
}

main "$@"
