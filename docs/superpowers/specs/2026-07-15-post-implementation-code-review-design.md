# cmux-team-dispatch-task: 実装後コードレビュー (Phase B-R) 設計

日付: 2026-07-15
対象: `apps/cmux-team-dispatch-task`

## 背景 / 目的

Phase A-R（codex による plan/spec レビュー）は実装**前**の文書を対象とする品質ゲートであり、
実装**後**の成果物（コード）は誰のレビューも受けずに PR になる。

これを次のとおり改善する:

1. **実装後コードレビュー Phase B-R**: `review_mode` が有効なとき、実装完了（コミット済み）後・
   **PR 作成前**にコードレビューを挟む。指摘（needs_work）は実装者自身が修正し、approve が
   出るまでループしてから PR を作成する。PR は常にレビュー済みになる。
2. **レビュアーは実行モデルで切り替え**:
   - sonnet / codex が実装 → **計画を立てた opus ペイン**（Child セッション）がレビュー。
     計画コンテキストを保持したまま「実装が計画どおりか」を見られる。
   - opus 1m が実装（Child 自身が同一セッションで実装）→ **codex レビューペイン**
     （Phase A-R と同一ペイン・`review_model`）がレビュー。自己レビューのバイアスを避ける。
     レビューペインが利用不可（spawn 失敗済み）ならコードレビューを省略する。
3. **Child の deferred フロー変更**: sonnet / codex 委譲後に Child が即 exit する現行挙動を
   「exit せず idle 待機し、レビュー依頼を受けて応答、最終 approve 後に exit」へ変更する。

## 有効化条件

**Phase A-R と完全に同一**。新しい config キーは追加しない:

- `runners.json` に `engine: "codex"` + `review_model` 付き runner が存在する
- `review_mode` が `"on"` に解決される（解決フローは Phase A-R のまま変更なし）

`REVIEW_ENABLED` が false なら現行フローと完全に同一（後方互換）。Child は従来どおり
委譲後すぐ exit する。claude-teams レイアウトは Phase B 自体が無いため対象外。

## レビュアーの割り当て

| 実行モデル | レビュアー | 通信相手の解決 |
|-----------|-----------|--------------|
| sonnet | 計画 opus ペイン（Child） | prewarm 経路: `prewarm.json` の `.opus.surface_id` / `.opus.agent`（= `<slug>`）。spawn 経路: Child が依頼文に自身の `$CMUX_SURFACE_ID` を焼き込む |
| codex | 計画 opus ペイン（Child） | 同上 |
| opus 1m | codex レビューペイン（Phase A-R と同一ペイン） | Phase A-R Setup で解決済みの `REVIEW_SURFACE` / `REVIEW_DELIVERY` を流用 |
| opus 1m + レビューペイン利用不可 | （レビュー省略） | Phase A-R の spawn 失敗時と同じ「品質ゲートであってブロッカーではない」原則 |

## 全体フロー

```
Phase A   — opus で plan / brainstorming（現行どおり）
Phase A-R — codex による plan/spec レビュー（現行どおり）
Phase B   — 実行モデル選択（質問自体は現行どおり）
Phase B-R — コードレビューループ（REVIEW_ENABLED のときのみ・新設）
  - 実装者はコミット完了後・PR 作成前にレビュアーへ依頼
  - レビュアーは findings を <STATUS_DIR>/review/code-round-<N>.md に書き
    最終行に VERDICT: approve | needs_work
  - needs_work → 実装者が修正し（却下する指摘は反論を添えて）round N+1 を依頼。最大 3 往復
  - approve → 実装者が PR 作成 → /exit（status done 遷移は従来どおり standby wrapper が所有）
```

レビューポイント id は `code`（Phase A-R の `spec` / `plan` と衝突しない）。
verdict の受け渡しはファイル経由（Phase A-R と同一プロトコル）。

### 実行モデル別の詳細

**sonnet / codex 実装（prewarm 経路・spawn 経路とも）:**

1. Child は実行指示送信・`.deferred` touch 後、**exit せず turn を終えて idle 待機**する
   （`.deferred` は wrapper の exit 時挙動にのみ影響するため、touch タイミングは現行のまま）
2. 実装者への実行指示（REQUEST_TEXT）に以下を追記する:
   「全変更のコミット完了後・**PR 作成前**に、下記プロトコルで opus にコードレビューを依頼し、
   VERDICT: approve が出るまで修正 → 再依頼を繰り返すこと（最大 3 往復）。approve 後に
   PR を作成し /exit すること」+ レビュアーの宛先（agmsg の team/agent 名 or surface id）、
   verdict ファイルパス、round プロトコル
3. 実装者 → Child のレビュー依頼: agmsg（送信直前に ready sentinel
   `ready.${TEAM}__<slug>` を確認、無ければ `cmux send` + `send-key return` に倒す）
4. Child はレビュー依頼を受けたら `git diff $(git merge-base <base-branch> HEAD)...HEAD` と
   コミットログ、plan ファイルを参照してレビューし、
   `<STATUS_DIR>/review/code-round-<N>.md` に findings + VERDICT を書き、実装者へ完了通知
   （agmsg。倒れたら通知なし — 実装者は verdict ファイルをポーリングで検知）
5. needs_work → Child は turn を終えて次 round の依頼を idle 待機。
   **approve を書いたら Child は exit する**（`.deferred` 済みなので status.json は汚れない）
6. 実装者の verdict 待ち: agmsg push（実装者側 ready sentinel が生きている場合）または
   verdict ファイルの VERDICT 行ポーリング（5 秒間隔・15 分タイムアウト — Phase A-R と同値）

**opus 1m 実装:**

1. Child 自身が実装 → コミット完了後・PR 作成前に、Phase A-R の Setup で解決済みの
   レビューペイン（`REVIEW_SURFACE` / `REVIEW_DELIVERY`）へポイント id `code` として
   レビューを依頼する。round loop・通信分岐・timeout 処理は Phase A-R の Round loop を
   そのまま流用（依頼文が「文書」でなく「diff + plan 参照」になるだけ）
2. レビューペインが無い（Phase A-R Setup の spawn 失敗でスキップ済み）→ Phase B-R を
   省略して PR 作成へ進む

### ループ制御（3 往復で approve が出ない場合）

- 実装者が claude セッション（sonnet / opus 1m）→ AskUserQuestion:
  「コードレビューで 3 往復しても approve が出ませんでした。残りの指摘: <要約>。どうしますか？」
  1. このまま PR 作成 — 未解決指摘を PR 本文に注記して進む
  2. さらに修正 — もう 1 往復続ける（再度 needs_work なら再質問）
- 実装者が codex → 対話質問ができないため、**未解決指摘を PR 本文に注記して続行**する
  （REQUEST_TEXT にこの分岐を焼き込む）

## Child 待機まわりの整合

- 現行の「常時 4 ペイン維持」と自然に整合する: 現行では委譲後に Child セッションが exit して
  opus ペインだけ死んだ状態になるが、本変更後は全ペインが生きた idle セッションになる
- 実装者がレビューを依頼せずに終了・異常終了した場合、Child は idle のまま残るが、
  status done/error 遷移と親通知は standby wrapper（または spawn 経路の grandchild wrapper）が
  従来どおり行うため、ディスパッチ全体は停止しない。idle な Child ペインは既存の
  「全タスク完了時の最終クリーンアップ」で他ペインと一緒に close される（追加機構は不要）
- opus 1m 選択時は現行どおり Child が実装を続けるため、待機フローの変更は sonnet / codex
  委譲時のみ

## spawn 経路（prewarm 無効 / split レイアウト）への伝搬

prewarm.json が無い場合の `launch-workspace.sh --mode execute` spawn では、実行指示が
runner wrapper の composed prompt として焼き込まれるため、レビュープロトコルも同経路で渡す:

- `launch-workspace.sh --mode execute` に **`--review-config <path>`** オプションを追加する。
  指定時、wrapper は composed prompt に Phase B-R プロトコル（宛先 surface id / verdict
  ファイルパス / round loop / PR 前レビューの義務）を追記する
- Child は spawn 前に `<STATUS_DIR>/review/code-review.json`
  （`{ "reviewer_surface": "...", "team": "...", "reviewer_agent": "...", "delivery": "...", "review_dir": "..." }`）
  を書き、そのパスを `--review-config` に渡す
- `REVIEW_ENABLED` が false のときはオプション自体を渡さない（composed prompt は現行と同一）

## エラーハンドリング

| 状況 | 挙動 |
|------|------|
| verdict ファイルのポーリング timeout（15 分） | 同 round の依頼を 1 回だけ再送。再 timeout → claude 実装者は AskUserQuestion（再依頼 / レビュー省略して PR 作成）、codex 実装者はレビュー省略を PR 本文に注記して続行 |
| Child（レビュアー）が既に死んでいる（agmsg 不達 + cmux send 失敗） | レビュー省略。PR 本文に注記 |
| verdict ファイルはあるが VERDICT 行が無い | needs_work 扱いで 1 回だけ再依頼。それでも不正なら timeout と同じ分岐 |
| opus 1m 時にレビューペイン利用不可 | Phase B-R 省略（警告のみ） |
| 実装者がレビューを依頼せず exit | 検知・強制はしない。status 遷移は wrapper が従来どおり行い、idle Child は最終クリーンアップで close |

## ドキュメント整合（4 ファイルルール）

モデル選択フロー改変に該当するため **SKILL.md / guide-ja.md / README.md / CLAUDE.md の
4 ファイル同時更新**が必須:

- SKILL.md:
  - `MANDATORY MODEL SELECTION SEQUENCE` に `{{CODE_REVIEW_BLOCK}}` プレースホルダーを追加
    （`REVIEW_ENABLED` のときのみ親が焼き込む — `{{REVIEW_BLOCK}}` と同方式）。
    ブロック内に sonnet/codex 委譲時の「exit せず待機 → レビュー応答 → approve 後 exit」手順、
    opus 1m 時の code ポイント依頼手順、REQUEST_TEXT への追記文を記載
  - Phase B の各分岐（sonnet prewarm / sonnet spawn / codex prewarm / codex spawn）の
    REQUEST_TEXT と「exit THIS session」記述を `REVIEW_ENABLED` 条件付きに更新
  - `launch-workspace.sh --review-config` の使用例
- CLAUDE.md: メンテナンス手順に Phase B-R 整合チェック項目を追加、E2E テスト項目を追加
- guide-ja.md / README.md: 同内容を反映
- バージョン: `plugin.json` 1.6.2 → **1.6.3**、ルート `marketplace.json` も同期

## テスト（E2E 観点）

1. `review_mode` off → 現行フロー完全一致（Child は委譲後すぐ exit、レビュー依頼文なし）
2. `review_mode` on + sonnet 実行 → 実装者がコミット後・PR 前に opus へレビュー依頼し、
   opus が `review/code-round-1.md` に VERDICT を書く。approve → PR が作成され、
   opus Child が exit する
3. needs_work → 実装者が修正して round 2 を依頼、**同じ opus セッション**がレビューする
4. `review_mode` on + codex 実行 → 2 と同じフローが codex 実装者（shell 経由）でも機能する
5. `review_mode` on + opus 1m 実行 → codex レビューペインにポイント id `code` の依頼が送られ、
   Phase A-R と同一ペインが応答する
6. opus 1m + レビューペイン spawn 失敗済み → Phase B-R が省略され PR 作成へ進む
7. 3 往復 needs_work → claude 実装者は AskUserQuestion が出る / codex 実装者は PR 本文に
   未解決指摘が注記される
8. agmsg / send-message（cmux-send + ポーリング）両モードでレビュー往復が機能する
9. spawn 経路（prewarm 無効）→ `--review-config` 経由で composed prompt にプロトコルが
   追記され、レビュー往復が機能する
10. Phase B-R 中も status.json が汚れない（done 遷移は approve 後の実装者 exit 時に
    wrapper が書く）。実装者がレビューを依頼せず exit しても status 遷移と親通知が行われる
