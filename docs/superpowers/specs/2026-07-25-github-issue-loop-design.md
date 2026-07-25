# cmux-team-dispatch-task GitHub issue 自動ループ設計

- 対象プラグイン: `apps/cmux-team-dispatch-task`
- 作成日: 2026-07-25
- 改訂: round 1 / round 2 レビュー反映（2026-07-25）
- ステータス: 設計確定（実装計画は別途 `.claude/plans/github-issue-loop.md`）

## 1. 目的とスコープ

現行の cmux-team-dispatch-task は「ユーザーが渡したタスク一覧を一度だけ並列ディスパッチする」ワンショット型である。これを **GitHub issue を自動取得し、対象 issue がなくなるまで回し続ける loop モード** に拡張する。

本設計が満たす要件:

| 要件 | 内容 |
|------|------|
| 要件 1 | `gh issue list` で対象 issue を自動取得してタスク化し、バッチ単位で対象がなくなるまで繰り返す。二重ディスパッチを防ぐ |
| 要件 2 | ループ中に `AskUserQuestion` が一切発生しない。通常（非ループ）モードの挙動は不変 |
| 要件 3 | ループ開始前に必要な設定をまとめて質問し、以後ループ中は再質問しない |
| 要件 4 | codex 子セッション／standby ペインが承認待ちで停止しないことを全経路で保証する |

**非スコープ**（意図的に含めない。制約として §12 に明記する）:

- スロット方式（1 件完了ごとに次を投入）の並列制御 — バッチ方式を採用する
- ループ設定の永続化（config.json への保存）— 毎ループ開始時に質問する
- `claude-teams` / `split` レイアウトでのループ — workspace レイアウト固定
- **同一リポジトリに対する複数ループの並行実行** — GitHub ラベルでは原子的な claim を実現できないため、リポジトリ単位で単一オーケストレータを前提とし、ローカルロックで検出して拒否する
- **クラッシュしたループの自動再開** — 検出して安全側（人に返す）に倒す。走行中の子を引き継いで再開する機構は作らない
- レビューペインへの `--allow-unix-socket` 付与 — 現仕様でレビューペインは cmux CLI を使わない

## 2. 設計判断のサマリ

| 論点 | 決定 | 理由 |
|------|------|------|
| 駆動主体 | 親 Claude セッションが回す | 既存アーキテクチャをそのまま利用でき、新規スクリプトが最小で済む |
| バッチ完了待ちの実行主体 | **`batch-wait.sh` を親がフォアグラウンドで反復呼び出しする。timeout の terminal 化も `batch-wait.sh` 自身が行い、全 slug が terminal になるまで `ALL_TERMINAL` を返さない** | 親が idle に落ちると誰も deadline を評価しない。また timeout 検出で待機を抜けると、同一バッチの実行中タスクを残したまま cleanup へ送ってしまう |
| 設計フェーズの無人化 | plan モード固定 + `--dangerously-skip-permissions` | superpowers の brainstorming は承認ゲートを持ち無人実行と本質的に相容れない。設計品質は Phase A-R レビューで担保する |
| AskUserQuestion の除去方法 | **loop 用にレンダリングするブロックから質問分岐そのものを差し替える**（追加ブロックによる上書きではない） | 「後続の強い命令を先行する禁止文で打ち消す」方式は、命令が存在しないことの保証にならない |
| 二重防止 | GitHub ラベル 3 種 + サーバサイド除外クエリ + ローカル状態ファイル + リポジトリ単位ロック | ラベルは durable な処理済みマーク、サーバサイド除外は exhaustion 保証、ロックは並行実行の禁止 |
| 完了の判定 | **status = done を信用せず、cleanup 前に成果物の存在を検証する** | 既存 runner wrapper は TUI が exit 0 なら無条件に done を書く。exit 0 は PR 作成やコミットの成功を意味しない |
| ループ状態の置き場所 | **`.dispatch-loop/`（`.dispatch/` の外）** | 非ループ dispatch の cleanup が `rm -rf .dispatch/` を無条件実行するため、同居させるとループ状態ごと消える |
| 通常 dispatch との相互排他 | **通常 dispatch 側にも active loop lock の検査を入れて拒否する**（非ループ挙動への 2 つ目の明示的例外） | `.dispatch-loop/` 分離は「通常が先・ループが後」しか防げない。逆順ではタスクの `status.json` が消える |
| 並列制御 | バッチ方式（N 件同時 → 全完了 → 次バッチ） | 既存の「全タスク完了検知 → 集計」フローをバッチ単位で再利用できる |
| バッチ間 cleanup | status × integration の遷移表に従って決定的に実行する（§3.8） | 「必ず片付ける」だけでは merge 失敗時と調査用保持の扱いが決まらない |
| integration strategy | ループ開始前に 1 回選択 | ローカルブランチを削除してよいかがこれで決まる |
| error 時 | スキップして継続 | 大量 issue を回す目的に沿う。`dispatch/failed` ラベルで再取得されない |
| 上限 | 最大バッチ数を設定質問に含める | フィルタ条件の誤りによる暴走を防ぐ |
| ループ発動 | **`--loop` フラグが唯一の機械的 entry point**。自然言語トリガも認めるが Step L0-1 の確認を必ず通す | 通常のタスク文に issue の話題が混ざってもループへ誤分類しない |
| ドキュメント配置 | `references/loop-mode.md` に分離 | SKILL.md は既に 130KB / 2286 行。非ループ利用者の読み込み量を増やさない |

## 3. アーキテクチャ

### 3.1 全体フロー

```
[分岐] 呼び出し入力に --loop が含まれる、またはユーザーが「issue を自動で回す / ループ」を
       明示的に要求している場合のみ Step L0 へ。それ以外は既存 Step 1a へ直行し、
       L0 のスクリプト・質問・ロック・状態操作は一切実行しない。

Step L0  プリフライト（read-only の probe のみ。状態を一切書き換えない）
  L0-1  発動確認: --loop が無い（自然言語トリガ）の場合のみ
          「ループモードで開始しますか」を 1 問確認する
  L0-2  依存検査: runners.json / gh auth status / issue が有効 / jq / cmux / codex(任意)
  L0-3  ロックの事前確認（取得はしない）: .dispatch-loop/loop.lock.d が存在し
          owner.json の heartbeat が lease 内なら「別のループが実行中」としてエラー終了
Step L1  ループ設定の一括質問（AskUserQuestion 最大 3 コール）
  L1-末  最終確認を通過した直後に issue-fetch.sh ... lock-acquire でロックを取得する。
           質問への回答待ちは人間の時間なので、ここより前にロックを取ると
           heartbeat の更新空白が無制限に伸びる（§3.4）
         ── ここから先、ループが終わるまで一切質問しない ──
Step L1.5  ロック取得後の authoritative なプリフライト（状態を書き換える処理はすべてここ）
  L1.5-1  reconcile: loop-state.json があれば状態を突き合わせる
            - status=claimed で workspace が生存 → 中止（走行中の子がいる。人に返す）
            - status=claimed で workspace が消滅 → release（ラベル除去 + レコード削除）
            - status=dispatched → 中止（前回の中断。人に返す）
  L1.5-2  stale 検査: .dispatch/ に <slug>/ ディレクトリが残っていればエラー終了し、
            手動整理を促す（空ディレクトリは削除して続行してよい）
  L1.5-3  ラベル整備: dispatch/in-progress, dispatch/done, dispatch/failed を
            gh label list で確認し、無いものだけ gh label create する（失敗は fatal）
  ※ L1.5 のいずれかで中止する場合も必ず lock-release してから終了する
Step L2  バッチループ（batch = 1, 2, ...）:
  L2-1  issue-fetch.sh --state-file .dispatch-loop/loop-state.json fetch \
          --limit <concurrency> --batch <N> [...]
          → exit 0 かつ [] なら「対象 issue なし」で Step L3 へ（exhaustion 確定）
          → exit 3（候補はあったが claim が 1 件も成立しなかった）なら
            警告してループを中断し Step L3 へ（無限空回りを防ぐ）
          → exit 4（取得窓の安全上限に達しても候補が尽きたと確認できない）なら
            警告してループを中断し Step L3 へ（対象を残したまま正常終了しない）
  L2-2  既存 Step 1b / Step 2 の手順でタスクプロンプトを構築
          （plan モードのテンプレート + unattended variant のレビューブロック）
  L2-3  workspace レイアウト + pre-warm で一斉起動
          - 起動成功 → issue-fetch.sh ... mark-dispatched --issue <n>
          - 起動失敗 → issue-fetch.sh ... release --issue <n>（待機対象から除外）
  L2-4  batch-wait.sh を "WAITING" が返る限りフォアグラウンドで呼び直す
          （1 回あたり最大 540 秒。抜けるのは ALL_TERMINAL のときだけ）
          deadline 超過 slug の error 化は batch-wait.sh 自身が行うため、
          「1 件 timeout・1 件まだ実行中」でも待機は継続される
          呼び出しのたびに owner.json の heartbeat が更新される
  L2-5  Template B で結果報告 → loop-cleanup.sh でバッチ cleanup
  L2-6  batch++ → 最大バッチ数チェック → L2-1 へ
Step L3  ループ全体サマリ（Template C を batch 列付きに拡張）+ ロック解放
         ※ ループを中断する全経路でも必ず lock-release を呼んでから終了する。
            対象: L1.5-1 の abort / L1.5-2 の stale 検出 / L1.5-3 のラベル作成失敗 /
            L2-1 の exit 1・3・4 / L2-4 の batch-wait.sh exit 1 /
            L2-5 の loop-cleanup.sh exit 1 / ユーザーによる中断
```

### 3.2 コンポーネント一覧

**新規ファイル（4 点）**

| ファイル | 責務 | 依存 |
|---|---|---|
| `skills/cmux-team-dispatch-task/references/loop-mode.md` | ループ手順の SoT。L0〜L3、一括設定質問、ラベル遷移表、cleanup 遷移表、完了検証の契約 | なし（ドキュメント） |
| `skills/cmux-team-dispatch-task/scripts/issue-fetch.sh` | issue の取得 / 除外 / claim / release / mark-dispatched / reconcile / finalize と `loop-state.json` とロックの管理 | `gh`, `jq`, `git` |
| `skills/cmux-team-dispatch-task/scripts/batch-wait.sh` | バッチ内 slug 集合の terminal 待機とタイムアウト判定、heartbeat 更新 | `jq`, `cmux` |
| `skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh` | ループ用タスクプロンプトの決定的な組み立て（§4.5） | なし |
| `skills/cmux-team-dispatch-task/references/unattended/*.md` | ループ用プロンプトに逐語で入る確定文面（3 ファイル） | なし（ドキュメント） |
| `skills/cmux-team-dispatch-task/scripts/loop-cleanup.sh` | 完了検証 → WIP 保全 → pane close / worktree / branch / issue ラベル / 状態記録 | `cmux`, `gh`, `jq`, `git` |

**変更ファイル**

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team-dispatch-task/SKILL.md` | ① ループ発動のディスパッチポイント（約 10 行）＋ Step 1c–1g / cleanup 節への「loop モードでは `references/loop-mode.md` の一括設定で解決済み」注記 ② **Step 1 冒頭と cleanup 節に active loop lock のガードを追加**（§3.4） |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ① codex 全経路に `--dangerously-bypass-hook-trust` を追加（要件 4）② `--unattended` フラグを追加し、`--mode execute` の `REVIEW_INSTRUCTION` の質問分岐を非対話版に差し替える ③ runner wrapper の `write_status` が既存 status.json の `pr_url` を引き継ぐようにする（既存バグの修正）④ `--timeout-sentinel <path>` オプションを追加し、runner wrapper にその path のガードを焼き込む（§3.7.1。ループ経路のみ渡すため非ループの wrapper は不変） |
| `skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh` | `--unattended` フラグを追加。指定時、設計ペイン（claude opus standby）に `--skip-permissions` を付与する |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | ループモード節、engine × MODE 起動表、`--unattended`、`pr_url` 引き継ぎ |
| `README.md` | ループモードの利用者向け説明、codex 起動フラグ表、hook trust バイパスの注記 |
| `CLAUDE.md` | メンテナンス手順の項目追加、項目 20 / 39 の更新、E2E テスト項目の追加 |
| `.claude-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` | version 1.9.0 → 1.10.0 |
| `test/test-launch-workspace-codex.sh` | hook trust バイパス、`--unattended`、`pr_url` 引き継ぎの静的検査を追加 |
| `test/test-issue-fetch.sh`（新規） | 取得クエリ生成・除外・exhaustion 判定・claim/release/reconcile・ロック排他の検査（`gh` はスタブ化） |
| `test/test-batch-wait.sh`（新規） | timeout 混在バッチの待機継続・timeout の terminal 化・heartbeat 更新の検査 |
| `test/test-loop-cleanup.sh`（新規） | 完了検証の降格・WIP 保全（未追跡 / binary）・merge conflict 時の温存の検査 |
| `test/test-loop-prompt.sh`（新規） | loop 用にレンダリングしたプロンプト 2 経路に質問分岐が残らないことの検査 |
| `test/test-codex-review-sandbox.sh`（新規） | `codex sandbox` による sandbox write root / denial / `git diff` の動的検査 |

`monitor-dispatch.sh` は**変更しない**。ループモードでは使用しない（§3.7）。

### 3.3 新規スクリプトの CLI 契約

すべての呼び出しは `--state-file <path>` を先頭に置き、続いてサブコマンドと固有オプションを取る。**フロー中の記述も必ずこの完全形で書く**（round 2 finding 8）。

**`issue-fetch.sh`**

```
issue-fetch.sh --state-file <path> <subcommand> [options]

  lock-check                              取得せずに active loop の有無だけを判定（Step L0-3 用。
                                          read-only でディレクトリも作らない）
  lock-acquire  --lease-min <N>           .dispatch-loop/loop.lock.d を mkdir で atomic 取得
  lock-release                            自分が owner のときだけ解放（冪等）
  heartbeat                               owner.json の heartbeat を現在時刻に更新
  init --config-json <json> --filter-json <json>
                                          loop-state.json を完全なスキーマで atomic 生成
                                          （既存があれば config / filter だけ差し替える）
  reconcile                               claimed / dispatched の突き合わせ（§3.1 L1.5-1）
                                          出力: {action: "ok"|"abort", reasons: [...]}
  ensure-labels                           3 ラベルを gh label list で確認し不足分を作成
  fetch         --limit <N> --batch <N> [--labels <a,b>] [--assignee <@me|none>]
                [--state <open|all>] [--dry-run]
  mark-dispatched --issue <n>
  release         --issue <n>
  finalize        --issue <n> --status <done|error|timeout>
                  [--pr-url <url>] [--message <s>]

stdout: fetch のみタスク JSON 配列（§3.5）。reconcile は判定 JSON。他は無出力
exit  : 0 = 正常。fetch の 0 件は「候補が尽きた」ことが確認できた場合のみ
        1 = 致命的失敗（gh / jq 不在、認証エラー、loop-state.json 破損、ロック取得失敗）
        3 = fetch で候補は存在したが claim が 1 件も成立しなかった
        4 = EXHAUSTION_UNKNOWN。取得窓を安全上限まで拡張しても窓が満杯のままで、
            候補が尽きたと確認できなかった（§3.6）
stderr: [fetch] / [claim] / [release] / [lock] / [warn] のログ
```

`lock-check` / `lock-acquire` を除くすべてのサブコマンドは、処理の冒頭で **owner token の検証と heartbeat の更新**を行う（§3.4）。検証に失敗した場合は何も書かずに exit 1 で終了する。

`fetch` は次の 3 つを厳密に区別する。同一視するとループが対象を残したまま正常終了したり、無限に空回りしたりする。

| 状況 | 返り値 |
|---|---|
| サーバ側の候補が尽きた（返却件数 < 窓） | exit 0 + `[]` |
| 候補はあったが claim が 1 件も成立しなかった | exit 3 |
| 安全上限まで窓を広げても満杯のまま（尽きたか不明） | exit 4 |

**`batch-wait.sh`**

```
batch-wait.sh --state-file <path> --batch <N> --timeout-min <N> [--max-wait-sec 540]

指定バッチで status=dispatched の slug 集合を loop-state.json から引き、
<dispatch-dir>/<slug>/status.json を 5 秒間隔でポーリングする。
呼び出しのたびに .dispatch-loop/loop.lock.d/owner.json の heartbeat を更新する。

deadline（claimed_at + timeout-min）を超えた slug は、このスクリプト自身が
  - .dispatch-loop/timed-out/<slug> を作成（runner wrapper の late write を封じる sentinel。
    タスクディレクトリの外なので cleanup で消えない。§3.7.1）
  - <dispatch-dir>/<slug>/status.json を status=error / message="timeout after N min" に書き換え
  - loop-state.json の当該 issue を status=timeout に更新
して terminal 化する。書き換えに失敗した場合は loop-state.json.leaked[] に記録し、
その slug を terminal とみなして待機から外す（同じ slug で無限に留まらない）。

stdout（1 行）:
  ALL_TERMINAL <done>/<error>/<timeout>   バッチの全 slug が terminal に到達
  WAITING <terminal>/<total> [timed-out:<n>]
                                          max-wait-sec 内に決着せず（親が呼び直す）
exit  : 0（上記いずれも）/ 1 = 致命的失敗

親が待機を抜けるのは ALL_TERMINAL のときだけである。
```

**timeout を検出しても待機を抜けない。** 各タスクの `claimed_at` は少しずつ異なるため、1 件が deadline に達した時点で他のタスクが期限前かつ実行中であることは普通に起こる。そこで一部だけを terminal 化して `break` すると、実行中の pane を持つタスクを cleanup 遷移表に無い状態のまま渡すことになる（round 3 finding 1）。timeout の terminal 化を `batch-wait.sh` の内部処理にし、`ALL_TERMINAL` を「バッチの全 slug が done / error / timeout に到達した」ことの唯一の合図とすることで、この経路を閉じる。

`--max-wait-sec` の既定 540 は、親が使う Bash 実行の上限（600 秒）に収めるための値である。deadline 判定は `loop-state.json` の `claimed_at` からの絶対時刻で行うため、呼び直しの回数に依存しない。

**`loop-cleanup.sh`**

```
loop-cleanup.sh --state-file <path> --batch <N> --integration <pr|merge>
                [--dispatch-dir <path>] [--repo-root <path>] [--agmsg-team <team>]

stdout: {batch, done, error, timeout, merged, conflicted, unverified, leaked}
exit  : 0 = 正常（個別の失敗は警告扱いでループを止めない）
        1 = 致命的失敗（loop-state.json 破損）
```

`unverified` は §3.8 の完了検証に落ちて `error` に降格した slug、`leaked` は削除に失敗した worktree / branch。いずれも `loop-state.json` に記録し、Step L3 のサマリで手動整理対象として提示する。

### 3.4 ループ状態の置き場所とロック

ループ固有の状態は **`.dispatch-loop/`** に置く。`.dispatch/` に置かない理由は、非ループ dispatch の cleanup が最後に `rm -rf .dispatch/` を無条件で実行するため、同居させるとロックと状態が丸ごと消え、通常 dispatch とループの同時実行が静かに壊れるからである。

```
.dispatch-loop/
  loop-state.json          ループ状態（§3.5）
  loop.lock.d/             ロックディレクトリ（mkdir で atomic 取得）
    owner.json             {session_id, host, started_at, heartbeat}
  loop.lock.stale.<ts>.<session_id>/   stale takeover 時に退避された旧ロック
  timed-out/<slug>                     timeout sentinel（§3.7.1）。タスクディレクトリより
                                       長生きさせる必要があるためここに置く
```

タスクの `STATUS_DIR` は従来どおり `.dispatch/<slug>` を使う（`launch-workspace.sh` との互換のため）。

**ロックの契約**

| 項目 | 内容 |
|---|---|
| 取得 | `mkdir .dispatch-loop/loop.lock.d` の成否で判定する（check-then-write の競合を排除） |
| **取得タイミング** | **Step L1 の最終確認を通過した直後**。Step L0-3 は存在確認だけを行い取得はしない。設定質問への回答待ちは人間の時間であり、ここでロックを持つと heartbeat の更新空白が無制限に伸びる（round 4 finding 3） |
| owner identity | `$LOOP_SESSION_ID`、無ければ `$CLAUDE_CODE_SESSION_ID` + ホスト名。shell の `$$` や時刻は使わない（サブコマンドごとに別プロセスなので値が変わり、acquire 直後の heartbeat すら別 owner と判定される）。**どちらも得られない環境ではループを開始しない** |
| **liveness の正本** | **`owner.json.heartbeat` の 1 箇所のみ**。`loop-state.json` は heartbeat を持たない |
| **heartbeat の更新契約** | `issue-fetch.sh` / `batch-wait.sh` / `loop-cleanup.sh` の**すべてのサブコマンドが、処理の冒頭で owner token を検証し heartbeat を更新する**。これにより待機中だけでなく、issue 取得・ペイン一斉起動・cleanup といった長時間処理の最中も鮮度が保たれる |
| **lease 期間** | `task_timeout_min` とは切り離した独立の設定 `loop.lock_lease_min`（既定 30、最小 10）。タスクのタイムアウトを短く設定してもロックが誤って stale 判定されない |
| 生存判定 | `owner.json.heartbeat` が `lock_lease_min` 以内なら実行中と判断し、取得を拒否する |
| **owner token 検証** | `loop-state.json` を書き換えるすべての操作の前に `owner.json.session_id` が自分と一致することを確認する。一致しなければ（takeover された）その場で fatal 終了し、書き込みを行わない |
| **in-flight の保護** | `loop.lock.d` は存在するが `owner.json` がまだ無い（または壊れている）状態は、`mkdir` に勝った直後の書き込み途中の可能性がある。有限 grace（60 秒）以内なら **live として扱い奪わない**。grace を過ぎたら stale とみなす（無条件に live にすると永久に takeover できなくなる） |
| **stale takeover** | rename だけでは直列化にならない。A と B が同時に stale と判定 → A が退避＋再作成して owner になった直後に、stale 判定済みの B が **A の新しいロック**を退避してしまう ABA 競合が残る。そこで takeover 全体を別の atomic mutex `mkdir .dispatch-loop/loop.lock.takeover.d` で直列化し、**mutex を取得したプロセスが mutex 内で staleness を再判定**してから退避＋再作成する。mutex は取得者が必ず解放する |
| 解放 | `owner.json.session_id` が自分と一致する場合のみ削除する（他 owner のロックを消さない）。一致しなければ警告して何もしない |
| 解放の呼び出し箇所 | Step L3 に加え、**ループを中断する全経路**: L1.5-1 の abort / L1.5-2 の stale 検出 / L1.5-3 のラベル作成失敗 / L2-1 の exit 1・3・4 / L2-4 の `batch-wait.sh` exit 1 / L2-5 の `loop-cleanup.sh` exit 1 / ユーザー中断。`references/loop-mode.md` に手順として明記する |

`owner.json` の上書きによる takeover は、2 プロセスが同時に stale と判定すると両方が owner になれてしまい、初回の `mkdir` で排除した競合を再導入する（round 3 finding 3）。rename 方式ならディレクトリの移動が atomic なので、勝者は必ず 1 つに定まる。退避されたディレクトリはそのまま残し、Step L3 のサマリで手動確認対象として提示する。

同一マシン上の並行ループはこれで防げる。別マシンからの同時実行は検出できないため、運用上の約束とする（§12）。

**通常 dispatch との相互排他（逆方向）**

`.dispatch-loop/` への分離だけでは「通常 dispatch が先、ループが後」の順序しか防げない。ループ開始後に通常 dispatch が起動すると、通常側は loop lock を見ないまま完了時に `rm -rf .dispatch/` を実行し、走行中ループのタスク `status.json` / `prewarm.json` を消す（round 3 finding 4）。

タスクの `STATUS_DIR` を `.dispatch-loop/tasks/<slug>` へ移す案も検討したが、`launch-workspace.sh` / `prewarm-panes.sh` / SKILL.md の手順・cleanup の広範囲に影響し、「通常挙動不変」を大きく崩すため採らない。代わりに **通常 dispatch 側に 2 箇所のガードを入れる**:

1. SKILL.md Step 1 の冒頭 — `.dispatch-loop/loop.lock.d/owner.json` が存在し heartbeat が新しければ、「issue ループが実行中です」と伝えて dispatch を開始しない
2. SKILL.md の cleanup 節 — `rm -rf .dispatch/` の直前に同じ検査を行い、生きたロックがあれば `.dispatch/` の一括削除をスキップして当該タスクのディレクトリのみ削除する

これは非ループ挙動への **2 つ目の明示的な例外**である（1 つ目は §6.5 の hook trust）。動作が変わるのは「ループ実行中に通常 dispatch を始めようとしたとき」だけであり、ループを使わない環境では `.dispatch-loop/` が存在しないため検査は常に素通りする。この点は §6.5 と同じ形で README / CLAUDE.md に明記する。

### 3.5 データ構造

**`.dispatch-loop/loop-state.json`**

```json
{
  "started_at": "2026-07-25T10:00:00Z",
  "filter": { "labels": ["enhancement"], "assignee": "@me", "state": "open" },
  "config": {
    "concurrency": 3, "max_batches": 5, "integration": "pr",
    "design_runner": "claude", "exec_choice": "sonnet", "review_mode": "on",
    "task_timeout_min": 90, "lock_lease_min": 30
  },
  "batches": [
    { "n": 1, "issues": [12, 13], "started_at": "...", "finished_at": "..." }
  ],
  "issues": {
    "12": { "slug": "issue-12-fix-login", "status": "done", "pr_url": "https://…",
            "batch": 1, "claimed_at": "...", "dispatched_at": "..." },
    "13": { "slug": "issue-13-add-cache", "status": "error", "message": "…",
            "batch": 1, "claimed_at": "...", "dispatched_at": "..." }
  },
  "leaked": []
}
```

`status` の遷移:

```
claimed ──(launch 成功 + mark-dispatched)──> dispatched ──> done | error | timeout
   └──(launch 失敗 / reconcile で workspace 消滅を確認)──> レコード削除（release）
```

`claimed_at` はタイムアウトの起点、`dispatched_at` は記録用。書き込みは常に **同一ディレクトリの一時ファイル + `mv`（atomic replace）** で行う。

**`loop-state.json` は `heartbeat` を持たない。** liveness の正本は `.dispatch-loop/loop.lock.d/owner.json` の 1 箇所に統一する（§3.4）。2 箇所に分けると、待機中に owner.json が更新されないまま stale と誤判定される経路が生まれる。

**タスク JSON（`issue-fetch.sh ... fetch` の stdout）**

```json
[
  { "number": 12, "slug": "issue-12-fix-login", "title": "Fix login redirect",
    "url": "https://github.com/owner/repo/issues/12", "body": "…" }
]
```

`slug` は `issue-<number>-<title を lowercase・ハイフン化したもの>` を 30 文字で切り詰めた値。`[A-Za-z0-9._-]` のみを残す（`launch-workspace.sh` の workspace 名バリデーションに合わせる）。

### 3.6 issue 取得と二重ディスパッチ防止

**ラベル体系（3 種）**

| ラベル | 意味 | 付与 | 除去 |
|---|---|---|---|
| `dispatch/in-progress` | claim 済み・作業中 | claim 時 | 完了時に `done` / `failed` へ付け替え、または release 時 |
| `dispatch/done` | 処理済み（PR 作成済み or merge 済み） | 完了検証を通った done 時 | 付けたまま残す（durable な処理済みマーク） |
| `dispatch/failed` | 失敗・要調査 | error / timeout / merge conflict / 完了検証落ち | 付けたまま残す |

`dispatch/done` を残すことが、**PR がマージされるまで issue が open のままでも再ディスパッチされない**ことの保証になる。integration = `merge` で merge が成功した場合はさらに `gh issue close --reason completed` を実行する（`Closes #N` を持つ PR が存在しないため）。

**取得クエリ — サーバサイド除外で exhaustion を保証する**

固定倍率でローカル除外する方式は「先頭 4N 件がすべて処理済みで、その先に未処理 issue がある」場合に対象を残したまま「対象なし」と誤判定する。これを避けるため、**dispatch ラベルの除外をサーバ側の search qualifier で行う**:

```bash
SEARCH="-label:dispatch/in-progress -label:dispatch/done -label:dispatch/failed"
[[ "$ASSIGNEE" == "none" ]] && SEARCH="$SEARCH no:assignee"

gh issue list --state "$STATE" [--label "$LABEL"] \
  [--assignee @me]                # @me のときだけ --assignee を使う
  --search "$SEARCH" \
  --limit "$FETCH_LIMIT" --json number,title,body,url,labels
```

- **`--assignee none` という値は `gh issue list` に存在しない。** 未割当は `--search "no:assignee"` で表現する（round 2 finding 3）。`--assignee` フラグを使うのは `@me` のときだけ
- ローカル除外は `loop-state.json.issues` に登録済みの番号のみ（サーバ側の反映遅延と、ラベル除去に失敗した release の保険）
- `FETCH_LIMIT` は `LIMIT * 2` から始め、ローカル除外後に `LIMIT` 件に満たず、かつサーバの返却件数が `FETCH_LIMIT` に達していた（＝まだ先がある）場合は `FETCH_LIMIT` を倍にして再取得する

**窓の拡張は「返却件数 < 窓」になるまで続ける。** 固定回数（round 2 時点では 3 回）で打ち切ると、最終試行でも窓が満杯かつローカル除外で全滅した場合に、その先に対象があるかどうかが分からないまま `[]` を返してしまう（round 3 finding 2）。ラベル更新の失敗を警告扱いで続行する設計や GitHub search index の反映遅延があるため、これは現実に起こり得る。

したがって終了条件を次のように定める:

| 状況 | 判定 | 返り値 |
|---|---|---|
| 返却件数 < `FETCH_LIMIT`（サーバ側の候補が尽きた）かつ claim 可能なものが 0 件 | exhaustion 確定 | exit 0 + `[]` |
| 返却件数 < `FETCH_LIMIT` かつ claim が 1 件以上成功 | 正常 | exit 0 + タスク JSON |
| 返却件数 == `FETCH_LIMIT` かつローカル除外で 0 件 かつ `FETCH_LIMIT < MAX_WINDOW` | 窓を広げて再取得 | （継続） |
| 返却件数 == `FETCH_LIMIT` かつローカル除外で 0 件 かつ `FETCH_LIMIT == MAX_WINDOW` | **exhaustion 不明** | exit 4 |

窓の拡張は一意な式で定める（round 4 finding 5）:

```
MAX_WINDOW = 1000
FETCH_LIMIT      = min(LIMIT * 2, MAX_WINDOW)
FETCH_LIMIT_next = min(FETCH_LIMIT * 2, MAX_WINDOW)
```

これにより `--limit` に渡る値が `MAX_WINDOW` を超えることはなく、かつ打ち切り前に必ず 1000 を一度問い合わせる。exit 4 を返すのは「`--limit 1000` で問い合わせて 1000 件返り、そのすべてがローカル除外された」場合に限られる。

exit 4 を受けた親は、対象を残したまま正常終了せず、警告を出してループを中断し人に返す（§3.1 L2-1）。安全上限 1000 は `gh issue list` の実用的な上限であり、これを超える規模はフィルタ条件の見直しが必要な状況である。

**claim（着手マーク）**

```bash
gh issue edit "$n" --add-label dispatch/in-progress
```

- ラベルの存在確認と作成は Step L1.5-3（`ensure-labels`）で行う。`gh label list --json name` で列挙し、無いものだけ `gh label create` する。**`|| true` では潰さない** — 認証・権限・通信エラーを「既に存在」と誤認しないため、作成失敗はループ開始を止める
- **claim に失敗した issue はそのバッチから除外する**
- claim 成功と同時に `issues["<n>"] = {slug, status: "claimed", batch: N, claimed_at: now}` を書く
- 候補が 1 件以上あったのに claim が 1 件も成立しなかった場合は exit 3 を返す

**claim 後・起動前の失敗と中断の扱い**

| 事象 | 対応 |
|---|---|
| プロンプト構築 / worktree 作成 / pane 起動が失敗 | `release --issue <n>` でラベルを外し状態から除去。そのバッチの待機対象に含めない |
| 親が `claimed` の状態で落ちた | 次回 Step L1.5-1 の `reconcile` が workspace の生存を確認し、消滅していれば release、生存していれば中止して人に返す |
| 親が `dispatched` の状態で落ちた | 走行中の子がいる可能性が高いため `reconcile` は中止を返す。人が状況を確認する |
| バッチの一部だけ起動成功 | 成功分のみ `mark-dispatched` して待機。失敗分は release 済みなので待機対象に含まれず、タイムアウト待ちも発生しない |

`reconcile` を stale 検査（L1.5-2）より**前**に置くのは、`.dispatch/<slug>/` の存在だけで即中止すると reconciliation が永久に走らなくなるためである。

**部分失敗で「ラベルと state の片方だけ」を残さない。** どちらか一方だけが残ると、その issue は
サーバサイドの negative qualifier で永久に除外されたまま、ローカルの追跡記録も無い状態になり、
二度と拾えなくなる。したがって:

| 場面 | 規則 |
|---|---|
| claim（ラベル付与 → state 書き込み） | state を書けなければラベルを補償的に外す。**その除去にも失敗したら fatal** で人に返す（握り潰さない） |
| `release` / `reconcile`（ラベル除去 → レコード削除） | ラベル除去の**成功を確認できるまでレコードを消さない**。`gh` が使えない場合も「確認できない」に含める |
| cleanup のラベル遷移 | terminal ラベルを先に付けてから `in-progress` を外す（§3.6） |

### 3.7 バッチ完了待ち（`batch-wait.sh`）

**`monitor-dispatch.sh` はループモードでは使用しない。** 既存 monitor は `--dispatch-dir` 配下の `*/status.json` を全件走査するため、前バッチで保持した failed ディレクトリや非ループ dispatch の痕跡が 1 件でもあると次バッチの待機が終わらない。

**待機に実行主体を与える。** 親 Claude セッションがターンを終えて idle になると deadline を評価する主体がいなくなり、まさに timeout 対象である hung child は完了通知も送らないため、誰も待機を打ち切れない。したがって待機は**親のターン内の同期処理**とする:

```
L2-4:
  loop:
    OUT=$(batch-wait.sh --state-file .dispatch-loop/loop-state.json \
            --batch <N> --timeout-min <T> --max-wait-sec 540)
    case "$OUT" in
      ALL_TERMINAL*) break ;;
      WAITING*)      進捗を 1 行報告して loop を続ける ;;
      *)             exit 1 扱い: lock-release してループを中断 ;;
    esac
```

- `batch-wait.sh` の出力は **`ALL_TERMINAL` と `WAITING` の 2 種類だけ**である。timeout は親に返らず、スクリプト内部で terminal 化される（§3.3）
- terminal 集合は **`done` / `error` / `timeout`** の 3 つ。`ALL_TERMINAL` はバッチの全 slug がこのいずれかに達したことを意味する
- deadline は `loop-state.json` の `claimed_at` からの絶対時刻で判定するため、呼び直しの回数に依存しない
- 呼び出しのたびに `owner.json.heartbeat` を更新するので、待機中もロックの鮮度が保たれる
- 完了通知（`[dispatch] task "<slug>" finished`）は届けば親の応答を早めるが、**待機の正はあくまで status.json のポーリング**である

**タイムアウト値**: 既定 90 分。`<project>/.dispatch/config.json` → `~/.claude/cmux-team-dispatch-task/config.json` の順で `loop.task_timeout_min` を解決する（設定質問には含めない）。

### 3.7.1 timeout 済みタスクの late write を防ぐ

`batch-wait.sh` が deadline 超過を terminal 化しても、その子プロセスはまだ生きている。現行 `launch-workspace.sh` の runner wrapper は、子が終了した時点で `write_status "done"|"error"` を無条件に実行し、`write_status` 自身が `mkdir -p "$STATUS_DIR"` する。放置すると 2 つの競合が起きる（round 4 finding 2）:

- cleanup が読む前に `timeout` が `done` へ戻る
- cleanup が `.dispatch/<slug>` を削除した後に wrapper が `mkdir -p` して stale directory を復活させ、次回ループの Step L1.5-2 が拒否する

**修正**: `.deferred` / `.assigned-<name>` と同じ sentinel パターンで構造的に塞ぐ。ただし **sentinel は `.dispatch/<slug>/` の外に置く**。

sentinel を `<STATUS_DIR>/.timed-out` に置くと、cleanup が `.dispatch/<slug>` を削除した時点で sentinel も消える。`cmux close-workspace` が runner wrapper の終了完了まで同期的に待つという契約は無いため、「close → タスクディレクトリ削除（sentinel 消滅）→ wrapper の終了処理」という順序が成立し、`write_status` の `mkdir -p` がディレクトリを復活させてしまう（round 5 finding 2）。sentinel の寿命はタスクディレクトリより長くなければならない。

1. sentinel の置き場所は **`.dispatch-loop/timed-out/<slug>`**（タスクディレクトリの外なので cleanup の `rm -rf .dispatch/<slug>` では消えない）。ループ終了時の Step L3 まで残す
2. `batch-wait.sh` は terminal 化と同時にこの sentinel を作成する
3. `launch-workspace.sh` に `--timeout-sentinel <path>` オプションを追加し、runner wrapper に `.deferred` の判定と同じ位置で **その path が存在すれば status.json を書かずに exit する**ガードを焼き込む（`mkdir -p` も走らないためディレクトリ復活が起きない）。ループ経路だけがこのオプションを渡すため、非ループの wrapper は現行と完全に同一のまま
4. `loop-cleanup.sh` は **`loop-state.json` の `timeout` を authoritative** とし、後着の `status.json = done` を成功に読み替えない

あわせて Step L1.5-2 の stale 検査は、**空ディレクトリの `.dispatch/<slug>/` は削除して続行**してよいものとする（万一の残骸でループ開始を止めない二重の保険）。

### 3.8 完了検証とバッチ間 cleanup（`loop-cleanup.sh`）

#### 3.8.1 完了検証（cleanup の前提）

`launch-workspace.sh` の runner wrapper は、TUI が exit 0 で終われば無条件に `status.json` を `done` として書く。対話セッションの正常終了は commit / push / PR 作成 / merge の成功を意味しない。この `done` を根拠に `dispatch/done` を永続付与し、さらに worktree と branch を削除すると、**未完成のタスクを永久に再取得対象外にしたうえで唯一のローカル作業を消す**ことになる（round 2 finding 5）。

そこで cleanup は、まず成果物の存在を独立に検証する:

| integration | 検証内容（すべて満たすこと） |
|---|---|
| `pr` | ① `git rev-list --count <base>..feat/<slug>` > 0（コミットが存在）② PR が存在する — `status.json.pr_url` があれば `gh pr view <url> --json state` が成功、無ければ `gh pr list --head "feat/<slug>" --json url` が 1 件以上返る |
| `merge` | ① `git rev-list --count <base>..feat/<slug>` > 0 ② worktree に未コミット変更が無い（`git -C <worktree> status --porcelain` が空） |

検証に落ちたタスクは **`done` から `error` へ降格**し、`unverified` として集計する。降格したタスクは §3.8.2 の表で `error` 行として扱われるため、branch も `.dispatch/<slug>` も温存され、`dispatch/failed` が付いて再取得もされない。

`pr_url` は `status.json` に依存しきらない（`gh pr list --head` で独立に引ける）が、既存 wrapper が child の書いた `pr_url` を exit 時に消してしまう問題は根本原因なので、**`write_status` が既存 `status.json` の `pr_url` を引き継ぐ**ように修正する。これは非ループにも有益で、既存の JSON スキーマも変えない後方互換の修正である。

#### 3.8.2 cleanup 遷移表（SoT）

| # | 検証後の結果 | integration | merge 試行 | worktree | branch `feat/<slug>` | `.dispatch/<slug>` |
|---|---|---|---|---|---|---|
| 1 | `done` | `pr` | しない | 削除 | 削除（リモートに push 済み） | 削除 |
| 2 | `done` | `merge` | する → 成功 | 削除 | 削除 | 削除 |
| 3 | `done` | `merge` | する → conflict | **温存** | **温存** | **温存** |
| 4 | `error` / `timeout` / `unverified` | 両方 | しない | **WIP 保全後に削除**（§3.8.3） | **温存** | **温存** |

- **`--keep-failed` フラグは設けない**。保持の要否は上表で一意に決まる
- 失敗タスクの `.dispatch/<slug>` は status.json / result.md / wip.patch のみの軽量ディレクトリ。Step L1.5-2 の stale 検査があるため、次回ループ開始時にユーザーが必ず気付く

#### 3.8.3 失敗タスクの WIP 保全

error は commit 前にも起こり得るため、「作業内容は branch に残る」という保証は無条件には成立しない。worktree を `--force` 削除する前に、次の順で保全する。

**手順 1 — WIP コミット（本命）**

```bash
git -C "$WT" add -A
git -C "$WT" -c user.name="cmux-dispatch" -c user.email="cmux-dispatch@localhost" \
  commit --no-verify -m "wip: <slug> (dispatch failed)"
```

`--no-verify` と一時的な identity 指定により、pre-commit hook や `user.email` 未設定といった環境要因での失敗を排除する。成功すれば内容は branch に残るため、以降の手順は不要。

**手順 2 — フォールバック（コミット対象が無い等で 1 が失敗した場合）**

`git diff HEAD` は**未追跡ファイルの内容を含まず**、`--binary` なしでは binary ファイルの復元情報も持たない。`status --porcelain` はファイル名を並べるだけである。したがって「commit が失敗し、新規作成ファイルだけが残っている」ケースでは、空の patch とファイル名一覧だけを保存して唯一の成果物を消すことになる（round 3 finding 5）。復元可能な形で保存する:

**すべてのパスを絶対パスで扱う。** `git -C "$TMP"` はコマンドを `$TMP` から実行するため、相対パスの成果物は検証用 worktree の内側として解決され、必ず `No such file or directory` になる（round 5 finding 3）。

```bash
D="$REPO_ROOT/.dispatch/<slug>"     # 必ず絶対パス
git -C "$WT" diff --binary HEAD > "$D/wip.patch"
git -C "$WT" ls-files --others --exclude-standard -z > "$D/wip-untracked.manifest"
tar czf "$D/wip-untracked.tar.gz" --null -T "$D/wip-untracked.manifest" -C "$WT"
git -C "$WT" status --porcelain > "$D/wip-status.txt"
```

- tracked な変更は `--binary` 付きの patch（`git apply` で復元可能）
- 未追跡ファイルは内容ごと tar archive に保存し、対象一覧を manifest としても残す

**検証は clean な一時 worktree で行う。** `git apply --check` を patch の生成元である `$WT` に対して実行すると、変更が既に適用済みであるため通常 `patch does not apply` になり、検証が常に失敗する。親 worktree で実行しても HEAD が対象ブランチと一致する保証がない（round 4 finding 4）。したがって検証の文脈を次のように固定する:

```bash
BASE=$(git -C "$WT" rev-parse HEAD)                  # patch の基準コミット
TMP=$(mktemp -d)                                     # mktemp -d は絶対パスを返す
trap 'git -C "$REPO_ROOT" worktree remove "$TMP" --force 2>/dev/null;
      git -C "$REPO_ROOT" worktree prune 2>/dev/null; rm -rf "$TMP"' RETURN

git -C "$REPO_ROOT" worktree add --detach "$TMP" "$BASE"   # clean な検証用 worktree
git -C "$TMP" apply --check --binary "$D/wip.patch"        # $D は絶対パスなので解決できる
tar tzf "$D/wip-untracked.tar.gz" > /dev/null              # archive の健全性
# manifest（NUL 区切り）と archive のエントリを identity で照合する
```

- `$D` / `$TMP` / `$REPO_ROOT` はすべて絶対パスで扱う
- 検証用 worktree は成功・失敗のどちらでも `trap` で必ず `worktree remove` + `prune` する
- `wip.patch` が空（tracked な変更が無い）場合は `apply --check` をスキップし、archive の検証だけを行う
- すべての検証を通過したときに限り元の worktree を削除する

**手順 3 — いずれも失敗した場合**

**worktree を削除せず温存**し、`leaked[]` に理由とともに記録する。

この 3 段階により、§3.8.2 の表が言う「作業内容は branch に残る」が実際に成立するか、成立しない場合は worktree そのものが残る。

#### 3.8.4 実行順序（各 slug ごと）

1. §3.8.1 の完了検証を行い、必要なら `done` → `error` に降格する
2. `.dispatch/<slug>/prewarm.json` の全 `surface_id` を `cmux close-surface`
3. `.dispatch/<slug>/status.json` の `workspace_id` を `cmux close-workspace`
4. integration = `merge` かつ検証済み `done` の場合、**worktree を削除する前に** 親で `git merge "feat/<slug>" --no-edit` を試みる
   - 成功 → 手順 5 へ
   - conflict → `git merge --abort` し、worktree・branch とも温存して `dispatch/failed` を付与、この slug の cleanup を終了（#3）
5. 結果が `error` / `timeout` / `unverified` なら §3.8.3 の WIP 保全を行う
6. **`issue-fetch.sh ... finalize` で `loop-state.json` に最終結果を記録する**。失敗したらこの slug の処理を中止し、worktree・branch・`.dispatch/<slug>` をすべて温存する
7. **§3.6 のラベル遷移を適用する**。terminal ラベル（`dispatch/done` / `dispatch/failed`）を**先に付けてから** `dispatch/in-progress` を外す。terminal ラベルの付与に失敗したらこの slug の処理を中止し、同様にすべて温存して `leaked[]` に記録する
8. 上表に従い `git worktree remove ".worktrees/<slug>" --force`
9. 上表に従い `git branch -D "feat/<slug>"`。手順 8/9 が失敗した場合は `leaked[]` に追記する
10. 上表に従い `rm -rf ".dispatch/<slug>"`
10. `agmsg` モードのときは `leave.sh <team> <slug>` / `-sonnet` / `-codex` / `-review` / `-opus` で team から除籍する

pane close を先に行うのは既存 cleanup と同じ理由（ペインを閉じないと worktree が掴まれたまま削除に失敗する）。merge を worktree 削除より前に置いたのは、conflict 時に worktree を温存する契約と順序を整合させるためである。

## 4. 要件 2 — AskUserQuestion 全廃

### 4.1 全 18 箇所の解決マッピング

| # | 箇所 | 現行 | loop モードでの解決 |
|---|---|---|---|
| 1 | Step 1a タスク収集 | 質問 | `issue-fetch.sh ... fetch` の出力に置換 |
| 2 | Step 1c brainstorming 選択 | 質問 | plan モード固定（質問なし） |
| 3 | Step 1d layout | 質問 | workspace 固定（設定質問にも含めない） |
| 4 | Step 1e integration strategy | 質問 | 設定質問コール② で 1 回 |
| 5 | Step 1f runner switch / per-task runner | 質問 | 設定質問コール②（design runner）で 1 回。全タスク同一 runner |
| 6 | Step 1f first-run setup（runners.json 対話生成） | 対話ループ | **Step L0-2 で検査**し、`runners.json` 不在ならループを開始せずエラー終了 |
| 7 | Step 1f cross-engine reviewer 選択 | 質問 | claude engine runner が 1 件なら自動採用、2 件以上なら設定質問コール③ で 1 回 |
| 8 | Step 1g message_type | 初回のみ質問 | config 未設定時のみ設定質問コール③ に含める（1 回・従来どおり永続化） |
| 9 | Step 1g review_mode | 毎 dispatch 質問 | 設定質問コール② で 1 回。ループ中は固定 |
| 10 | 完了時 Wait-and-merge の Option A/B | 質問 | integration = `merge` なら常に merge。conflict は §3.8.2 #3 で自動処理 |
| 11 | 完了時 cleanup 3 問 | 質問 | §3.8.2 の遷移表で決定的に処理 |
| 12 | Phase A-R 3 往復 needs_work | 子が質問 | **ブロック本文を差し替え**、「未解決指摘を文書末尾に注記して Phase B へ進む」を固定手順にする |
| 13 | Phase A-R stalled | 子が質問 | **ブロック本文を差し替え**、「同一ラウンドの再依頼 1 回 → なお stalled ならレビューを省略して Phase B へ」を固定手順にする |
| 14 | Phase B 実行モデル選択 | 子が質問 | 設定質問コール② の exec runner を `{{EXEC_DEFAULT_HINT}}` に焼き込む（既存の default-direct 経路をそのまま利用） |
| 15 | Phase B exec_choice 永続化確認 | 子が質問 | 14 により発生しない |
| 16 | Phase B-R 3 往復 needs_work | 子が質問 | **ブロック本文を差し替え**、「未解決指摘を PR 本文に注記して PR を作成」を固定手順にする |
| 17 | Phase B-R stalled | 子が質問 | **ブロック本文を差し替え**、「レビューを省略し、その旨を PR 本文に注記して PR を作成」を固定手順にする |
| 18 | brainstorming / ExitPlanMode の暗黙の承認ゲート | 承認待ちで停止 | plan モード固定 + `--dangerously-skip-permissions` により承認プロンプト自体が出ない（§4.4） |

### 4.2 プロンプト経路 — unattended variant のレンダリング

12 / 13 / 16 / 17 は `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` の内部にある。round 1 時点では「禁止文を持つブロックを直前に足して上書きする」方式を採っていたが、これは 2 つの理由で誤りである（round 2 finding 1）:

- 後続に残った強い命令（「AskUserQuestion で聞け」）を、先行する一般的な禁止文で打ち消す構造になり、「質問命令が存在しない」ことの保証にならない
- 追加ブロック自身が `AskUserQuestion` という文字列を含むため、「生成物に `AskUserQuestion` が現れない」という回帰テストと自己矛盾する

**修正**: ループ用には `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` の **unattended variant** をレンダリングする。両ブロック内の 4 つの質問分岐を、固定手順の記述で**置換**する。追加ブロックは設けない。

置換の対応（左が現行、右が unattended variant）:

| 現行の記述 | unattended variant |
|---|---|
| `N == 3 → … AskUserQuestion: 1. このまま進む / 2. さらに修正` | `N == 3 → append the unresolved findings as a note to the document and proceed to Phase B.` |
| `stalled → … AskUserQuestion: 1. 再依頼する / 2. レビューを省略` | `stalled → re-send the same round once; if it stalls again, skip the review, note that in the document, and proceed to Phase B.` |
| `Round 3 needs_work → AskUserQuestion: 1. このまま PR 作成 / 2. さらに修正` | `Round 3 needs_work → note the unresolved findings in the PR body and create the PR.` |
| `stalled → AskUserQuestion if you can (再依頼 / レビュー省略して PR 作成)` | `stalled → re-send once; if it stalls again, skip the review, note that in the PR body, and create the PR.` |

**差し替えは 4 分岐だけでは足りない。** `MANDATORY MODEL SELECTION SEQUENCE` にはレビューブロックの外にも `AskUserQuestion` というリテラルが残る（round 3 finding 6）。loop renderer は次の**すべて**を unattended 文面に差し替える:

| 対象（`SKILL.md` の該当箇所） | 現行 | unattended variant |
|---|---|---|
| PHASE A（plan モード説明）の `Step 1: Phase B execution-model selection (per the block below — AskUserQuestion or default direct)` | 質問の可能性に言及 | `Step 1: Phase B execution-model selection (per the fixed path defined below)` |
| PHASE B 見出し直下の `follow the Phase B flow resolved in this task prompt (AskUserQuestion or default direct)` | 同上 | `follow the fixed Phase B path defined below` |
| PHASE B の `Question template` 節と `{{CODEX_OPTION_LINE}}` | 質問テンプレート | `{{EXEC_DEFAULT_HINT}}` の default-direct ブロックで置換（既存仕様どおり。loop では `exec_choice` が必ず確定しているため質問節は出力しない） |
| `{{EXEC_DEFAULT_HINT}}` の default-direct ブロック本文 `ExitPlanMode 後は AskUserQuestion をスキップし…` | 語を含む | `ExitPlanMode 後は直ちに <default> の既存 Phase B ブランチを実行してください…`（語を除去） |
| VIOLATION 節の `Follow the exact flow defined in this PHASE B block (either AskUserQuestion or the default-direct path)` | 同上 | `Follow the exact flow defined in this PHASE B block` |
| codex 設計 variant の PHASE B 冒頭 `follow the Phase B flow resolved in this task prompt (AskUserQuestion or default direct)` | 同上 | `follow the fixed Phase B path defined below` |
| REVIEW_BLOCK / CODE_REVIEW_BLOCK の 4 分岐 | 下表のとおり | 下表のとおり |

いずれも**機能的には loop で到達しない記述**だが、リテラルが残ると §4.5 の検査が必ず失敗し、検査そのものが無意味になる。非ループ側の文言は一切変更しない。

ヘッダーは次の 1 行のみを付ける（`AskUserQuestion` というリテラルを含めない）:

```text
UNATTENDED: no interactive user is attached to this session. Every decision
point below states its fixed outcome — follow it and record what you did in
the document / PR body you produce. When you delegate implementation in
Phase B, propagate this: pre-warm path → include this line and the fixed
outcomes in REQUEST_TEXT; spawn fallback → pass --unattended to
launch-workspace.sh --mode execute.
```

**非ループ時は現行のブロックをそのまま使う。** 通常モードのプロンプトは 1 バイトも変わらない。

### 4.3 spawn 経路 — `launch-workspace.sh --unattended`

プロンプト経路だけでは足りない。Phase B で `prewarm.json` が無い場合（`prewarm: false` / split レイアウト / pre-warm 失敗）、実装者は `launch-workspace.sh --mode execute` で spawn され、その inner prompt は plan file と `REVIEW_INSTRUCTION` から**新規に構築される**。元のタスクプロンプトは読まれない。現行の `REVIEW_INSTRUCTION` は round 3 / stalled 時に「可能なら AskUserQuestion で聞け」と明記している。

**修正**: `launch-workspace.sh` に `--unattended` フラグを追加する。

| 対象 | `--unattended` 無し（既定・現行どおり） | `--unattended` 付き |
|---|---|---|
| `REVIEW_INSTRUCTION` の round 3 needs_work | 「AskUserQuestion で聞け、聞けなければ PR 本文に注記して進め」 | 「PR 本文に未解決指摘を注記して進め」 |
| `REVIEW_INSTRUCTION` の stalled | 「AskUserQuestion で聞け（再依頼 / 省略）」 | 「レビューを省略し、その旨を PR 本文に注記して進め」 |
| claude engine の execute | 呼び出し側の `--skip-permissions` に従う | `--dangerously-skip-permissions` を強制付与 |
| codex engine の execute | 現行どおり bypass | 変更なし（既に非対話） |

`--unattended` は `--mode execute` / `--mode standby` で有効とし、他モードでは警告して無視する。

### 4.4 暗黙の承認ゲートの解消

現行の既定経路（`message_type: agmsg` + `prewarm: true`）では、設計ペインは `--mode plan` ではなく **`--mode standby`** で起動され、`--skip-permissions` が付いていない。タスクは後から typed prompt で届く。

そのため「plan モード固定 + skip-permissions」は次の 2 点で実現する:

1. `prewarm-panes.sh` に `--unattended` フラグを追加し、指定時は設計ペイン（claude opus standby）の起動に `--skip-permissions` を渡す。sonnet standby には既に付いており、codex 系は bypass フラグで解決済み
2. 設計ペインへ送る `TASK_TEXT` の Mode を常に `plan` にする。プロンプトファイルには plan モード用テンプレート（unattended variant のレビューブロック込み）を書き込む

pre-warm を使わない経路では `launch-workspace.sh --mode plan` が使われ、これは既に `--dangerously-skip-permissions` を付与しているため追加変更は不要。

### 4.5 検証方法

「生成物に `AskUserQuestion` というリテラルが 1 件も現れない」ことを、**2 つの経路それぞれについて別々に**検査する（round 2 finding 1）:

| 経路 | 取得対象 | 検査 |
|---|---|---|
| (a) プロンプト経路 | `scripts/render-loop-prompt.sh` が出力する完全なタスクプロンプト | `AskUserQuestion` を含まない |
| (b) spawn 経路 | `launch-workspace.sh --mode execute --unattended` が生成する `.cmux-team-dispatch-task-run-*.sh` | `AskUserQuestion` を含まない |

**(a) を機械的に検査できるよう、ループ用プロンプトの組み立てはスクリプト化する。** 組み立てを LLM に任せると「確定文面を貼らなかった」「一部だけ貼った」「別の対話ブロックが残った」という回帰を検出できない。`references/unattended/` に確定文面を置き、`render-loop-prompt.sh` がそれらを連結して完全なプロンプトを stdout に出す。テストはその**最終出力**を design engine（claude / codex）× review（on / off）の 4 通りで検査する。空出力で検査を通す抜け道を塞ぐため、必要な見出し・slug・sentinel パス・出力長も同時に assert する。

(b) は `test/test-launch-workspace-codex.sh` の拡張で行う。あわせて `--unattended` を渡さない場合は現行文言が保たれることも検査する（後方互換スナップショット）。

## 5. 要件 3 — ループ開始前の一括設定質問

`AskUserQuestion` は 1 コールあたり最大 4 問という制約があるため、3 コールに分割する。Step L0-1 の発動確認は、これらより前に行う独立した 1 問である（`--loop` 指定時は出ない）。

### コール① 対象 issue

| # | 質問 | 選択肢 |
|---|---|---|
| 1 | 対象にする issue のラベル | `gh label list` から動的生成（`dispatch/*` を除いた上位 3 件）+ 「フィルタなし」+ Other（自由入力でカンマ区切り指定可） |
| 2 | assignee フィルタ | 自分 (`@me`) / 未アサインのみ（`no:assignee`）/ 指定なし |
| 3 | 1 バッチの並列実行数 | 2 / 3 / 5 |
| 4 | 最大バッチ数 | 3 / 5 / 10 / 無制限 |

`state` は `open` 固定（クローズ済み issue をディスパッチする意味がないため質問しない）。

### コール② 実行構成

| # | 質問 | 選択肢 |
|---|---|---|
| 1 | design runner（子セッションのランタイム） | `runners.json` の `runners[]` から動的生成（label = `name`, description = `command (engine)`） |
| 2 | exec runner（Phase B 実行モデル） | opus 1m / sonnet / codex（`engine: codex` runner がある場合のみ 3 択目を表示） |
| 3 | レビュー機能（Phase A-R / Phase B-R） | 有効 / 無効 |
| 4 | integration strategy | PR per task / Wait and merge |

### コール③ 補完・最終確認

該当する項目のみを出す。すべて不要なら最終確認 1 問だけになる。

| # | 質問 | 出す条件 |
|---|---|---|
| 1 | 通知トランスポート（`message_type`） | config 未設定 かつ agmsg インストール済み。回答は従来どおり global config に永続化 |
| 2 | reviewer runner（design=codex 時の claude 側レビュアー） | design runner が codex engine かつ claude engine runner が 2 件以上 かつ レビュー有効 |
| 3 | この設定でループを開始しますか | 常に（開始 / 設定をやり直す） |

「設定をやり直す」を選んだ場合はコール① から再実行する。**この最終確認を通過した時点でループ設定は確定し、以後ループが終わるまで一切質問しない。**

確定した設定は `loop-state.json.config` / `.filter` に記録し、ループ全体を通してそこから読む。

## 6. 要件 4 — codex 承認待ちの解消

### 6.1 監査結果

codex を起動しうる全経路を精査した。`prewarm-panes.sh` と `launch-session-splits.sh` は自前で codex を起動せず、すべて `launch-workspace.sh` に委譲しているため、独立した漏れは存在しない。

| # | 経路 | 現行フラグ | 判定 |
|---|---|---|---|
| 1 | `launch-workspace.sh` codex × plan | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 2 | `launch-workspace.sh` codex × superpowers | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 3 | `launch-workspace.sh` codex × execute | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 4 | `launch-workspace.sh` codex × standby（pre-warm 経由） | `--dangerously-bypass-approvals-and-sandbox` | 対応済み |
| 5 | `launch-workspace.sh` codex × review | `--sandbox workspace-write` + `-c approval_policy='never'` + `--add-dir <STATUS_DIR>` | 対応済み（§6.3） |
| — | **上記 5 経路すべてに共通** | **hook trust のバイパスが無い** | **未対応 — 要修正** |

### 6.2 未対応項目: codex hook trust

codex 0.145.0 は、プロジェクトローカルのフック定義に対して信頼確認を行う。信頼状態は `~/.codex/config.toml` に次の形式で永続化される:

```toml
[hooks.state."<hooks.json の絶対パス>:<event>:<i>:<j>"]
trusted_hash = "sha256:…"
```

キーが **hooks.json の絶対パスを含む**ことが問題になる。agmsg の `delivery.sh set monitor codex <worktree>` は worktree ごとに新しい `<worktree>/.codex/hooks.json` を生成するため、ディスパッチのたびにパスが変わり、常に未信頼と判定される。結果、codex セッションは起動直後に hook trust の承認待ちで停止する。

`--dangerously-bypass-approvals-and-sandbox` はコマンド実行の承認とサンドボックスを無効化するだけで、hook trust には作用しない。`codex --help` でも両者は別項目として定義されている:

```
--dangerously-bypass-approvals-and-sandbox
    Skip all confirmation prompts and execute commands without sandboxing.
--dangerously-bypass-hook-trust
    Run enabled hooks without requiring persisted hook trust for this invocation.
```

**修正**: `launch-workspace.sh` の codex 分岐 5 箇所すべてに `--dangerously-bypass-hook-trust` を追加する。review モードは 3 点セットから 4 点セットになる。

```
codex × plan        : <cmd> [-c effort] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '/plan …'
codex × superpowers : <cmd> [-c effort] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '$superpowers:brainstorming …'
codex × execute     : <cmd> [-c effort] [--model X] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox '…'
codex × standby     : <cmd> [-c effort] [--model X] --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox ['…']
codex × review      : <cmd> [-c effort] --model <review_model> --dangerously-bypass-hook-trust --sandbox workspace-write -c approval_policy='never' --add-dir <STATUS_DIR>
```

claude engine の分岐には付与しない（claude には存在しないフラグのため）。

### 6.3 review モードの実測検証

review ペインは唯一 sandbox を残す経路のため、`codex sandbox -c sandbox_mode=workspace-write --log-denials` を worktree 内で実行して確認した。

| 検証項目 | 結果 | 評価 |
|---|---|---|
| `git status` / `git diff main...HEAD` | 成功（denial なし） | worktree の git 実体がリポジトリ側にあってもレビューに支障なし |
| `<STATUS_DIR>` への書き込み（`--add-dir` なし） | `file-write-create` 拒否 | サンドボックスが効いていることの確認。実際は `--add-dir <STATUS_DIR>` があるため findings の書き込みは成功する |
| ネットワークアクセス | `workspace_write` 既定で無効 | レビューペインはネットワークを必要としない |
| `cmux` CLI | unix socket が `network-outbound` で拒否され失敗 | 現仕様でレビューペインは cmux を使わない（findings をファイルに書くだけ）ため実害なし |

**この検証が証明する範囲について**: `codex sandbox` はモデルの tool approval を経由せず raw command を sandbox 内で直接実行するサブコマンドである。したがってここで write denial が即座に返ることは、**サンドボックスの writable root と denial の挙動**を証明するが、`approval_policy='never'` が TUI で承認待ちを起こさないことの動的証明にはならない（round 2 の補足指摘）。`approval_policy='never'` の担保は、起動コマンドの静的検査（`-c approval_policy='never'` が必ず付くこと）と codex CLI の契約（`never` = "Never ask for user approval. Execution failures are immediately returned to the model"）に依る。

`--allow-unix-socket` の追加は、必要としない機能に権限を与えることになるため採用しない。

この検証手順は `test/test-codex-review-sandbox.sh` として自動化する（証明範囲は上記に限定して記述する）。

### 6.4 追加検討したが採用しない項目

| 項目 | 判断 |
|---|---|
| `-c sandbox_workspace_write.network_access=true` | レビューペインはネットワーク不要。付けない |
| `--add-dir ~/.agents/skills/agmsg` | レビューペインは agmsg `send.sh` を呼ばない。付けない |
| `--allow-unix-socket ~/.local/state/cmux` | §6.3 のとおり不要 |

### 6.5 非ループ挙動への影響 — 明示的な例外（1 / 2）

「通常モードの挙動は不変」という要件 2 の後段に対する例外は 2 つある。もう 1 つは §3.4 の「通常 dispatch 側の active loop lock ガード」であり、そちらは `.dispatch-loop/` が存在しない環境では素通りするため実質的な影響がない。本節はもう一方、**hook trust バイパス**を扱う。これは**意図的な例外**である。プロンプト内容は変わらないが、codex の**起動コマンドは全モードで変わる**。

**なぜループ限定にしないのか**: hook trust の承認待ちは worktree ごとに新しいパスが生成される構造上、非ループの単発 dispatch でも必ず発生する。ループ限定にすると単発 dispatch の codex 経路が停止したままになり、要件 4 の「全 mode / 全 script を監査し漏れを直す」という指示に反する。

**リスクと軽減**:

| 観点 | 評価 |
|---|---|
| 何を迂回するか | このプラグインが生成した worktree 内の `.codex/hooks.json` に対する信頼確認。グローバルの `~/.codex/hooks.json` も含まれるが、これはユーザー自身の設定である |
| フックの出所 | worktree 内のフックは agmsg の `delivery.sh` が生成したもので、コマンドは `~/.agents/skills/agmsg/scripts/*.sh` の固定パス。第三者が注入する経路は、そのリポジトリに push できる権限を既に持つ場合に限られる |
| 元々の防御力 | 承認プロンプトは毎回パスが変わるため常に「初見」として表示され、無人・半自動のディスパッチでは実質的にゲートとして機能していない（停止するだけ） |
| 影響範囲 | `launch-workspace.sh` が起動する codex セッションのみ。ユーザーが手で叩く `codex` には影響しない |

この判断は README / CLAUDE.md にも明記する。

## 7. テストと検証

| 種別 | 内容 |
|---|---|
| 構文 | 変更した全シェルスクリプトに `bash -n`、`launch-workspace.sh` は `zsh -n` も実行 |
| 既存回帰 | `bash test/test-launch-workspace-codex.sh`、`bash test/test-launch-workspace-review-config.sh` |
| 静的検査（拡張） | `test-launch-workspace-codex.sh` に追加: ① codex 全 5 モードで `--dangerously-bypass-hook-trust` が付くこと ② claude 全 5 モードで付かないこと ③ codex review に `-c approval_policy='never'` が必ず付くこと ④ `--unattended` 付き execute の生成 runner に `AskUserQuestion` が現れないこと ⑤ `--unattended` 無しでは現行文言が保たれること ⑥ `write_status` が既存 `pr_url` を引き継ぐこと |
| プロンプト検査（新規） | `test/test-loop-prompt.sh` — loop 用にレンダリングした task file / `TASK_TEXT` に `AskUserQuestion` が現れないこと、非ループでは現行ブロックが保たれること（review 有無 × design engine の各組合せ） |
| ユニット（新規） | `test/test-issue-fetch.sh` — `gh` をスタブ化し、⒜ 生成クエリ（`no:assignee` を使うこと、`--assignee none` を渡さないこと、3 ラベルの negative qualifier が入ること）⒝ 先頭窓が全除外でも次窓に候補があれば取得できること ⒞ **安全上限まで窓が満杯のままなら exit 4 を返し `[]` で正常終了しないこと** ⒟ claim 失敗時の除外 ⒠ claim 全滅時の exit 3 ⒡ release / reconcile の状態遷移 ⒢ ロックの排他（同時 2 回取得で片方が失敗すること）⒣ **stale takeover の排他（2 プロセスが同時に stale と判定しても owner は 1 つに定まること）** ⒤ **他 owner の `lock-release` が拒否されること** ⒥ **owner token 不一致の状態で state 変更サブコマンドを呼ぶと何も書かず exit 1 になること** ⒦ **最後に発行した `--limit` が 1000 を超えないこと、および exit 4 の前に必ず 1000 を一度問い合わせていること** |
| ユニット（新規） | `test/test-batch-wait.sh` — status.json をスタブ化し、⒜ 「1 件 timeout・1 件まだ実行中」の混在バッチで `ALL_TERMINAL` を返さず待機を続けること ⒝ timeout slug を自身で `error` 化し `loop-state.json` に `timeout` を記録すること ⒞ status.json の書き換えに失敗しても同一 slug で無限に留まらず `leaked[]` に記録して外すこと ⒟ `owner.json.heartbeat` が毎回更新されること ⒠ **`.dispatch-loop/timed-out/<slug>` sentinel が作られること、および sentinel がある状態で runner wrapper を実行しても status.json が書き換わらず `.dispatch/<slug>` が再生成されないこと** ⒡ **barrier を使って「close → タスクディレクトリ削除 → wrapper の終了処理」の順序を再現しても、sentinel はタスクディレクトリ外にあるため生き残りディレクトリが復活しないこと** |
| ユニット（新規） | `test/test-loop-cleanup.sh` — ⒜ 完了検証に落ちた `done` が `error` に降格し worktree / branch が残ること ⒝ **commit が失敗し未追跡ファイルだけが残るケースで、内容が `wip-untracked.tar.gz` に保全されてから worktree が削除されること** ⒞ **binary ファイルの変更が `--binary` patch で復元可能なこと** — 検証は **patch 生成元の dirty な worktree ではなく、基準コミットから作った clean な一時 worktree** で `git apply --check` を通すこと。**`loop-cleanup.sh` の実際の cwd から相対パスでは失敗し、絶対パスなら通ることも確認する** ⒟ 保全が全滅した場合に worktree が温存され `leaked[]` に載ること ⒠ merge conflict 時に worktree・branch とも温存されること ⒡ **`loop-state.json` の `timeout` が authoritative で、後着の `status.json = done` で成功へ戻らないこと** |
| 動的検査（新規） | `test/test-codex-review-sandbox.sh` — 一時 worktree で `codex sandbox` により ⓐ `--add-dir` 付きで `STATUS_DIR/review/` に書けること ⓑ `--add-dir` 無しでは拒否されること ⓒ `git diff` が成功することを検査。**`approval_policy` の挙動は本テストの証明範囲外**であることをコメントに明記。`codex` 不在の環境では skip |
| ワークスペース全体 | ルートで `pnpm check` |
| E2E（手動チェックリスト） | `CLAUDE.md` に追加: ① 実 hook を持つ worktree で codex ペインが trust prompt を出さずに起動すること ② hung child（`executing` のまま通知を送らない子）が `task_timeout_min` で timeout 扱いになり、**同一バッチの他タスクが完了するまで待機が続いたうえで** cleanup 後に次バッチへ進むこと ③ ループが 2 バッチ以上回り、バッチ間で worktree / workspace が確実に片付くこと ④ ループ中に一度も AskUserQuestion が出ないこと ⑤ `--loop` を付けない通常 dispatch が従来どおり動き、`.dispatch-loop/` が作られないこと ⑥ **ループ実行中に通常 dispatch を開始しようとすると拒否されること（逆順の競合）** ⑦ **通常 dispatch 実行中にループを開始しようとすると L1.5-2 で拒否されること（正順の競合）** |

hook trust の「実 TUI で prompt が出ないこと」の検査は対話セッションを要するため自動化せず、E2E 手動チェックリストに置く。同様に、ループ発動の分岐は LLM の判断であり静的テストの対象にできないため、`--loop` を唯一の機械的 entry point とする仕様（§3.1 冒頭）と E2E 項目⑤で担保する。

## 8. ドキュメント整合

`CLAUDE.md` の「ドキュメント整合の絶対ルール」に従い、以下 4 ファイルを同時に更新する:

1. `skills/cmux-team-dispatch-task/SKILL.md`
2. `skills/cmux-team-dispatch-task/references/guide-ja.md`
3. `README.md`
4. `CLAUDE.md`

同期対象:

- engine × MODE 起動表（`--dangerously-bypass-hook-trust` の追加）
- `launch-workspace.sh --unattended` / `prewarm-panes.sh --unattended` の仕様
- `write_status` の `pr_url` 引き継ぎ
- loop モードの存在と参照先（`references/loop-mode.md`）、`.dispatch-loop/` の役割
- 通常 dispatch 側の active loop lock ガード（Step 1 冒頭 / cleanup 節）と、それが非ループ挙動への 2 つ目の明示的例外であること
- `loop.task_timeout_min` / `loop.lock_lease_min` config キー
- hook trust バイパスが非ループにも及ぶこと（§6.5）
- `CLAUDE.md` メンテナンス手順への新項目追加と、項目 20 / 39 の更新

バージョンは機能追加のため minor バンプ: `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` を 1.9.0 → 1.10.0 とし、ルート `.claude-plugin/marketplace.json` の対応 version も同期する。

## 9. リスクと軽減策

| リスク | 軽減策 |
|---|---|
| 親セッションのコンテキストがバッチを重ねるほど肥大する | バッチごとの報告は Template B のみに絞り、詳細は `loop-state.json` に書いて画面に出さない。最大バッチ数の上限も安全弁として機能する |
| hung child を誰も打ち切らない | 待機を親のターン内の同期処理（`batch-wait.sh` の反復呼び出し）にし、deadline を `claimed_at` からの絶対時刻で判定する（§3.7） |
| 1 件の timeout で実行中タスクごと cleanup へ送る | timeout の terminal 化を `batch-wait.sh` の内部処理にし、全 slug が terminal になるまで `ALL_TERMINAL` を返さない（§3.7） |
| timeout 済みの子が後から status.json を上書き／ディレクトリを再生成する | `.timed-out` sentinel で runner wrapper の書き込みを封じ、cleanup は `loop-state.json` の `timeout` を authoritative とする（§3.7.1） |
| 対象 issue が残っているのに「対象なし」で終了する | dispatch ラベルの除外をサーバサイド search qualifier で行い、返却件数が窓未満になるまで拡張する。安全上限に達しても判定できなければ exit 4 で人に返す（§3.6） |
| 未完成タスクを `done` と誤認して worktree / branch を消す | cleanup 前に成果物を独立に検証し、落ちたものは `error` へ降格する（§3.8.1） |
| 失敗タスクの未コミット成果物を失う | worktree 削除前に WIP コミット（`--no-verify` + 一時 identity）→ `--binary` patch と未追跡ファイルの tar 保全 → 健全性確認 → いずれも失敗なら worktree 温存（§3.8.3） |
| ラベル付与に失敗した issue を無限に拾い続ける | claim 失敗時はそのバッチから除外し状態にも登録しない。候補があったのに claim 全滅なら exit 3 でループを中断する |
| 親が claim 後に落ちて issue が回収不能になる | `claimed` / `dispatched` を区別し、Step L1.5-1 の reconcile で workspace の生存を確認して release または中止する |
| ロックが取れたまま／取り合いになる | `mkdir` による atomic 取得、stale takeover は takeover mutex の勝者のみ、liveness の正本は `owner.json` に一本化、release は owner 一致時のみ、中断する全経路での明示的解放（§3.4） |
| 質問回答待ちや長時間処理の間に heartbeat が切れ、二重 owner になる | ロック取得を Step L1 の最終確認後に遅らせ、全サブコマンドが冒頭で heartbeat 更新と owner token 検証を行い、lease を `task_timeout_min` から独立させる（§3.4） |
| 通常 dispatch の `rm -rf .dispatch/` がループ状態やタスク状態を消す | ループ制御状態を `.dispatch-loop/` に分離（正順）＋ 通常 dispatch 側の Step 1 冒頭と cleanup 節に active loop lock ガードを追加（逆順）。§3.4 |
| `--dangerously-skip-permissions` による意図しない破壊的操作 | worktree 隔離は従来どおり維持される。ループは `--loop` または Step L0-1 の明示 opt-in を通らないと開始しない |
| hook trust バイパスによるセキュリティ挙動の変化 | §6.5 に例外として明記し、README / CLAUDE.md にも記載する |
| Wait and merge のコンフリクトでループが空回りする | conflict 時は worktree・branch を温存して `dispatch/failed` にし、次バッチへ進む。ラベルにより再取得されない |
| worktree / branch の削除に失敗して漏れる | `leaked[]` に記録し、Step L3 のサマリで手動整理対象として提示する |

## 10. 実装時に対応する hardening 項目

spec レビュー round 5 で **non-blocking** として挙がった項目。実装開始を妨げないが、実装時に手当てする。

| 項目 | 内容 |
|---|---|
| heartbeat の粒度 | 現契約は各サブコマンドの「冒頭」でしか更新しない。単一の `loop-cleanup.sh` 実行やペイン一斉起動が lease（既定 30 分）を超える規模になると鮮度が保てない。長時間処理の内部でも定期的に heartbeat を打つか、外部副作用の前後で owner token を再検証する |
| tar 検証の厳密さ | manifest と archive の件数比較だけでなく、NUL-safe な entry identity（パス文字列そのもの）を照合する |
| guard の TOCTOU | 通常 dispatch 側の active loop lock ガードは check-only であり、狭い TOCTOU window が残る。§12 で同時実行を非サポートと明記し cleanup 側にも再検査があるため許容するが、実装時に窓を最小化する |

### レビュー経緯

Phase A-R（spec）は codex `gpt-5.6-sol` と 5 往復した。round 1〜4 の指摘はすべて反映済み。round 5 の blocking 3 件（ロック取得順序、timeout sentinel の寿命、WIP 検証の相対パス）も本文に反映したが、**ユーザーの判断によりレビューは round 5 で打ち止めとしたため、round 5 の修正内容自体は再レビューを受けていない**。上表の non-blocking 項目も同様。

## 11. 既知の未修正事項（本設計のスコープ外）

`skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh` の 247 行目で、262 行目まで定義されない `GRID_APPLIED` を `--argjson grid_layout "$GRID_APPLIED"` として参照している。`set -u` 配下のため split レイアウト経路が unbound variable で失敗するはずである。ループモードは workspace レイアウト固定であり本件の影響を受けないため、今回は修正せず報告のみとする。

## 12. 制約

- **同一リポジトリに対するループの並行実行は非サポート**。`gh issue list` と `gh issue edit --add-label` は compare-and-set ではないため、2 つのループが同時に list すると同じ issue を両方が claim し得る。GitHub API だけでは原子的な所有権を実現できないため、リポジトリ単位で単一オーケストレータを前提とし、`.dispatch-loop/loop.lock.d` による**同一マシン上の**検出のみを行う。別マシンからの同時実行は検出できないため、運用上の約束とする
- **ループと通常 dispatch の同時実行も非サポート**。両方向を塞ぐ: 「通常が先」は Step L1.5-2 の stale 検査でループ開始を拒否し、「ループが先」は通常 dispatch 側の Step 1 冒頭と cleanup 節に入れた active loop lock ガードで拒否する（§3.4）
- **中断したループの自動再開は行わない**。`reconcile` は走行中の子や `dispatched` 状態を検出したら中止して人に返す
- ループは `workspace` レイアウト + `prewarm: true` を推奨構成とする。`prewarm: false` でも動作するが、Phase B は spawn fallback となるため `--unattended` の伝播が必須である（§4.3）
- ループ中の子セッションは plan モード固定であり、brainstorming による設計探索は行わない
