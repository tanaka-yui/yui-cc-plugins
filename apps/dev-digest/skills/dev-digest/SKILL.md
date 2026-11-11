---
name: dev-digest
description: >
  毎朝の開発速報（JVN / AWS / Google Cloud / X / dev.to / 監視リポジトリの Releases）を Slack に送り、
  送った履歴を SQLite に残す。初期設定（init）、リポジトリの監視登録（setup）、履歴の検索（search）を行う。
  Use when: "開発速報", "dev-digest", "毎朝のダイジェスト", "リポジトリを監視", "履歴を検索".
argument-hint: "[init | setup | search <question> | list | remove <slug>]"
---

## Output Language

All user-facing questions, option labels, tables, and progress reports MUST be
rendered in Japanese. This file is written in English for consistency; it does
not change the language presented to the user.

# dev-digest

Every morning an Orca automation collects dev news feeds and X posts, has Claude summarize them, and posts the
digest to Slack. Everything sent is kept in a local SQLite history that this skill can search. This skill covers the
interactive side: `init`, `setup`, `search`, `list`, `remove`. The morning run itself is not described here: its
canonical procedure is `references/morning.md`, which the `procedure` subcommand prints with this machine's values.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is not set}"
node "$PLUGIN/bin/dev-digest.ts" <subcommand> [options]
```

Every block below that calls the CLI assumes `PLUGIN` is defined as above. Run each block as written; do not
carry shell variables between blocks.

## Hard rules (secrets)

- **Never read, open, cat, grep, or search `~/.dev-digest/secrets.json`.** Never look for Slack Webhook URLs in
  files, environment, or history.
- **Never ask the user for a Webhook URL in chat, and never write one into the conversation.** The URL only
  travels from a hidden dialog or the clipboard into the CLI and then into `secrets.json`. Use `set-webhook` for it.
- If a command prints something that looks like a Webhook URL, do not repeat it.

## Dispatch on the request

- No argument, or the user asks to set up the digest: run **init**.
- The user asks to watch the current repository: run **setup**.
- The user asks about past digests: run **search**.
- The user asks which repositories are watched or wants to stop watching one: **list / remove**.

If the config does not exist yet (`search` or `procedure` says to run init first), start with **init**.

## init

1. Ask in one AskUserQuestion round (render in Japanese):
   - run time (HH:MM, 24-hour) and whether it runs `daily` or `weekdays`
   - minimum JVN severity to report (`critical` default; `high`, `medium`, `low`)
   - JVN keywords for the global message (optional; csv of product or vendor names the user runs, for example
     `Tomcat,PostgreSQL`). Global JVN items are kept only when the title or a product name contains one of them
     (case-insensitive substring). `none` or omitting the flag keeps every item above the threshold. Repository
     messages are not affected.
   - X list URL (must start with `https://x.com/`; `none` to skip the list)
   - X hashtags (offer the defaults `#AI`, `#LLM`, and the Japanese hashtag for "generative AI" (see `DEFAULT_X_HASHTAGS` in `lib/defaults.ts`); csv)
   - dev.to tags (offer the defaults `aws`, `googlecloud`, `ai`, `security`; csv)
2. Run init. The six flags other than `--jvn-keywords` are required the first time; on later runs only the flags
   given are updated.

```bash
node "$PLUGIN/bin/dev-digest.ts" init --time <HH:MM> --trigger <daily|weekdays> --jvn-min-severity <critical|high|medium|low> --x-list "<https://x.com/... | none>" --x-hashtags "<csv>" --devto-tags "<csv>" [--jvn-keywords "<csv | none>"]
```

   Add `--dry-run` to preview the Orca calls without writing anything. Init creates `~/.dev-digest/` (config,
   SQLite history, a work folder `run/`), installs a stable launcher `~/.dev-digest/bin/dev-digest`, registers the
   work folder with Orca, and creates or updates the `dev-digest` automation. The unattended morning run calls the
   launcher, not `node "$PLUGIN/..."`, so the automation keeps working across plugin updates. It prints `launcher=`,
   `automation=` and `webhook_global=registered|missing`. Exit 1 means the Orca registration failed: show the
   reason and stop.
3. If `webhook_global=missing`, register the global Webhook:

```bash
node "$PLUGIN/bin/dev-digest.ts" set-webhook --target global
```

   On macOS this opens a hidden input dialog for the user. Exit 4 with `fallback=clipboard` means no dialog was
   possible (exit 4 without it, in clipboard mode, means the clipboard had nothing readable). Tell the user to copy the Slack Incoming Webhook URL to the clipboard and run, in this session, with
   the `!` prefix: `! ~/.dev-digest/bin/dev-digest set-webhook --target global --from-clipboard`. Wait for them
   to finish. Afterwards the URL is still on the clipboard: tell the user to clear it. Exit 1 means the input
   was cancelled or was not a Slack Incoming Webhook URL; nothing was saved.
4. Show the permission rules and ask before applying:

```bash
node "$PLUGIN/bin/dev-digest.ts" permissions --show
```

   Present the output to the user. The `project` list is the allow list for the unattended run in the work folder:
   the launcher's `procedure` / `collect` / `pending` (exact), `ingest-x:*`, `publish:*`, `x-open:*`;
   `orca tab close` / `snapshot` / `scroll`; read access to the work folder; write and edit access to only
   `x.json` and `digest.json`. It **replaces** the project allow list and sets the work folder's
   `permissions.defaultMode` to `dontAsk`, so anything outside the allow list is refused without a prompt (under modes
   such as `auto`, actions outside the allow list can still be approved automatically). The work folder's settings
   take precedence over the user settings, whose mode is not changed. The containment relies on this mode: tell the
   user to confirm on the first real morning run that an action outside the allow list is refused. The `inherited`
   list is the allow list in the user settings. Allow rules from every scope are merged, and `dontAsk` refuses only
   actions that no allow rule matches, so these rules also apply to the unattended run: the containment is the
   project list plus this list, not the project list alone. dev-digest never changes them. Show the list to the user
   and point out any broad rules (for example `Bash(git commit:*)`, a broad `Bash(...)` prefix, or `WebFetch`); the
   user decides whether to remove them from their own settings. Do not remove them yourself. The `user` list
   adds deny rules so that no session can Read or Edit `secrets.json`; it only **adds** to the user settings. Only
   after the user approves:

```bash
node "$PLUGIN/bin/dev-digest.ts" permissions --apply
```

5. Tell the user to log in to X once in Orca's built-in browser (the morning run reuses that login). Do not ask
   for credentials.
6. When the user approves a first run, run the automation printed by init (`automation=<id>`):

```bash
orca automations run <automation id>
```

   Use the `orca` CLI from `ORCA_CLI_COMMAND` or `/Applications/Orca.app/Contents/Resources/bin/orca` if it is not
   on PATH. Then tell the user to check Slack.

## setup

Run this inside the repository to watch. It needs `init` to have been done.

1. Derive the slug (the `owner/repo` of the `origin` remote, or the folder name):

```bash
node "$PLUGIN/bin/dev-digest.ts" repo slug --path "$(pwd -P)"
```

   Rules for a slug: it starts with a letter or digit, is either `owner/repo` or a single segment (the folder name
   when there is no `origin` remote), and never contains `__`. If the printed slug is rejected by `repo save` later,
   tell the user and agree on another slug.
2. Read the dependency definitions to build a candidate list. Scope: **direct dependencies** of the project
   (package.json, go.mod, pyproject.toml / requirements, Cargo.toml, Gemfile, pom.xml / build.gradle, ...) plus
   **infrastructure OSS**: images in docker-compose files and Dockerfile `FROM`, Helm charts, Kubernetes
   manifests, Terraform providers. Skip transitive dependencies. For each, infer its GitHub `owner/repo`
   (`null` when unknown). Also collect `languages`, `cloudServices` (for example `aws`, `gcp`) and a few
   `keywords` (product names worth matching in news).
3. Show the candidates in a table (name, ecosystem, GitHub owner/repo) and let the user correct the GitHub
   repositories, add rows, and remove rows. Ask the JVN minimum severity for this repository
   (`critical`, `high`, `medium`, `low`, or the global setting, which is `null`), and dev.to tags (csv, may be empty).
4. Write the candidate JSON to a **temporary file outside `~/.dev-digest/run/`** (for example under `mktemp -d`):

```json
{
  "slug": "owner/repo",
  "displayName": "repo",
  "path": "/absolute/path/to/repo",
  "jvnMinSeverity": null,
  "devtoTags": ["keycloak"],
  "watch": {
    "languages": ["typescript"],
    "packages": [{ "name": "keycloak", "ecosystem": "docker", "github": "keycloak/keycloak" }],
    "cloudServices": ["aws"],
    "keywords": ["keycloak"]
  }
}
```

   `devtoTags` entries must be lowercase alphanumerics only. `addedAt` is set by the CLI; do not write it. Then:

```bash
node "$PLUGIN/bin/dev-digest.ts" repo save --file <temp file>
```

   It prints `slug=`, `created=`, `added=`, `removed=` (package names). Report the added and removed names. On a
   validation error, fix the field it names and retry.
5. Ask whether this repository gets its own Slack channel. If yes:

```bash
node "$PLUGIN/bin/dev-digest.ts" set-webhook --target <slug>
```

   (same exit 4 / clipboard fallback as in init, with `--target <slug>`). If not, the repository's items go to the
   global channel. Delete the temporary file when done.

## search

Decide the filters from the question, then run:

```bash
node "$PLUGIN/bin/dev-digest.ts" search --q "<words>" --since <YYYY-MM-DD> --until <YYYY-MM-DD> --section <csv> --repo <slug> --min-severity <level> --limit <n>
```

All flags are optional. `--section` takes a csv of `jvn|aws|gcp|x|devto|releases`; dates are in the configured time
zone; `--limit` defaults to 50. Terms under 3 characters use a substring match (title, summary, Japanese summary) instead of
the full-text index; they still work. The output is a JSON array of items (`title`, `url`, `sourceId`,
`publishedAt`, `severity`, `summaryJa`, `tags`, `deliveredTo`, ...); `[]` means no history. Answer with a table
(date, section/source, title, summary) and make every title a link to its `url`. State the filters you used.

## list / remove

```bash
node "$PLUGIN/bin/dev-digest.ts" repo list
node "$PLUGIN/bin/dev-digest.ts" repo show --slug <slug>
node "$PLUGIN/bin/dev-digest.ts" repo remove --slug <slug>
```

`list` prints one tab-separated line per repository (slug, path, webhook masked or `global`, jvn threshold,
package count). `remove` deletes the repository's config and its dedicated Webhook; confirm with the user before
running it, and say that the history stays.
