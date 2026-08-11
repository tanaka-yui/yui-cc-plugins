# cmux-team-dispatch-task の子セッションに並列化指示を入れる

## 背景

`cmux-codex-exec` / `cmux-codex-review` には並列実行ディレクティブを入れた（`2026-08-11-codex-parallel-subagents-design.md`）が、
`cmux-team-dispatch-task` が起動する子セッションには何も入っていない。

- `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh:596-735` が engine × mode で起動プロンプトを組み立てるが、
  どのモードにも作業の進め方に関する指示が無い
- `SKILL.md` に出てくる "parallel" は**タスクを worktree 横断でディスパッチする**話だけで、
  1 タスクの中で子セッションが調査・検証を並列化する指示はゼロ

このプラグインは各タスクに独立した git worktree を割り当てるので、タスク間の並列は既に効いている。
足りていないのは**タスク内の並列**——1 つの子セッションが調査・検証を逐次でこなしている部分である。

## 決定事項

| 項目 | 決定 |
|------|------|
| 対象 engine | claude と codex の両方 |
| 対象 mode | plan / superpowers / execute / standby / review の 5 つすべて |
| 並列の機構 | codex は `spawn_agent` / `wait_agent`、claude は Task サブエージェントの同時起動 |
| 並列化する範囲 | 調査と検証。**ファイル編集は逐次** |
| 文面の単一情報源 | `scripts/parallel-directive.sh` を新設し、`launch-workspace.sh` と親セッション（SKILL.md 経由）の両方がこれを使う |
| 制御 | `--no-parallel` でオフ、`--agents <N>`（2〜8、既定 4） |

## 注入点は 2 系統に分かれる

`launch-workspace.sh` が起動時にプロンプトを組み立てるのは **plan / superpowers / execute の 3 モードだけ**である。
standby と review のペインは**プロンプト無し（または「idle で待て」だけ）で起動**し、実際の指示は後から親が
`cmux send` でタイプ送信する。codex standby は「codex は idle でも agmsg push を受けられる保証が無い」という
理由で初期プロンプトが常に空になっている（`prewarm-panes.sh:385, 416`）。

| 系統 | 対象 | 編集先 |
|------|------|--------|
| A. 起動時プロンプト | plan / superpowers / execute × claude・codex = 6 通り | `launch-workspace.sh` |
| B. 後から `cmux send` で届く指示 | standby への Phase B 実行指示、Phase A-R / B-R のレビュー依頼 | `SKILL.md` ほか 4 ファイル、`launch-workspace.sh` の `REVIEW_INSTRUCTION` |

系統 B で同じ文面を各所に直書きすると、このプラグインの 4 ファイル一致ルールの下で必ずドリフトする。
そこで `scripts/parallel-directive.sh` を単一の情報源にし、SKILL.md は親にこのスクリプトを実行させて
出力を送信テキストに含めさせる。

## 前回と違う決定的な制約: プロンプトにクォート文字を書けない

`launch-workspace.sh` の composed command は最終的に次の形になる（`launch-workspace.sh:738`）。

```bash
CLAUDE_CMD="zsh -ic \"$CORE_CMD\""      # CORE_CMD の中に '$PROMPT_TEXT' が入る
```

つまりプロンプトは **`zsh -ic "..."` の中の `'...'`** という二重の引用の内側に置かれる。既存コードにも
`REVIEW_INSTRUCTION` の直前に「文中にクォート文字を使わないこと」という警告コメントがある
（`launch-workspace.sh:607`）。

`cmux-codex-exec` / `cmux-codex-review` は `'\''` エスケープでこれを回避していたが、**このプラグインは
エスケープしない**。したがって `parallel-directive.sh` の出力は次を満たさなければならない。

- シングルクォート `'`、ダブルクォート `"`、バッククォート `` ` `` を**一切含まない**
- `$` を含まない（`zsh -ic "..."` の中で変数展開されるため）
- `!` を含まない。`zsh -ic` の `-i` は**対話モード**なので history 展開が有効になり、
  `!` が特殊文字として解釈される
- バックスラッシュ `\` を含まない

これはテストで機械的に検証する。

## `scripts/parallel-directive.sh`

```
Usage: parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- 標準出力に指示文を 1 つ出す。改行を含んでよいが、上記の禁止文字は含まない
- `--agents` の既定は `4`、許容は `2`〜`8` の整数。範囲外・非数値はエラー終了
- `--engine` / `--mode` が不正ならエラー終了
- `standby` は `execute` と同じ文面を使う（実行系なので `--mode execute` を渡す）

### 文面（codex）

共通の導入:

```
PARALLEL EXECUTION, mandatory: whenever two or more pieces of work are
independent, you MUST fan them out with spawn_agent and collect them with
wait_agent instead of doing them one after another. Run at most <N> child
agents at a time.
```

モード別の追加:

- **plan / superpowers**: 影響範囲 / 既存実装パターン / テスト構成 / 関連ドキュメントの調査を
  読み取り専用の子エージェントに分割して並列実行し、集約してから設計に入る
- **execute / standby**: 同じ調査の並列化に加えて、実装完了後の型チェック / lint / テスト /
  ドキュメント整合の検証を子エージェントに分けて並列実行する
- **review**: レビュー観点（バグ・正確性 / セキュリティ / 設計・可読性 / テスト網羅）ごとに
  子エージェントを spawn し、親が重複を除いて集約する

全モード共通の禁止事項:

```
File edits stay in the parent agent and stay sequential. Never let two child
agents edit files in this worktree at the same time.
```

### 文面（claude）

機構だけ差し替える。`spawn_agent` / `wait_agent` の代わりに「1 つのメッセージで複数の Task
サブエージェントを起動する」を指示する。

### superpowers への譲歩文（全 engine × 全 mode 共通）

superpowers モードの子は brainstorming → writing-plans → **subagent-driven-development** を辿る。
この SDD スキルは *"Never dispatch multiple implementation subagents in parallel (conflicts)"* と
明示的に逐次実行を要求しており、無条件の「並列化せよ」はスキルと矛盾する。したがって次の一文を
入れる。

```
This applies to investigation and verification only. It never overrides a
skill that sequences implementation for you: if you are following
superpowers subagent-driven-development, keep its one-implementer-at-a-time
rule exactly as written.
```

**この一文は engine で出し分けず、全 engine × 全 mode に入れる。** 理由は 2 つある。

- codex も superpowers パイプラインを辿る。`launch-workspace.sh:703` の codex superpowers モードは
  プロンプトに `$superpowers:brainstorming` を前置しており、そこから writing-plans →
  subagent-driven-development へ繋がる。claude 限定にすると codex 側で同じ矛盾が起きる
- execute モードの子も、渡された plan を executing-plans / subagent-driven-development で
  実行することがある。設計モードに限定しても漏れる

常に真で、入れても害がない一文なので、条件分岐を持たずに常時出力する方が安全かつ単純である。

## 系統 A: `launch-workspace.sh` の変更

### 新しい引数

| 引数 | 既定 | 挙動 |
|------|------|------|
| `--no-parallel` | off | ディレクティブを注入しない（現行と完全に同じプロンプト） |
| `--agents <N>` | `4` | 同時実行の上限。`2`〜`8` の整数のみ。範囲外・非数値はエラー終了 |

検証は既存の `--model` / `--effort` 検証と同じ位置、**ペイン起動より前**に置く。

### 連結位置

- `MODE=plan` / `MODE=superpowers`:
  `PROMPT_TEXT="Read and follow the task in .cmux-team-dispatch-task-prompt.md"` の後ろに連結
- `MODE=execute`:
  `PROMPT_TEXT="Read and execute the plan at $PLAN_FILE. ${REVIEW_INSTRUCTION}${ABORT_INSTRUCTION}${EXIT_INSTRUCTION}"`
  の `EXIT_INSTRUCTION` の**前**に連結する。exit 指示は最後に置いたままにしないと、
  「セッションを終了せよ」の直後に別の指示が続いて優先順位が曖昧になる
- `MODE=standby` / `MODE=review`: 何もしない（起動プロンプトは idle 待機のみ。系統 B で扱う）

`--no-parallel` 指定時はいずれも空文字を連結する。

### `REVIEW_INSTRUCTION` への注入（Phase B-R spawn 経路）

`launch-workspace.sh:626` の `REVIEW_INSTRUCTION` は、**実装者がレビュアーへ送る依頼文**を組み立てている。
レビュアーに観点別並列レビューをさせるには、この依頼文にも review モードのディレクティブが要る。

ただし `launch-workspace.sh` はレビュアーの engine を知らない。レビュアーは常に設計 engine の逆だが、
その情報は親セッションにしかない。そこで **`review/code-review.json` に `reviewer_engine` キーを追加する**。
親（SKILL.md Step の Child）がこのファイルを書くときに埋め、`launch-workspace.sh` が読んで
対応する engine のディレクティブを依頼文に埋め込む。

`reviewer_engine` が欠落している場合（旧スキーマ）は**ディレクティブを埋め込まない**。既存の
`reviewer_workspace` 欠落時のフォールバックと同じ姿勢で、後方互換を保つ。

## 系統 B: `SKILL.md` ほかの変更

親セッションが `cmux send` で送るテキストに、スクリプトの出力を含めさせる。対象は 3 箇所。

1. **Phase B の standby 実行指示** — `SKILL.md:790` の `REQUEST_TEXT`、および
   `references/unattended/` の CODE_REVIEW_BLOCK が定義する拡張 `REQUEST_TEXT`
2. **Phase A-R のレビュー依頼**
3. **Phase B-R のレビュー依頼**（prewarm 経路。spawn 経路は系統 A の `REVIEW_INSTRUCTION` が担う）

いずれも次の形で挿入する。

```bash
PARALLEL=$(zsh <SKILL_DIR>/scripts/parallel-directive.sh --engine <engine> --mode <mode>)
REQUEST_TEXT="$REQUEST_TEXT $PARALLEL"
```

engine は対象ペインのものを渡す（standby sonnet なら `claude`、codex standby なら `codex`、
レビュー依頼なら設計 engine の逆）。

### 4 ファイル一致ルール

このプラグインは `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md` の **4 ファイル完全一致**
を絶対ルールとしている。上記の変更を入れたら 4 ファイルすべてを同じ commit で更新する。
`SKILL.md` は英語、`guide-ja.md` は日本語で**見出しを 1:1 対応**させる。

## テスト

新規 `test/test-parallel-directive.sh`:

| ID | 検証内容 |
|----|---------|
| PD1 | `--engine codex` の出力に `spawn_agent` と `wait_agent` が含まれる |
| PD2 | `--engine claude` の出力に Task サブエージェントの指示が含まれ、`spawn_agent` は含まれない |
| PD3 | **全 engine × 全 mode** の出力に subagent-driven-development の順序を上書きしない旨が含まれる |
| PD4 | **全 engine × 全 mode の出力に `'` `"` `` ` `` `$` `!` `\` が 1 文字も含まれない**（クォート・展開文字混入の回帰防止） |
| PD5 | 全モードの出力にファイル編集を逐次に保つ禁止文が含まれる |
| PD6 | `--agents 5` が出力に反映され、`--agents 1` / `9` / `abc` はエラー終了する |
| PD7 | 不正な `--engine` / `--mode` はエラー終了する |

既存 `test/test-launch-workspace-codex.sh` に追加:

| ID | 検証内容 |
|----|---------|
| PL1 | plan / superpowers / execute の composed command にディレクティブが含まれる（codex） |
| PL2 | `--no-parallel` でディレクティブが含まれない |
| PL3 | standby / review の composed command にはディレクティブが**含まれない**（起動プロンプトは idle 待機のみ） |
| PL4 | execute で `EXIT_INSTRUCTION` がディレクティブより**後ろ**にある |
| PL5 | `--agents` の不正値は非ゼロ終了し、ペインを起動しない |

既存 `test/test-launch-workspace-review-config.sh` に追加:

| ID | 検証内容 |
|----|---------|
| PR1 | `reviewer_engine: codex` の review-config で `REVIEW_INSTRUCTION` に codex 用ディレクティブが入る |
| PR2 | `reviewer_engine` 欠落時はディレクティブを埋め込まない（後方互換） |

claude engine の composed command 検証は既存の
`test/test-launch-workspace-permissions.sh` の枠組みを使う（claude 経路の静的検査がそこにある）。

## 完了条件

```bash
bash apps/cmux-team-dispatch-task/test/test-parallel-directive.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-codex.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-review-config.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-permissions.sh
bash apps/cmux-team-dispatch-task/test/test-launch-workspace-layout.sh
pnpm check
```

バージョンは `cmux-team-dispatch-task` を `1.13.0` → `1.14.0` にし、
`.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json`
の 3 箇所を同期する。

## スコープ外

- `cmux-codex-exec` / `cmux-codex-review` の `codex-parallel-lib.sh` をこのプラグインと共有すること。
  プラグインは独立インストール可能である必要があり、依存を持たせられない。文面が似ることは許容する
- `.codex/agents/*.toml` からの `agent_type` 検出。dispatch の子は worktree 内で動くため
  リポジトリ直下の定義を読めるが、`agent_type` の提示は今回の対象に含めない
- 親（オーケストレータ）セッション自身の並列化。親はタスクをディスパッチするだけで実作業をしない
- `prewarm-panes.sh` の初期プロンプト。standby ペインは idle 待機のままにし、
  ディレクティブは後から届く実行指示に載せる
