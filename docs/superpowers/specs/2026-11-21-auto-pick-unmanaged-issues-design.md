# 途中で導入しても漏れなく拾う（手で作った Issue・既存の Ready・既存の Backlog）

## 目的と理由

Project を使っているチームは、Issue を Project の Status で動かして仕事を回す。今の `--auto` が拾うのは Slack の印（`from-slack` / `slack-thread`）の付いた Issue だけで、Project の同期もその Issue だけを扱う。auto-ready も、有効にした後に作られた Backlog の Issue だけを見る。そのため、途中から導入すると次の Issue が漏れる。

- GitHub で手で作った Issue（Project で Ready にしても拾わない）
- 導入前から Project の上で Ready だった Issue
- 導入前からある Backlog の Issue（auto-ready の対象外）

途中で導入しても対象が漏れないようにする。手で作った Issue の知らせも、Slack の Issue と同じく Slack のスレッドへ出す。Backlog は「AI に触らせない置き場所」として残し、人が `slack-thread` を付けた Issue だけを auto-ready の判定に回す。

## ゴール・非ゴール・失敗とみなすこと

- ゴール: 拾う元のリポジトリで Ready（ラベルでも Project の Status でも）になった open の Issue は、作った経路や時期を問わず Slack で管理され、`--auto` が拾う。導入前から Project で Ready の Issue も、戻さずにそのまま拾う。
- ゴール: 人が `slack-thread` を付けた Issue は、Backlog かステータスラベルが無ければ、古くても手で作ったものでも auto-ready の判定に回る。
- 非ゴール: Slack の印の無い Issue を `--auto` が直接拾うこと。管理の印は今の約束（`from-slack` / `slack-thread`）のまま。
- 失敗とみなすこと: 人が印を付けていない Backlog の Issue（手で作ったもの・外の人が作ったもの）を AI が判定すること。Project の上の Status を、ラベルの付与で書き戻してしまうこと。一覧が件数の上限で切れて、黙って Issue を取りこぼすこと。intake の今の設定（`skip` / `thread`）のリポジトリの動きが勝手に変わること。

## 選んだ形（Approaches）

- 採用: slack-issue-intake の既存の Issue の取り込み（`existing`）に、新しい値を足す。Backlog 以外のステータスが付いた Issue は自動で取り込み、Backlog かステータスの無い Issue は、人が `slack-thread` を付けたときに取り込む。取り込んだ Issue は管理の印を持つので、orca 側は今の拾う処理のまま対象に含まれ、知らせも Slack のスレッドに出る。orca の Project の同期は、Slack の印の無い Issue も扱うように広げる（Project の Status をラベルへ写し、それを intake が見て取り込む）。
- 不採用: open の Issue を全部取り込む。全部に `slack-thread` が付くので、「auto-ready に回してよい」の目印に使えなくなる。Backlog も置き場所でなくなり、外の人の Issue まで判定に回る。
- 不採用: orca が Slack の印の無い Issue を直接拾う。Slack のスレッドが無いので、知らせを Slack に出せない。
- 不採用: 別の専用ラベルを目印にする。人が `slack-thread` で足りると決めた。

## 決まったこと

### slack-issue-intake

1. `existing` に値を足す（名前は builder に任せる）。この値のリポジトリでは、次の open の Issue を取り込む（管理の投稿を作り、`slack-thread` を付ける）。作られた時期は問わない。
   - Backlog 以外のステータスラベル（Ready・Ready_Eng・In progress・In review・Pending・Done・Failed）が付いた Issue。
   - 人が `slack-thread` を付けたのに、まだ管理の投稿が無い Issue。今の取り込みは `slack-thread` があれば取り込み済みとみなして飛ばすので、この値のリポジトリでは「DB に取り込みの行が無い」ことで人が付けたと判断し、投稿を作る（取り込みは DB の行 → 投稿 → ラベルの順なので、自分で付けたラベルには必ず行がある）。
   - Backlog だけ、またはステータスの無い Issue は、`slack-thread` が無ければ取り込まない。
2. 取り込みのときにステータスラベルを足さない。Project の上の Status を、新しいラベルで書き戻さないため。
3. 送る速さは今の取り込みと同じ（1 回の poll で 5 件まで）。
4. `init` と setup の質問で選べるようにする。今の `thread` / `skip` の意味は変えない。

### orca-team-dispatch-task

5. Project の同期: 拾う元の Project にある、そのリポジトリの Issue は、Slack の印が無くても同期する。Project で Ready にした手作りの Issue は、同期で Ready ラベルが付き、intake がそれを見て取り込み、その次の tick で `--auto` が拾う（数分遅れる）。
6. Project の同期: Status が `Todo` や空（ステータス名でない）の Issue でも、前回の組からラベルが変わったら、そのラベルを Status へ写す。今の同期は、ステータス名でない Status の Issue を何もせずに飛ばす（`decideProjectSync` の先頭）。そのままだと、auto-ready で判定に回った `Todo` の Issue は、作業が進んでも Project の上では Todo のまま残る。ラベルが変わっていないときは今と同じく触らない（組み込みの workflow の Todo を書き戻さない）。
7. auto-ready の対象に、`slack-thread` の付いた Issue のうち、ステータスが Backlog だけか、ステータスラベルが無いものを足す。作られた時期は問わない。`auto` は Ready を、`eng` は Ready_Eng を付ける（ステータスの無い Issue では外すラベルは無い）。今の対象（有効にした後に作られた Backlog の Slack の Issue）はそのまま残す。導入前からある `from-slack` の Backlog の Issue も、人が `slack-thread` を足せば対象になる。
8. 7 のステータスラベルの無い Issue は、Project の同期がその Issue の Status をラベルへ写せる間は待つ。同じ tick で同期が触った Issue と、Project の上の Status がステータス名の Issue は見送る。拾う元に `project` があり、その tick で Project を読めなかった（権限・期限・予算・件数の上限）ときは、そのリポジトリのラベルの無い Issue を判定に回さない。Project の上で人が In progress にしている Issue を Ready にし、それが Status へ書き戻されるのを防ぐため。
9. Ready・Backlog・ステータスの無い Issue の一覧は、件数で切らない。ページを読み切るか、読み切れないときは tick の出力に 1 行出す。今の `listReadyManaged` は 100 件で切れる。今までは新しい Issue だけを見ていたので足りていたが、既存の Issue も見るようになると足りない。
10. 人が Backlog へ戻した Issue を拾い直さない規則は、状態ファイルの記録に頼る。記録が消えるのは Issue を閉じたときだけ（`lib/auto-queue.ts`・`lib/auto-tick.ts`・`bin/orca-auto.ts` で確かめた）。Ready を拾う処理と管理の印の約束は変えない。

## 気をつけること

- 導入した直後は、取り込みと判定に回る Issue が一度に増える。取り込みは 1 回の poll で 5 件まで（既定の 5 分ごとなら 1 時間に 60 件ほど）。取り込まれるまでは、Ready の Issue でも拾われない。Slack には取り込んだ Issue 1 件ごとにトップレベルの投稿が 1 つ出る。
- 5 で、Slack の印の無い Issue にもステータスラベルが付く。Project で In progress などにしている手作りの Issue も、ラベルが付き、intake が取り込む（拾われはしない）。
- `slack-thread` を付けた Issue は、auto-ready で `auto` と判定されれば人が見ないまま AI が作業し、`autoMerge` も有効なら develop まで merge されうる。

## builder に任せること

- `existing` に足す値の名前、`init` のフラグの書き方、setup の質問の文面。
- ステータスの無い Issue の一覧の取り方（今の `listReadyManaged` はラベルで絞る）。
- 8 の「Project の上の Status」をどう知るか（同期が読んだ結果を tick の中で渡すなど）。
- 複数のホームが同じリポジトリを扱うときに、人が付けた `slack-thread` を二重に取り込まないか。
- 文書（両プラグインの SKILL.md・guide-ja.md・README・CLAUDE.md）の更新、共有の約束のテストへの影響の確認、版の上げ（slack-issue-intake・orca-team-dispatch-task とも minor）。
