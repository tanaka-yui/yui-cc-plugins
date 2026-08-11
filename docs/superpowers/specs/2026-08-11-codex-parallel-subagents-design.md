# codex の実装・レビューを spawn_agent で確実に並列化する

## 背景

`cmux-codex-exec` と `cmux-codex-review` が codex に送るプロンプトには、作業の進め方に関する
指示が一切入っていない。

- `apps/cmux-codex-exec/bin/cmux-codex-exec:101` — `plan ファイル <path> を読み、このリポジトリに実装せよ。`
- `apps/cmux-codex-review/bin/cmux-codex-review:116` — `<対象> をレビューし、問題点・改善点を具体的に指摘せよ。`

一方 codex-cli 0.147.0 は multi-agent 機能を stable として持ち、ユーザーの `~/.codex/config.toml`
では `[features] multi_agent = true` が既に有効になっている。実セッション履歴には
`spawn_agent` / `wait_agent` / `followup_task` / `send_message` / `list_agents` / `interrupt_agent`
の使用実績がある（直近2週間で `spawn_agent` 724 回）。

つまり並列化の機能は使える状態にあるのに、プロンプトが何も要求していないため、並列化するか
どうかが codex の気分任せになっている。本設計はこれを「独立作業が2件以上あるなら必ず並列化する」
という強制指示に変える。

### spawn_agent の引数

実セッションで観測された形式は次のとおり。

```json
{"task_name": "...", "agent_type": "...", "fork_turns": "all|none", "message": "..."}
```

`agent_type` は**必須ではない**（724 回中 203 回は指定なし。他も `worker` / `explorer` / `default`
といった自由文字列）。定義済みの型はプロジェクト直下の `.codex/agents/*.toml` から供給され、
`agent_type` の名前は**ファイル名 stem**、説明は toml 内の `description` フィールドに入る。
`yui-cc-plugins` 自身には `.codex/agents/` が無いため、未定義時のフォールバックが必須になる。

## 決定事項

| 項目 | 決定 |
|------|------|
| 並列レイヤ | codex 内部の `spawn_agent` / `wait_agent`。cmux ペインは1枚のまま |
| exec で並列化する範囲 | 事前調査と実装後の検証。**実装本体（ファイル編集）は親エージェントが逐次** |
| review で並列化する範囲 | 観点別レビューと背景調査 |
| agent_type | `.codex/agents/*.toml` があれば description ごと提示して選ばせ、無ければ省略させる |
| 確実性の担保 | 義務化文言 + spawn 一覧のサマリー提示 + agmsg 通知本文への `agents=N` 埋め込み |
| 制御 | 同時実行上限を既定 4 で明示。`--no-parallel` でオフ、`--agents <N>` で上限変更 |
| 実装方式 | 共通シェル関数を両プラグインに**同一内容のコピー**で配置し、テストで同一性を検証 |

### 実装本体を並列化しない理由

`cmux-codex-exec` は worktree を分離せず**カレントディレクトリで**実装する。複数の子エージェントに
同一 worktree のファイルを同時編集させると、片方の編集がもう片方に上書きされる、apply_patch が
コンテキスト不一致で失敗する、といった競合が起きる。書き込みを伴わない調査と、実装完了後に
走らせる検証だけを並列化することで、競合リスクをゼロに保ったまま待ち時間を削る。

### 実装方式にコピーを選ぶ理由

各プラグインは独立して `claude plugin install` できる必要があるため、共通コードを別 workspace
パッケージへ切り出せない。この repo には既に `cmux-codex-wait` を両プラグインへ同一内容のコピーで
配置し、テスト W5 で同一性を検証する前例がある。新しい共通ファイルも同じ扱いにする。

## アーキテクチャ

### 新規ファイル

`apps/cmux-codex-exec/bin/codex-parallel-lib.sh`
`apps/cmux-codex-review/bin/codex-parallel-lib.sh`

両者は一字一句同一。公開する関数は2つのみ。

| 関数 | 責務 | 入力 | 出力 |
|------|------|------|------|
| `list_codex_agent_types` | `.codex/agents/*.toml` を走査し `<stem> — <description>` を1行ずつ出力 | なし（cwd 基準） | 0行以上のテキスト。ディレクトリが無ければ空 |
| `build_parallel_directive` | 並列化ディレクティブ本文を組み立てる | `$1`=同時実行上限、`$2`=プラグイン固有のフェーズ指示 | プロンプトへ連結する複数行テキスト |

`list_codex_agent_types` の詳細:

- `agent_type` 名はファイル名 stem（`typescript-backend-coder.toml` → `typescript-backend-coder`）
- description は toml 内の `description = "..."` の**1行目**を抽出する。複数行 description は
  最初の行だけを使う
- description を抽出できなければ name のみを出力する
- stem が `[A-Za-z0-9._-]+` に完全一致しないファイルは**スキップ**する。プロンプトはペインの
  シェルで再パースされるため、想定外の文字を通さない
- 走査が失敗しても無視し（`2>/dev/null || true`）、プロンプト生成を止めない

### 呼び出し側の変更

両 bin は既存のプロンプト組み立て部の直後に1ブロックを挿し込む。

```bash
# exec
PROMPT="$TASK$PARALLEL$NOTIFY"

# review
REVIEW_INSTR="$REVIEW_INSTR$PARALLEL"   # NOTIFY の連結はその後
```

`$PARALLEL` は `--no-parallel` 指定時に空文字になる。

**連結はエスケープ処理より前に行う。** description に `'` が混ざっても、既存の
`PROMPT_ESC=${PROMPT//\'/\'\\\'\'}` / `REVIEW_INSTR_ESC=...` が吸収する。エスケープ後に連結すると
`cmux send` で送る文字列が壊れ、codex に届くプロンプトが分割される。

### cmux-codex-wait の改修

現状 `bin/cmux-codex-wait:52-54` は token をマッチさせるだけでメッセージ本文を捨てている。
このままでは通知に `agents=N` を載せても親セッションへ届かない。マッチ行を捕まえ、
`agents=<N>` があれば出力に付ける。

```bash
line=$("$AGMSG_HISTORY" "$TEAM" "$AGENT" 30 2>/dev/null | grep -F "$TOKEN" | tail -1)
if [[ -n "$line" ]]; then
  agents=$(printf '%s' "$line" | grep -oE 'agents=[0-9]+' | tail -1)
  echo "status=done token=$TOKEN${agents:+ $agents}"
  exit 0
fi
```

`agents=` が無ければ出力は従来どおり `status=done token=...` になり、後方互換を保つ。
この改修も両プラグインの同一コピーに対して行うため、W5 の同一性検証はそのまま通る。

## 注入するプロンプト

### 共通部（`build_parallel_directive` の出力）

```
## 並列実行（必須）

独立して進められる作業が2件以上あるときは、必ず spawn_agent で子エージェントを
起動して並列に進め、wait_agent で結果を回収せよ。逐次で済ませてはならない。
同時に走らせる子エージェントは最大 <N> 体まで。

<フェーズ指示（プラグイン固有）>

利用可能な agent_type:
- <stem> — <description>
...
適切なものが無ければ agent_type は省略してよい。

最後に、次の表で並列実行サマリーを必ず提示せよ:
| task_name | agent_type | 担当 | 結果 |
```

`.codex/agents/*.toml` が1つも無い場合、`利用可能な agent_type:` 以下のブロックを次に差し替える。

```
このリポジトリには agent_type の定義が無い。agent_type は省略して spawn せよ。
```

### exec 固有のフェーズ指示

- plan を読んだ直後、影響範囲 / 既存実装パターン / テスト構成 / 関連ドキュメントの調査を
  **読み取り専用**の子エージェントに分割して並列実行し、結果を集約してから実装に入る
- 実装本体（ファイル編集）は親エージェントが逐次で行う。**複数の子エージェントに同一 worktree の
  ファイルを同時編集させてはならない**
- 実装完了後、型チェック / lint / テスト / ドキュメント整合の検証を子エージェントに分けて並列実行する

### review 固有のフェーズ指示

- レビュー観点（バグ・正確性 / セキュリティ / 設計・可読性 / テスト網羅）ごとに子エージェントを
  spawn し、並列にレビューさせる
- diff だけで判断できない点（呼び出し元、既存規約、変更経緯）は調査用の子エージェントに並列で
  集めさせ、その結果を踏まえて判断する
- 親エージェントは子の指摘を集約し、重複を除いて重要度順に1本のレビューとして提示する

### 通知本文への並列度埋め込み

`NOTIFY` の文言を次のように変更する。

```
DONE <token>: <plan名> 実装完了 agents=<N>
```

`<N>` は実際に spawn した子エージェントの総数に置き換えること、をプロンプト内で明示する。
review 側も同様に `DONE <token>: レビュー完了 agents=<N>` とする。

`--no-parallel` 指定時は `agents=` を付けない（従来の文言のまま）。

## CLI

両 bin に次の引数を追加する。

| 引数 | 既定 | 挙動 |
|------|------|------|
| `--no-parallel` | off | ディレクティブを一切注入しない。プロンプトは現行と完全に同じ |
| `--agents <N>` | `4` | 同時実行上限。`2`〜`8` の整数のみ許可。範囲外・非数値はエラー終了 |

`--agents 1` を「並列しない」と解釈させる曖昧さは持ち込まない。オフにする手段は `--no-parallel`
の1経路に固定する。バリデーション失敗時は既存の `-m` / `-e` と同じく**ペイン分割前に**非ゼロ終了し、
無効な指定でペインを撒かない。

## テスト

既存のテストハーネス（stub の `cmux` / `codex` を用意し、`cmux send` が送る文字列をペインのシェルと
同じように再パースして codex が実際に受け取る引数を検証する方式）をそのまま使う。

### `apps/cmux-codex-exec/test/test-cmux-codex-exec.sh`

| ID | 検証内容 |
|----|---------|
| E4 | 既定でプロンプトに `spawn_agent` / `wait_agent` / 上限 `4` が含まれ、argc は 6 のまま |
| E5 | `--no-parallel` でディレクティブが一切含まれない |
| E6 | `.codex/agents/*.toml` があれば stem と description がプロンプトに載る。無ければ汎用フォールバック文言になる |
| E7 | description に `'` が含まれても argc が 6 のまま（エスケープ順序の回帰防止） |
| E8 | 通知配線時、プロンプトの `send.sh` 行に `agents=` が含まれる |
| E9 | `--agents 9` / `--agents abc` は非ゼロ終了し、ペインを分割しない |

### `apps/cmux-codex-review/test/test-cmux-codex-review.sh`

D10〜D15 として E4〜E9 と同内容を検証する。フェーズ指示の文言だけレビュー観点のものに差し替える。

### `apps/cmux-codex-review/test/test-cmux-codex-wait.sh`

| ID | 検証内容 |
|----|---------|
| W6 | 完了メッセージに `agents=5` があれば出力が `status=done token=... agents=5` になる |
| W7 | `agents=` が無ければ出力は従来どおり `status=done token=...` |
| W8 | `codex-parallel-lib.sh` が review / exec 2プラグインで同一内容 |

## ドキュメントとバージョン

| 対象 | 変更 |
|------|------|
| 両 `skills/*/SKILL.md`（英語） | 引数表に `--no-parallel` / `--agents` を追加。並列化の意図を「Why this design」へ1段落 |
| 両 `skills/*/references/guide-ja.md` | 上記の訳を同じ commit で更新（`pnpm check:doc-lang` が落ちるため必須） |
| 両 `commands/*.md`（英語） | exec は Step 5 で `agents=N` を読み取りユーザーへ報告する旨を追記 |
| 両 `CLAUDE.md`（日本語） | 「構成」に `codex-parallel-lib.sh`、デフォルト表に `--agents 4`、テスト不変条件に E4-E9 / D10-D15 / W6-W8 |
| 両 `README.md` | フラグ表に追記 |
| `apps/cmux-codex-exec/.claude-plugin/plugin.json` | `1.4.0` → `1.5.0` |
| `apps/cmux-codex-review/.claude-plugin/plugin.json` | `1.5.0` → `1.6.0` |
| `.claude-plugin/marketplace.json` | 上記2つの version を同期 |

## 完了条件

次のすべてがグリーンであること。

```bash
bash apps/cmux-codex-exec/test/test-cmux-codex-exec.sh
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh
pnpm check
```

## スコープ外

- cmux ペインを複数起動する形の並列化。worktree 分離を伴う複数タスクの並列実行は
  `cmux-team-dispatch-task` の責任範囲であり、本プラグインは1ペイン・カレントディレクトリの
  軽量フローを維持する
- `yui-cc-plugins` 自身への `.codex/agents/*.toml` の新設。agent_type が無いプロジェクトでも
  フォールバックで動くことが本設計の前提であり、定義の追加は別途判断する
- 指摘の裏取り（adversarial verify）や対象領域別の分割レビュー。今回選択しなかった並列化軸
