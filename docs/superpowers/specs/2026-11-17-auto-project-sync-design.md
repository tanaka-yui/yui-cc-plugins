# --auto の GitHub Project の Status とラベルの同期（C2c）の設計

元の設計は `2026-11-13-auto-dispatch-additions-design.md` の 5.4 と 11。この文書はその C2c の部分を、作れる粒度に落としたもの。2026-11-17 に承認。

## 目的

人は GitHub Project のボードで Status を動かしても、Issue のラベルを付け替えても、同じ結果になってほしい。`--auto` と slack-issue-intake の通知はラベルだけを読むので、Project で変えた変化をラベルへ写し、`--auto` や人がラベルで変えた変化を Project へ写す。

## やること / やらないこと

やること:

- 拾う元ごとに任意の Project を 1 つ登録できるようにする。
- `--auto` の tick のたびに、Project の Status とステータスラベルを両方向で揃える。

やらないこと（C3 の `make setup` で扱う）:

- Status の選択肢にステータス 8 つを足すこと。
- gh に `project` の権限があるかの事前確認。
- GitHub の組み込みの workflow（追加したら Todo など）を止める案内。

やらないこと（この版では扱わない）:

- 別の organization のリポジトリの Issue を 1 つの Project にまとめること。
- Issue を Project に足すこと。Project に入っていない Issue はラベルだけで動く。

失敗とみなすこと:

- 人が Project かラベルで変えたステータスを、同期が古い値に戻すこと。

## やり方の比較

| やり方 | 長所 | 短所 |
|---|---|---|
| **tick ごとに問い合わせる（採用）** | 今の tick の形にそのまま載る。親が止まっていても、再開した最初の回にまとめて揃う | 反映が tick の間隔ぶん遅れる |
| GitHub Actions / webhook で変化を受ける | すぐ反映される | Project v2 の変化（`projects_v2_item`）は organization の webhook にしか来ず、リポジトリの Actions には届かない。個人の Project では使えない |
| ラベルだけを正にし、Project は表示用に片方向で写す | 単純 | 「Project で動かしたらラベルも変わる」を満たさない |

webhook の案は個人の Project で成り立たないため外した。

## 設計

### 設定

拾う元（`sources[]`）の各要素に、任意で `project: { owner: string, number: number }` を持てるようにする。無ければその拾う元は同期しない。`owner` は個人でも organization でもよい。

### 読む

tick の初めに、登録された Project ごとに、項目を GraphQL で 1 回読む（100 件ずつページを送る）。2026-11-17 の下調べで、次の形で読めることを確かめた。

```graphql
query($owner:String!,$number:Int!,$after:String){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){
    items(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{
      id isArchived
      content{ ... on Issue{ number repository{nameWithOwner} labels(first:20){nodes{name}}
        timelineItems(last:20, itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){ nodes{
          ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}} } } } }
      status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId updatedAt } }
    } } } } } }
```

- 対象は、その拾う元のリポジトリの Issue で、管理しているもの（`from-slack` か `slack-thread` が付いている）、かつ archive されていない項目だけ。開いているかどうかは問わない。
- Issue のラベル側の値は、付いているステータスラベルのうち `STATUS_LABELS` の優先順で最初のもの（今の判定と同じ）。無ければ「なし」。
- ラベル側の時刻は、timeline のステータスラベルの付け外しのうち、いちばん新しい `createdAt`。見つからなければ最古（時刻 0）とみなす。
- Status 側の値と時刻は、`status.name` と `status.updatedAt`。名前は大文字小文字を区別せずにステータス 8 つと比べる。
- Project の Status の選択肢の名前から option の id を引く表も、同じ回に読む（Status 欄の `options`）。

### 揃える

状態ファイルに、Issue ごとの前回の組 `{ status, label }` を持つ（`owner/repo#N` を鍵にした新しい欄。今の `issues` とは別にする。`--auto` が拾っていない Issue も対象になるため）。

| 前回から変わったもの | すること |
|---|---|
| どちらも変わっていない | 何もしない |
| Status だけ | ラベルを Status に付け替える（他のステータスラベルは外す） |
| ラベルだけ | Status をラベルの値に動かす |
| 両方（または前回の記録が無く、2 つが食い違う） | 時刻があとのほうに合わせる。同じ秒ならラベルに合わせる |

- 書き込みが成功したら、前回の組を揃えたあとの値で書き直す。失敗したら書き直さない。次の tick がもう一度試す。
- Status がステータス 8 つのどれでもない（`Todo`、空など）ときは、どちらも動かさない。前回の組も書き換えない。
- ラベルが「なし」のときも、Status を動かさない（ラベルを全部外したことを「Status を消す」とは読まない）。
- Project の Status の選択肢に、写す先の値が無いときは、その Issue を飛ばして tick の出力に 1 行書く。

### `--auto` 自身がラベルを動かしたとき

tick の終わりと `judge-apply` の終わりにも、同じ同期をもう 1 回走らせる。`--auto` がこの回で動かしたラベルは「ラベルだけが変わった」として Status に写る。ラベルを動かす箇所ごとに Status の書き込みを足さないのは、箇所が多く、写し漏れが起きやすいため（私の判断）。

### 権限が無いとき・読めないとき

GraphQL が権限不足（`INSUFFICIENT_SCOPES`）や Project が見つからないエラーを返したら、tick の出力に 1 行書いて同期を飛ばす。tick 自体は止めない。

## 作る人に任せること

- 同期の処理をどのファイルに置くか（`lib/auto-project.ts` のような新しいファイルを想定）。
- テストでの gh の差し替え方（今の `test/unit` の fake gh の形に合わせる）。
- tick の出力の文言。

## 実機での確かめ

tanaka-yui の使い捨ての Project（`https://github.com/users/tanaka-yui/projects/1`、`orca-auto-sync-spike`。Status にステータス 8 つと `Todo` を手で足し済み）を orca-auto-e2e につないで使う。下調べ用の Issue は #21。

1. Project で Status を動かす → 次の tick でラベルが変わる。
2. ラベルを付け替える → 次の tick で Status が変わる。
3. 両方を変える → あとのほうに揃う。
4. `Ready` にした Issue を `--auto` が拾う → In progress / In review が Project にも出る。
5. Status を `Todo` にする → ラベルは変わらない。
