# Codex-only dispatch final-fix report

## Result

Final whole-branch review round 1 の指摘をすべて修正した。Codex design の `exec_choice=ask` / 未設定では、UI が提示する Opus / Sonnet / Codex の全 execution choice に実体のある executor tuple が生成される。固定 all-Codex は引き続き design / review / executor の正確な3ロールだけを起動し、Claude / Sonnet pane を生成しない。

## Fixes

- `prewarm-panes.sh` に candidate-only の `--claude-runner` interface を追加した。
  - Codex design + ask/unset は explicit Claude candidate で dedicated Opus / Sonnet executor を、Codex candidate で Codex executor を prewarm する。
  - `--claude-runner` を review runner の推論には使わず、review runner も executor candidate に流用しない。
  - fixed Opus / Sonnet / Codex は選択された execution role だけを起動し、不要 pane を増やさない。
  - fixed all-Codex は design / dedicated review / Codex executor の3 pane を維持する。
- review member join 後に review pane launch または surface parse が失敗した場合、既存 `leave.sh` を即時に呼ぶ symmetric cleanup を追加した。review failure は従来どおり non-fatal で、review omitted として継続する。
- review=on tuple の `model` / `runner` / `engine` / `pane-agent` を1項目ずつ欠落させる parameterized negative test を追加した。
- README、guide-ja、SKILL、CLAUDE.md、`launch-workspace.sh` usage の stale runner / parent / fallback / Phase B 説明を同期した。

## TDD evidence

RED:

- `bash test/test-prewarm-unattended.sh` は実装前に exit 1。
- Codex design ask/unset は `Error: unknown option: --claude-runner` となり、advertised Opus / Sonnet executor tuple と5-pane topology の assertion が失敗した。
- review launch / parse failure は join 1 に対して leave 0 となり、symmetry assertion が失敗した。

GREEN:

- `bash test/test-prewarm-unattended.sh && bash test/test-prewarm-all-codex.sh && bash test/test-loop-prompt.sh` は exit 0。
- Codex design ask/unset は5 pane、各 advertised choice は正しい runner / engine tuple を持つ。
- fixed Codex / Opus / Sonnet は各3 pane。fixed all-Codex に Claude / Sonnet pane はない。
- review launch / parse failure は join 1 / leave 1 で、review omitted の non-fatal behavior を保つ。
- review tuple の4必須 field は各欠落ケースで nonzero と field-specific diagnostic を返す。

## Verification

- Focused behavioral tests: pass
  - prewarm unattended / all-Codex
  - loop prompt / loop skill
  - launch-workspace Codex / review config
  - cleanup close
- Changed shell files and tests: `bash -n` pass
- Full plugin suite: 22 / 22 pass
- `pnpm check`: pass（既存 token-meter non-null assertion warning 4件のみ）
- `pnpm check:doc-lang`: pass
- `pnpm format`: pass
- plugin-creator `validate_plugin.py`: pass
- direct Claude / Codex / marketplace manifest assertions: pass
- Codex version regex and single-suffix assertion: pass
- `git diff --check`: pass
- `pnpm sort-package`: expected baseline failure。未変更の `apps/token-meter/package.json` の ordering のみであり、修正対象外のため変更していない。
- plugin skill quick validator は既存 `argument-hint` frontmatter を未対応として exit 1。要求された plugin-creator validator は pass しており、この unrelated frontmatter は変更していない。

## Commits

- `e4276dc` — `fix(cmux-team-dispatch-task): ask時のexecutorを全てprewarmする`
- `eea7346` — `docs(cmux-team-dispatch-task): runner topologyの説明を同期する`
- `e218d00` — `chore(cmux-team-dispatch-task): Codex cachebusterを更新する`

Final Codex plugin version: `1.18.0+codex.local-20260815-203528`。suffix は1個で、`^1[.]18[.]0[+]codex[.]local-[0-9]{8}-[0-9]{6}$` に一致する。

## Installed-code E2E

Prescribed `sum.sh` task は `/private/tmp/cmux-team-dispatch-codex-e2e-review1.eyXpbV/evidence/` で Phase A → A-R → B → B-R を完走済みである。

最終 plugin content に対しては、追加の同等 `subtract-shell-function` flow を `/private/tmp/cmux-team-dispatch-codex-e2e-finalfix1.p7eIn6/evidence/` で実行した。これは prescribed sum task そのものではなく、raw request は `root-request.md`、生成された完全 task prompt は `child-task-prompt.md` に保存している。

- Sole installed provider: `cmux-team-dispatch-task@codex-only-e2e-finalfix1-20260815-2039`
- Version: `1.18.0+codex.local-20260815-203528`
- Worktree / local source / installed cache: 50 files、combined SHA256 `df65a997b01132b1666495548839b67264d94e2927b1e7daa9f8079b37b1025e` で一致
- Plugin tree: `0db771b943cacb2ac2ddc47f6c0ba2fc5159db16`
- Roles: root/design `gpt-5.6-sol`、dedicated review `gpt-5.6-sol`、executor `gpt-5.6-terra`
- Phase A-R round 1: `VERDICT: approve`
- Phase B commit: `84a6fc6a988eebaad1f947c76bd3cdf8d27c3146`
- Phase B-R round 1: `VERDICT: approve`
- Terminal status: `done`
- Disposable `main` へ fast-forward 後、`/bin/sh test_subtract.sh` と `/bin/sh -n subtract.sh test_subtract.sh`: pass
- Scoped live process counts: Sol 3（root / design / review）、Terra 1、actual Claude executable 0、`--model sonnet` 0、agmsg `claude-code` watcher/wiring 0

## Restoration

- Plugin config exact restore: `b8fe8ee5b14fa1af22526aff90dfc11715ce5459235293842bdb6507e83281aa`
- Runners exact restore: `dab84d57dd69dede78a8f7726730896d263944ab22dac4360de60b0a5d75fd4b`
- Codex `config.toml` exact restore: `b2333d5807a609b1d1b1eb087505a246f08186da6cae2260abe0e21728ec65e0`、backup diff empty
- Sole restored provider: `cmux-team-dispatch-task@yui-cc-plugins` 1.17.0、installed / enabled
- Temp provider / marketplace / source / E2E workspaces / known E2E PIDs: 0
- Original manifest / skill hashes: pre-E2E valuesと一致

Codex CLI は空の unregistered cache root `/Users/yui/.codex/plugins/cache/codex-only-e2e-finalfix1-20260815-2039` を残した。plugin/version payload は削除済みで、指示どおり手動削除していない。

## Residual concerns

- `pnpm sort-package` の token-meter baseline failure と、plugin skill quick validator の既存 `argument-hint` 非対応は今回の変更範囲外で残る。
- E2E の disposable repository と raw evidence directory は検証用に保持している。cmux workspace / process、temp provider / marketplace / source は残っていない。
