# cmux-codex-review

agmsg の inbox 確認 → 新 cmux ペインで codex コードレビュー起動、を 1 アクションにまとめたプラグイン。

## 構成

- `commands/codex-review.md` — `/codex-review` スラッシュコマンド（agmsg inbox 確認 + bin 実行）
- `skills/codex-review/SKILL.md` — レビュー起動スキル（トリガー定義）
- `bin/cmux-codex-review` — ペイン分割 + 対話 codex へのレビュープロンプト送信の本体（`!` 直接実行も可、LLM 不要で高速）
- `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` — Plugin マニフェスト

## 動作

1. レビュー対象を確定（引数無指定なら `--list-targets` の候補をユーザーに確認）
2. agmsg を起動して受信箱を確認（非ブロッキング。未参加・未インストールならスキップ）
3. `cmux new-split <dir>` で新ペインを分割
4. 分割先で**対話 codex にレビュープロンプトを送る**（`codex --sandbox workspace-write --ask-for-approval never -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" '<レビュー指示>'`）
5. `--team/--reviewer/--parent` 指定時は、レビュー指示に完了通知（agmsg `send.sh`）を注入し、親はターンを閉じて
   agmsg Monitor イベントで完了を検知する

## テスト

```bash
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
```

stub の cmux / codex を使い、bin が `cmux send` で送る文字列を**ペインのシェルと同じように再パース**して
codex が実際に受け取る引数を検証する（生文字列の grep では引用符崩れを検知できないため）。守っている不変条件:

- **D1**: sandbox が `workspace-write`（`read-only` への逆戻りを禁止 — 下記の理由）
- **D2**: 通知配線あり → prompt に `send.sh` と token が無傷で届く
- **D3**: 通知配線なし → `send.sh` を注入しない（後方互換）
- **D4**: prompt は常にちょうど 1 引数として codex に渡る（`'\''` エスケープ）
- **D5**: approval policy が `never`（無指定に戻すと codex が承認プロンプトで停止し、無人レビューが accept 待ちになる）
- **D6**: `--path` はファイル全文レビュー指示になり、パスが prompt へ無傷で届く
- **D7**: 存在しない `--path` は非ゼロ終了し、ペインを分割しない（無効指定でペインを撒かない）
- **D8**: `--list-targets` は cmux を呼ばずに候補を TSV 出力する（`CMUX_SOCKET_PATH` 不要）
- **D9**: 候補ゼロ（git リポジトリ外）でも空出力・終了コード 0 で終わる
- `--base` の反映 / `-m`・`-e` の不正値拒否
- **D10**: prompt に並列実行の語彙が 1 つも入らない（否定的不変条件。再導入を防ぐ）
- **D11**: 削除済みフラグ `--no-parallel` / `--agents` は**明示的に**非ゼロ終了し、ペインを分割しない
  （この bin の `*)` は追加レビュー指示へ落ちるため、拒否しないと黙って本文に混ざる）
- **D12**: 通知本文に `agents=` が入らず、prompt は常に 1 引数

```bash
bash apps/cmux-codex-review/test/test-monitor-only.sh
```

monitor 専用化の回帰テスト（静的検査。両プラグイン分をここで担保）:

- **M1**: 両プラグインから旧ポーリング watcher の bin が削除されている
- **M2**: 両プラグインの `.md` / `bin` に旧ポーリング watcher への参照が残っていない
- **M3**: 両プラグインの `commands/*.md` に「ターンを閉じて Monitor イベントで起きる」手順がある
- **M4**: 両プラグインの `commands/*.md` に単発タイマー保険（`run_in_background` + `sleep`）の手順がある
- **M5**: 並列実行が両プラグインから完全に消えている（`codex-parallel-lib.sh` が存在せず、
  `commands/**` / `skills/**` / `bin/**` に `spawn_agent` などの契約語彙が残らない否定的不変条件）
- **M6**: 両プラグインの `commands/**` / `skills/**` / `bin/**` に旧ポーリング watcher の契約語彙
  （`short-lived watcher` / `watcher's wait target` / `status=done|gone|timeout` / `--timeout` /
  `--interval` / `--liveness-interval`）が残っていない（否定的不変条件。具体名 1 つの grep = M2 では
  陳腐化した記述を捕まえられなかったため）

## 完了検知は agmsg Monitor の push、タイマーは保険

完了通知の待ち受けは、親セッションが SessionStart hook で起動する常駐 agmsg Monitor ストリームが担う。
親はターンを閉じて idle になり、codex の完了 `send.sh` が Monitor の 1 行として届くとそこで起きる
（2026-08-21 に実測済み。根拠は `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md`）。

この方式には `--surface` による即時のペイン死亡検知が無い。代わりに単発の `sleep` background task を
1 本保険として張る。タイマーで起きたときの規則は次の 4 つで、詳細は `commands/codex-review.md` の
Step 3 が正である:

1. **判断の前に永続記録を 1 回読む**。`history.sh <TEAM> <PARENT> 30 | grep -F "DONE <token>:" | tail -1`。**コロンまで含めて照合する**（token は surface 番号由来で `codex-review-4` は `codex-review-40` の前方一致になるため、裸の token では短い方の照合が長い方の完了に当たり、進行中を完了と誤報告する）。
   **`inbox.sh` は使わない**（競合 watcher に盗られた row は既読マークされるので「新着なし」と
   正直に答えてしまう）。直近 N 行に限って最も新しい一致を採るのは、token がペイン番号由来で
   再利用されうるため。完了 row があればタイマーの発火は「通知が失われただけ」を意味する
2. **ペイン消滅を断定する前に `cmux read-screen` を 1 回リトライする**（socket の一時的な失敗で
   誤検知しないため。旧 watcher は 2 回連続の失敗を要求していた）
3. **再武装に上限を設ける**（既定 3 回）。対話 codex ペインは終了しないので「生きている」を根拠に
   再武装すると無限ループになる。上限に達したら `read-screen` の内容を添えてユーザーへ報告する
4. **完了を受け取ったらタイマーを止める**（`TaskStop`）。止めないと 60 分後に無駄な wake が
   別の会話へ注入される

親が Monitor ストリームを実際に持っているかは、配線前に preflight で確認する
（`run/watch.<session_id>.*.pid` の存在と生存）。`join.sh` は登録だけで monitor モードを
有効にせず、`delivery.sh set monitor` が書く SessionStart hook は**実行中のセッションには
発火しない**ため、新規 join の直後は決定的に Monitor が無い。無ければ通知配線をスキップし、
成功しえないタイマーを張らない。

## サンドボックスを read-only にしてはいけない

完了通知の `send.sh` は agmsg の SQLite DB へ INSERT する（＝書き込み）。`~/.codex/config.toml` の
`[sandbox_workspace_write] writable_roots`（agmsg の db/teams/run）は **workspace-write モードにしか
適用されない**ため、`--sandbox read-only` にすると codex が通知を撃てず、親が永久に wake しない。
過去に read-only へ変更して通知が壊れた実績があるので戻さないこと。

## codex に並列を指示しない理由

codex の子エージェントは shared local app-server daemon 上の別スレッドで走り、ペインには映らない
（覗けるのは `codex agents` という別 TUI）。可視ペインで進行を追えることがこのプラグインの
設計意図そのものなので、追えない場所へ作業を逃がす指示とは両立しない。

**依頼しない限定であって、codex ができないという保証ではない。** collaboration tools は
`features.multi_agent_v2 = false` でも登録されたままである（codex-cli 0.149.1 で実測。
`codex debug prompt-input` に `functions.collaboration.*` が残り、`list_agents` の実呼び出しも成功する。
`multi_agent_v2.enabled=false` / `--disable multi_agent` / `--disable collaboration_modes` /
`non_code_mode_only=true` などのいずれでも消えない）。詳細は
`apps/cmux-codex-exec/CLAUDE.md` の同名の節に測定結果をまとめてある。

## 停滞検知は適用外

`cmux-codex-exec` と `cmux-team-dispatch-task` は `work-signal` で停滞を検知して
`dispatch-nudge:` を自動送信するが、**このプラグインは対象外**である。作業信号はコミットと
ファイル mtime を主成分にしており、レビューは何も書かないので、作業中のレビュアーと止まった
レビュアーが同じ `changed=no` に見えてしまう。ここでは `commands/codex-review.md` の Step 3b の
タイマー分岐（`history.sh` → `read-screen` 1 回リトライ → 再武装 3 回上限）だけが保険である。

## whoami の `suggest=true` に注意

`suggest=true` は「このプロジェクトは未参加」を意味する。出力に含まれる `teams=` / `agents=` は
**他プロジェクトの登録**であり、参加済みと誤読して使うと codex の通知先と親の Monitor が見ている team が
ズレて通知が届かなくなる。コマンドの Step 1 は必ず join を確認してから配線する。

## デフォルト

| 項目 | 値 | 上書き |
|------|-----|--------|
| model | `gpt-5.6-sol` | `-m` / `--model` |
| reasoning effort | `xhigh`（extra high） | `-e` / `--effort` |
| 対象 | `--uncommitted` | `--base <branch>` / `--commit <sha>` / `--path <file>`（繰り返し可） |
| 分割方向 | `right` | 位置引数 `down`/`left`/`up` or `-d` |
| 並列実行 | **無効**（codex には指示しない。`--no-parallel` / `--agents` は削除済みで、渡すと非ゼロ終了） | — |

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH` が必要）
- `codex` CLI が PATH 上にあること（`gpt-5.6-sol` / `xhigh` が利用可能な認証済み環境）

## 関連プラグインとの境界

- `cmux-fork` は「会話を新ペインにフォーク」する汎用分割。本プラグインは「codex にレビューさせる」専用途で、
  送信するのが対話 codex へのレビュープロンプトに固定されている点が異なる。
- `cmux-team-dispatch-task` の review 機能は dispatch されたタスクの plan/spec を codex が approve する
  オーケストレーション文脈のもの。本プラグインは単発の手元レビュー起動に特化する。
- `cmux-codex-exec`: 本プラグインの前段。exec が plan をカレントdirに実装し、完了後に本プラグインが
  その未コミット変更をレビューする想定の繋ぎ。

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- **`SKILL.md` / `commands/*.md` / `references/*.md`**: **英語必須**。日本語訳は `references/*-ja.md` に置く。
  詳細はルート `CLAUDE.md` の「Language convention」を参照。検証は `pnpm check:doc-lang`。
- **例外**: `SKILL.md` frontmatter の `description` は日本語可（起動トリガー語を残すため）。
