# 向き先ブランチを Issue ごとに決める流れと autoMerge（orca-team-dispatch-task / slack-issue-intake）

2026-11-20。ユーザーとの対話で決めた設計。

## 1. 目的と理由

「どのブランチから切って、どこへ入れるか」を Issue ごとに正しく決める。普段は develop に入れ、本番の緊急修正は
main から切って main に入れ、そのあと develop へ取り込む。リポジトリには develop と main の両方があるもの、main しか
ないものなどが混在する。

向き先を merge のときに決めることはできない。auto モードは起動時に作業用 checkout を既定ブランチへ切り替え、そこから
作業ブランチを切る（`apps/orca-team-dispatch-task/lib/auto-tick.ts` の 413〜430 行）。PR の向き先も merge 先もその
ブランチになる。develop から切ったブランチを main へ入れると、develop の開発途中のものが本番へ混ざる。だから向き先は
**作業を始める前に、通常の流れの中で**決める。

そのうえで、簡単な Issue は AI が develop まで自動で merge できるようにする（autoMerge）。

## 2. 目標・非目標・反目標

目標:
- リポジトリごとに「普段の向き先」と「選べる候補」を持つ。候補が 1 つのリポジトリは今までと同じに動き、何も尋ねない。
- 起票（Slack のフォーム）で向き先を選べる。選ばなければ auto の判定で AI が決め、迷ったら人に尋ねる。
- 普段の向き先以外へ merge されたら、普段の向き先へ取り込む PR を自動で作る。
- 拾う元ごとの `autoMerge` で、auto-ready の Issue も条件がそろえば AI が merge する。

非目標:
- 手動の dispatch で親の checkout を切り替えること。
- 戻しの PR を AI が merge すること（作って知らせるだけ）。
- 新しいステータスラベルを足すこと。
- Slack のボタンで向き先に答えること（ラベルで答える）。

反目標（技術的に動いても失敗とみなすもの）:
- AI が main（普段の向き先以外）へ自動で merge する。main への merge は本番に直結する。
- ユーザーの作業中の checkout を勝手に動かす。
- 迷った向き先を黙って既定に倒す。

## 3. 進め方の候補（Approaches）

| 案 | 内容 | 判断 |
|---|---|---|
| A. 始める前に Issue ごとに決める | 設定の既定と候補、`base:*` ラベル、判定で AI が決め、迷えば尋ねる。merge は決まった向き先へ | **採用**。ブランチを切る前に決まるので、merge 先と切り元が必ず一致する |
| B. merge のときに決める | autoMerge の設定で向き先を選ぶ | 不採用。切り元が既に決まっていて、main へ入れると develop の途中のものが混ざる |
| C. リポジトリごとに固定 | 設定で develop 固定などにする | 不採用。緊急修正を main へ出すケースに対応できない |

作る順番はユーザーが決めた: ① 向き先の仕組み（設定・ラベル・判定・質問・手動 dispatch の確認・戻しの PR）→
② フォームの欄 → ③ autoMerge。段ごとにテストして push する。

## 4. 共有する約束（2 つのプラグインの境界）

- 2 つのプラグインが共有するのは **ラベルの形 `base:<ブランチ名>`** と、**通知の event 名**（後述の `needs-base`）だけ。
  お互いの設定ファイルは読まない。
- `base:*` はステータスラベルではない。`STATUS_LABELS` には入れず、ステータスの優先順位にも関わらない。
- 共有の約束は今の仕組みに載せる: event 名は slack-issue-intake の `STATUS_EVENTS` と orca-team-dispatch-task の
  `lib/auto-comment.ts`、コメントの例は `test/fixtures/orca-auto-comments.json`、照合は `scripts/check-shared-contracts.mjs`。
- `base:*` のラベルが 2 つ以上付いていたら、どちらも信じない（向き先が不明として扱う＝尋ねる）。
- **ラベルは Issue に 1 つで、対象のリポジトリすべてに効く（判断: Claude）。**意味は「この流れで出す」。対象の
  リポジトリごとに、そのブランチが候補にあればそれを、無ければそのリポジトリの `baseBranch` を使う。例: API（develop /
  main）とクライアント（main だけ）の 2 リポジトリの Issue に `base:main` なら両方 main、`base:develop` なら API は
  develop・クライアントは main。
- `base:<ブランチ>` のブランチが、対象のどのリポジトリの候補にも無いときは不明として扱う（尋ねる）。
- `needs-base` と戻しの PR の知らせ（7.4）は、`stalled` と同じく**ステータスが変わらなくても** Slack へ書く event にする。
  slack-issue-intake の `renderStatusMessage`（`lib/issue-status.ts`）は今 `stalled` だけをその例外にしているので、
  例外の event を集合にして `needs-base` を足す。

## 5. 設定

### orca-team-dispatch-task（auto の設定 `repos[repo]`）

- `baseBranch`（文字列）: 普段の向き先。省略時は GitHub の既定ブランチ（今の動き）。
- `branches`（文字列の配列）: 選べる候補。`baseBranch` を必ず含む。省略時は `[baseBranch]`（候補 1 つ＝今の動き）。
- `make setup` の**リポジトリの段**（`repos[repo]` を決める所。related だけのリポジトリも含む）で、origin にある
  ブランチを見て候補を提案し、ユーザーが確認する。提案は既定
  ブランチと、`develop` / `main` / `master` のうち origin にあるもの（ビルダーの判断で増減してよい）。
- 拾う元ごとに `autoMerge`（真偽、既定 false）。`autoReady` が true の拾う元にだけ意味がある（`autoReady` と同じく、
  意味の無い組み合わせは設定の検査で拒む）。setup で尋ねる。

### slack-issue-intake（intake の設定 `repos` ごと）

- 候補 `branches`（文字列の配列）を持つ。`make setup` のリポジトリの段で、origin のブランチから同じように提案して確認する。
- 候補が 2 つ以上のリポジトリがあるときだけ、フォームに「向き先」の欄を出す（下記 6）。
- 設定を持つのは intake だけで、orca-team-dispatch-task の設定は読まない。両方の setup で同じ候補を入れることになるが、
  それは受け入れる（プラグインを独立に保つため）。

## 6. 起票（slack-issue-intake のフォーム）

- 欄「向き先」（任意・選択）: `おまかせ` と、候補のブランチ名。既定は `おまかせ`。
- 候補が 2 つ以上のリポジトリがフォームの対象にあるときだけ出す。リポジトリ欄で選んだリポジトリに無い候補が選ばれたら、
  起票の検査で `おまかせ` とみなす（またはフォームの形に応じて弾く。ビルダーの判断）。
- `おまかせ` 以外を選んだら、起票時に `base:<ブランチ>` ラベルを付ける。ラベルが無ければ作る。
- `base:*` ラベルは `labels_hash`（ステータスラベルの指紋）に含めない。指紋が変わって Backlog が付かなくなるのを防ぐ。
- 「質問する」フォームには出さない（Issue を作らないため）。質問から起票するときは `おまかせ`。

## 7. auto の流れ（orca-team-dispatch-task）

### 7.1 向き先の決め方

1. `base:*` ラベルが 1 つで、候補にあるならそれを使う。
2. ラベルが無く、候補が 1 つならそれを使う（今の動き）。
3. ラベルが無く、候補が 2 つ以上なら、判定（`references/auto-judge.md`）で AI が決める。判定の出力に `base`（候補の
   どれか、または `ask`）を足す。手がかり: 本番で起きている障害・緊急・hotfix なら本番側（main）、それ以外は普段の向き先。
   根拠がはっきりしないときは `ask`。
4. 2 つの対象リポジトリを持つ Issue: ラベルがあれば 4 章の規則でリポジトリごとに当てはめる。ラベルが無ければ判定が
   流れ（どのブランチ名か、または `ask`）を 1 つ決め、同じ規則で当てはめる。
5. 判定が `eng`（Ready_Eng へ回す。新機能・3 リポジトリ以上を含む）になった Issue には向き先を尋ねない（判断: Claude）。
   エンジニアが自分で決める。

決まった向き先は Issue の状態（世代）に記録し、起動ではその `origin/<向き先>` へ作業用 checkout を切り替える
（今の既定ブランチの代わり）。PR の向き先と merge 先はそれに従う。世代が変わったら決め直す。

### 7.2 迷ったときの質問

- `ask` になった Issue は、コメント（「`base:main` か `base:develop` のどちらかを付けてください」と候補を列挙）を書く。
  通知の event は新しく `needs-base`（メンションあり）。ステータスは:
  - 拾う元の pick（既定 `Ready`。設定で別の名前のこともある）から拾った Issue: **Backlog** に戻す。
  - auto-ready で Backlog のまま判定した Issue: Backlog のまま（ステータスは変わらない）。
  どちらも、4 章の例外により slack-issue-intake がそのスレッドへメンション付きで知らせる（`STATUS_EVENTS` に
  `needs-base` を足す）。
- 人が `base:*` ラベルを付けたら:
  - auto-ready の拾う元: Backlog の Issue として再び判定に回り、ラベルの向き先で Ready へ進む。auto-ready は「有効にした
    時刻より後に作られた Issue」だけを拾うが、`needs-base` で戻した Issue はその条件に関わらず拾い直す。
  - auto-ready でない拾う元: 人が pick のステータスに戻すと、ラベルの向き先で拾われる（コメントでそう案内する）。
- 拾い直した Issue の `autoReady` は、尋ねる前の値を保つ（判断: Claude）。人が Ready にした Issue は、向き先を
  尋ねたせいで auto-ready の扱い（厳しい判定・必ず In review）にならない。
- ラベルが付くまで、その Issue は判定に回さない（毎 tick 尋ね直さない）。`needs-base` のコメントのマーカーと、そのあと
  ラベルが付いたかで見分ける。
- 人がラベルを付けずに pick のステータスへ戻したら、普段の向き先（`baseBranch`）で進める（判断: Claude）。尋ねたあとに
  人が明示的に戻したので「黙って既定に倒す」には当たらない。コメントでも「ラベルを付けずに戻すと <baseBranch> で
  進めます」と先に言っておく。同じ世代では二度尋ねない。

### 7.3 merge（autoMerge と向き先の制限）

今の merge の条件（`lib/auto-tick.ts` の 900〜945 行: レビュー承認・確認コマンドと CI の成功・人の確認が要る点なし・
確認済みのリポジトリ・インフラでない・PR が閉じていない）はそのまま。次の 2 つを変える:

- `issue.autoReady` の Issue を必ず人へ回す理由（935 行）は、その拾う元の `autoMerge` が true なら付けない。
- 向き先が **そのリポジトリの `baseBranch` でない**ときは、必ず In review にする（理由: 「普段の向き先でない
  （main）への merge は人が確認します。」）。候補が 1 つのリポジトリは向き先が常に `baseBranch` なので、今と同じく
  AI が merge しうる。

### 7.4 戻しの PR

- 向き先が `baseBranch` でない PR が merge されたのを tick が見つけたら（AI の merge は 7.3 により起きないので、実際は
  `human-merged` の経路。将来に備えて `ai-merged` の経路でも同じにする）、**Done へ移すコメントを書く前に、同じ段で**
  `<向き先> → <baseBranch>` の PR を作る（判断: Claude。Done が gh の呼び出し 1 回ぶん遅れるだけで、Done の通知に
  リンクを載せられる）。
- PR の題と本文には元の Issue と PR へのリンクを入れる。merge はしない。
- 作った PR のリンクは Done のコメントに入れる。`human-merged` のテンプレートは今 `{comment}` を持たないので、
  slack-issue-intake の `STATUS_EVENTS` で `{comment}` を足す（共有の約束の変更）。
- PR の作成が失敗しても Done へは進め、失敗の理由を Done のコメントに書く（Done を止めない）。2 つの対象リポジトリなら
  リポジトリごとに作る。
- 作れなかった（衝突で作れない・差分が無いなど）ときは、その理由をコメントに残す。差分が無いなら作らないのが正しい。
- 同じ PR を二度作らない（既に開いている同じ向きの PR があれば使う）。

## 8. 手動の dispatch（orca-team-dispatch-task）

- 取り込み先は今までどおり **親の checkout が今いるブランチ**。親は checkout を切り替えない。
- Step 1b（各タスクの始め方を尋ねる所）で、取り込み先のブランチ名を示す。違うブランチにしたいときは、ユーザーが自分で
  切り替えてからやり直すよう案内する。
- `--issue`（issue モード）: `base:*` ラベルが付いていて、それが親の今のブランチと違う Issue は claim せずに飛ばし、
  理由（向き先と今のブランチ）を言う。ラベルが無い Issue は今までどおり今のブランチで扱う。ラベルが 2 つ以上なら飛ばす。
- 手動の dispatch には戻しの PR も autoMerge も無い。

## 9. 既に動いている状態への影響

- 設定に `baseBranch` / `branches` / `autoMerge` が無い既存の環境は、今と同じに動く（候補 1 つ・autoMerge false）。
- 状態ファイルに向き先の記録が無い Issue（版を上げる前から動いているもの）は、既定ブランチで動いているものとして扱う。
- slack-issue-intake は候補が設定されるまでフォームを変えない。マニフェストが変わるので、欄を出すには setup で deploy し直す。

## 10. ビルダーに任せること

- 判定の出力の形（`base` をリポジトリごとにどう持つか）と、状態ファイルのフィールド名。
- setup で候補を提案するときのブランチの見つけ方（`gh api` か `git ls-remote` か）。
- 戻しの PR の題と本文の文面、コメントのマーカーの形（既存の `<!-- orca-auto:... -->` に合わせる）。
- フォームの「向き先」欄の作り（リポジトリ欄との組み合わせ）。
- テストの ID とファイル。既存の回帰（AU / IF / IS / RP、slack-issue-intake の各テスト）の番号の続きを使う。
- 文書の更新: SKILL.md と guide-ja.md（同じ commit）、README、各 CLAUDE.md、slack-issue-intake の README の
  「auto-ready で Ready になった Issue の PR は必ず In review で止まり」の一文、判定の指示
  `references/auto-judge.md` と `auto-judge-ja.md`（1 段目で `base` の出力、3 段目で autoReady の PR が必ず人の確認に
  回るという記述）。

## 11. 段ごとの区切りと版

1. 向き先の仕組み（5 の orca 側の設定、7.1・7.2・7.3 の向き先の制限、7.4、8、slack-issue-intake の `needs-base` 通知）
   → 両プラグインのマイナー版を上げて push。
2. フォームの欄（5 の intake 側の設定、6）→ slack-issue-intake のマイナー版を上げて push。
3. autoMerge（5 の `autoMerge`、7.3 の autoReady の扱い）→ orca-team-dispatch-task のマイナー版を上げて push。

版を上げるときは plugin.json・.codex-plugin/plugin.json・marketplace.json をそろえる。
