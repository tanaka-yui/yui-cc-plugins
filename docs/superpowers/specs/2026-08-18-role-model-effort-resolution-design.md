# cmux-team-dispatch-task role ベース model / effort 解決の設計

対象: `apps/cmux-team-dispatch-task`

## 背景

現行 v1.19.2 は、役割ごとの model / effort を engine によって非対称に扱っている。

- `plan_model` / `review_model` / `exec_model` と `plan_effort` / `review_effort` /
  `exec_effort` は `launch-workspace.sh` の中で `RUNNER_ENGINE == "codex"` に
  gate されており、claude runner では一切効かない
- claude 側の model は `prewarm-panes.sh` の定数 `OPUS_MODEL="opus[1m]"` /
  `SONNET_MODEL="sonnet"` にハードコードされ、`--model` で明示的に渡される
- `exec_choice` は `"opus 1m" | "sonnet" | "codex"` という **model と engine が
  混ざった enum** で、Phase B の実行経路・prewarm のペイン構成・reviewer 解決
  マトリクスの 3 箇所を同時に決めている

この構造では claude 側で `fable` のような別モデルを役割ごとに選べない。effort に
至っては claude engine で指定しても `--effort is only meaningful with codex engine`
と警告して捨てられる。

## 目的

1. `plan_model` / `review_model` / `exec_model` と 3 つの effort を **engine 中立**にし、
   claude runner でも codex runner と同じ仕様で役割ごとのモデルと effort を指定できる
2. claude engine で `opus[1m]` / `sonnet` / `fable` を全役割で選べる
3. effort の既定値を engine 共通で定める（design `xhigh` / review `xhigh` / exec `high`）
   うえで、`max` を含むより高い値も選べる
4. `exec_choice` を engine 選択に退け、モデル決定を runner の役割フィールドへ一本化する
5. 設計セッションがそのまま実装に入る in-session 経路を、engine 非依存の
   「役割設定が完全一致したとき」というルールへ一般化する

## 非目的

- dispatch 時の一時上書き（`--` オプションによる task 個別の runner / model / effort
  上書き）。これは本 spec の解決モデルの上に乗る独立したサブシステムであり、
  **別 spec** として本 spec の実装完了後に設計する
- model 文字列の allowlist 検証。codex 側と同様、任意の文字列を通す
- codex 固有の sandbox / approval / hook trust フラグの変更
- レイアウト（v1.19.2 で確定した 2 行グリッド）の変更

## 決定事項

ブレインストーミングで確定した内容。

| 論点 | 決定 |
|------|------|
| fable の粒度 | runner の役割フィールドを claude engine でも有効化する |
| `exec_choice` | engine 選択（`claude` / `codex` / `ask`）へ退く |
| 旧 `exec_choice` 値 | 破壊的変更。移行なし。不正値として警告＋レイヤー無効化 |
| exec のモデルを実行時に切り替える手段 | 廃止してよい（runners.json / `--setup` で設定する） |
| effort の対象 engine | claude / codex 両方 |
| effort 既定値 | design `xhigh` / review `xhigh` / exec `high` |
| in-session 継続の条件 | engine + model + effort が**全部一致**したとき |

## 設計

### 1. runners.json スキーマ — 役割フィールドの engine 中立化

`engine` によってフィールドの有無を変えない。全 runner が 6 つの役割フィールドを
省略可能で持つ。

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "plan_model": "opus[1m]", "review_model": "opus[1m]", "exec_model": "fable",
      "plan_effort": "max", "review_effort": "xhigh", "exec_effort": "high" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

**未設定時の既定値:**

| 役割 | claude の model | codex の model | effort（両 engine 共通） |
|------|----------------|---------------|------------------------|
| plan | `opus[1m]` | 無指定（codex 側既定に委ねる） | `xhigh` |
| review | `opus[1m]` | reviewer に選ばれた場合は必須（現行どおり die） | `xhigh` |
| exec | `sonnet` | 無指定（codex 側既定に委ねる） | `high` |

codex の model だけ既定値を持たないのは、モデル名がアカウント・バージョン依存で
妥当な既定を書けないため。現行の「未設定なら `--model` を付けない」挙動を保つ。

**effort は engine 別の allowlist で検証する**（model は検証しない）:

- claude: `low` / `medium` / `high` / `xhigh` / `max`（`claude --help` で確認済み）
- codex: `minimal` / `low` / `medium` / `high` / `xhigh`

### 2. `launch-workspace.sh` — 役割フォールバックの gate を外す

現行の `if [[ "$RUNNER_ENGINE" == "codex" ]]` で囲まれた model / effort 解決ブロックを
engine 中立化する。

優先順位（model / effort とも共通）:

```
--model / --effort の明示指定  >  runner の <role>_model / <role>_effort  >  §1 の既定値
```

engine ごとのフラグ組み立て:

| engine | model | effort |
|--------|-------|--------|
| claude | `--model '<M>'`（既存の `CLAUDE_EXTRA_FLAGS`） | `--effort '<E>'` を `CLAUDE_EXTRA_FLAGS` へ追加 |
| codex | `--model '<M>'`（既存の `CODEX_MODEL_FLAG`） | `-c model_reasoning_effort='<E>'`（既存の `CODEX_EFFORT_FLAG`） |

claude の起動フラグ順序は `<command> [--model X] [--effort Y] [--dangerously-skip-permissions] '<prompt>'`
とする。`--effort is only meaningful with codex engine` の警告分岐は削除する。

### 3. `prewarm-panes.sh` — ハードコード撤廃と executor の engine 単位化

- 定数 `OPUS_MODEL` / `SONNET_MODEL` を削除し、実装・設計・レビューの各ペインへ
  `--model` を渡さない。モデルは §2 の役割フォールバックが解決する
- `START_SONNET` / `START_OPUS` / `START_CODEX` → **`START_CLAUDE` / `START_CODEX`** の 2 値
- agent 名 `<slug>-sonnet` / `<slug>-opus` → **`<slug>-claude`**
- `prewarm.json` の `executors` キー `opus` / `sonnet` / `codex` → **`claude` / `codex`**
- §5 の in-session 条件が成立するときは **実装ペインを起動しない**（`executors` は `{}`）

ペイン配置は v1.19.2 の 2 行グリッドを維持する。実装ペイン 0 個のときは
design と review の 2 ペインになる。

### 4. `exec_choice` — engine 選択へ

有効値は `"claude"` / `"codex"` / `"ask"` の 3 つ。

- `config-edit.sh` の `valid_value` を更新する
- SKILL.md Step 1g の `resolve_exec_runner` は engine を直接受け取る形に単純化する
  （`"opus 1m"|sonnet → claude` の写像が不要になる）
- 旧値 `"opus 1m"` / `"sonnet"` は不正値として扱い、警告してそのレイヤーだけ無効化する。
  自動マイグレーションは行わない
- Phase B の AskUserQuestion は最大 2 択（claude / codex）。片方の engine の runner しか
  登録されていなければ質問せずそちらに固定する
- 「常にこの選択を使う / 毎回選ぶ」の永続化フォローアップは現行のまま維持し、
  書き込む値だけが `claude` / `codex` / `ask` になる

### 5. in-session 実行の一般化

Step 1g で役割を解決したあと、次を判定して `IN_SESSION` を決める。

```
IN_SESSION = (EXEC_ENGINE == DESIGN_ENGINE)
          && (EXEC_MODEL  == PLAN_MODEL)
          && (EXEC_EFFORT == PLAN_EFFORT)
```

比較は §1 の既定値を埋めた**解決後の値**で行う。codex の model は既定値を持たない
（両方とも空文字）ため、model フィールドを 1 つも設定していない codex runner では
model 比較が一致してしまう。ただし effort の既定は plan `xhigh` / exec `high` で
異なるので、`IN_SESSION=false` となり現行どおり委譲される。空文字どうしを一致と
みなすこの挙動は意図的であり、「役割設定を明示的に揃えたときだけ in-session」という
ルールと矛盾しない。

- `IN_SESSION=true` → 設計セッションがそのまま実装する。`.deferred` を作らず、
  status.json の所有者は設計ペインのままになる。prewarm は実装ペインを起動しない
- `IN_SESSION=false` → 解決済み実装ペイン（prewarm）へ委譲する。prewarm 無効時は
  `launch-workspace.sh --mode execute` で spawn する

effort を条件に含めるのは、effort が**セッション起動時に焼き込まれる**ためである。
モデルだけ一致していても effort が違うなら、in-session を選ぶと実装フェーズが
設計側の effort で走ってしまい `exec_effort` の設定が無視される。

既定値（plan `opus[1m]`/`xhigh`、exec `sonnet`/`high`）では `IN_SESSION=false` となり、
現行の「sonnet へ委譲」と同じ挙動になる。全役割を同一モデル・同一 effort に揃えた
構成でのみ in-session になる。

`EXEC_CHOICE` が `"ask"` の場合、判定は子セッションが Phase B で選択した直後に行う。

### 6. reviewer 解決マトリクスの縮約

`$DESIGN_ENGINE:$EXEC_CHOICE` の 6 ケースを 2 ケースへ畳む。

| 条件 | レビュアー |
|------|-----------|
| `DESIGN_ENGINE == EXEC_ENGINE` | 専用 review ペイン |
| `DESIGN_ENGINE != EXEC_ENGINE` | 設計セッション自身（実装者と逆 engine） |

「実装者と逆 engine がレビューする」という現行の意図は保たれる。in-session のときは
必ず同一 engine なので専用 review ペインがレビューする（現行の
`claude:"opus 1m"` ケースと同じ結論になる）。

この 2 ケース表が適用されるのは `REVIEW_POLICY=legacy`（`review_runner` がどちらの
config レイヤーにも無い）ときだけである。`REVIEW_POLICY=fixed`（固定 runner 名または
`"ask"` の回答で解決済み）のときは現行どおり専用 review ペインが両フェーズを担当し、
この表は参照しない。

### 7. `--setup` / first-run setup

- runner 登録ループで、**engine を問わず** 3 つの model と 3 つの effort を聞く
- claude engine の model 候補: `opus[1m]` / `sonnet` / `fable` / 空（既定）＋ Other 自由入力
- effort 候補は AskUserQuestion の 4 択上限に収めるため、**既定値を基準に engine 別で
  提示する**（`max` は claude でのみ提示する。codex は「実装時に検証する未確定事項」1 で
  受理が確認できた場合に追加する）:
  - claude / plan・review: `既定 (xhigh)` / `max` / `high` / Other
  - claude / exec: `既定 (high)` / `xhigh` / `max` / Other
  - codex / plan・review: `既定 (xhigh)` / `high` / `medium` / Other
  - codex / exec: `既定 (high)` / `xhigh` / `medium` / Other
- `--setup` の `exec_choice` の取り得る値を `claude` / `codex` / `ask` / キー削除へ更新する

## 破壊的変更

移行処理は行わない。利用者は `--reset config` で作り直す。

1. `exec_choice` の旧値 `"opus 1m"` / `"sonnet"` が無効になる
2. `prewarm.json` の `executors` キーが `opus` / `sonnet` → `claude` に変わる
3. prewarm の実装ペインの agmsg agent 名が `<slug>-sonnet` / `<slug>-opus` →
   `<slug>-claude` に変わる
4. codex の effort 未設定時に `-c model_reasoning_effort='<既定>'` が**必ず付く**ように
   なる（現行は未設定なら付けず config.toml の既定に委ねていた）
5. claude の設計ペインが `--model opus[1m]` 固定ではなく runner の `plan_model` 由来に
   なる（既定値が `opus[1m]` なので、設定を変えていなければ実質同じ）

## テスト計画

新規:

- `test/test-role-models.sh` — claude runner の役割 model / effort が
  `launch-workspace.sh` の composed command に反映されること、明示 `--model` /
  `--effort` が runner 設定より優先されること、未設定時に §1 の既定値が入ること、
  engine 別の effort allowlist が効くこと
- `test/test-in-session.sh` — 役割設定が完全一致したとき prewarm が実装ペインを
  起動せず `executors` が空になること、model / effort / engine のいずれか 1 つでも
  異なれば実装ペインを起動すること

更新:

- `test-prewarm-all-codex.sh` / `test-prewarm-unattended.sh` / `test-prewarm-layout.sh`
  — `executors` キーと agent 名
- `test-config-edit.sh` — `exec_choice` の有効値
- `test-launch-workspace-codex.sh` — effort 未設定時に既定が付与される期待値へ
- `test-setup-skill.sh` — `exec_choice` 選択肢と役割フィールドの質問

すべてのテストは worktree ディレクトリを事前作成し、実リポジトリに
`git worktree add` を走らせないこと（v1.19.2 で踏んだ事故）。

## ドキュメント整合

`CLAUDE.md` の 4 ファイル整合ルールに従い、同一 commit で更新する。

1. `skills/cmux-team-dispatch-task/SKILL.md`（英語・SoT）
2. `skills/cmux-team-dispatch-task/references/guide-ja.md`
3. `README.md`
4. `CLAUDE.md`

加えて `references/setup-mode.md` と `references/setup-mode-ja.md`。
`pnpm check:doc-lang` を通すこと。

## 実装時に検証する未確定事項

1. **codex が `max` effort を受理するか** — `codex --help` からは確認できなかった。
   受理するなら codex 側の allowlist にも `max` を追加する
2. **claude の standby / review モードで `--effort` が有効か** — `--effort` は
   「Effort level for the current session」なのでモード非依存のはずだが、
   実際に composed command を起動して確認する
