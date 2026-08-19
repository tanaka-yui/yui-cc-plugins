# cmux-team-dispatch-task タスク個別の一時上書きの設計

対象: `apps/cmux-team-dispatch-task`

## 背景

v1.20.0 で役割ごとの model / effort は `runners.json` の役割フィールドに一本化され、
`design_runner` / `review_runner` / `exec_choice` は config の 2 レイヤー
(プロジェクト → グローバル) で解決されるようになった。解決値は dispatch 単位で決まり、
その dispatch に含まれる全タスクへ一律に適用される。

しかし実際のディスパッチでは、同時に投げる複数タスクの難易度が揃っていない。難しい
1 タスクだけ effort を上げたい、そのタスクの実装だけ別 engine に投げたい、という要求が
現行の解決モデルでは表現できない。恒久設定を書き換えて dispatch し、また戻すしかない。

Step 1f には「今回だけタスクごとに runner を選ぶ」分岐が既にあるが、対象は design runner
だけで、model と effort には届かず、review / exec 役割も選べない。

## 目的

1. 1 回の dispatch に限って、**タスク単位で** design / review / exec の
   runner / model / effort を上書きできるようにする
2. 上書きは対話で選ぶ。タスク一覧を見てから「どれが難しいか」を判断できる
3. 上書きを恒久設定へ書き戻さない
4. 上書きした内容を起動前に画面で確認できる

## 非目的

- 宣言的な指定構文 (`--override 2:design.effort=max` のようなフラグ引数)。対話式のみとする
- `--loop` の無人実行から使えるようにすること。対話が必要なので構造的に両立しない
- `review_mode` / `prewarm` / 統合戦略 / brainstorming モードの上書き。対象は
  runner / model / effort の 3 次元 × design / review / exec の 3 役割だけ
- 上書き値の永続化。`--override` は config への書き込み経路を持たない
- 既存の Step 1f 「今回だけタスクごとに runner を選ぶ」分岐の削除。両者は共存する
  (§8 に関係を書く)

## 決定事項

ブレインストーミングで確定した内容。

| 論点 | 決定 |
|------|------|
| 指定方法 | 対話式のみ。フラグは値を取らない |
| 質問フロー | タスク選択 → 役割選択 → 選ばれた役割の runner / model / effort |
| exec の粒度 | 3 役割とも **runner 名**を選ぶ。exec は選んだ runner の engine が `EXEC_ENGINE` になる |
| precedence | `--override` が最上位。config にも runners.json にも書き戻さない |
| 表示 | Template A の表は変えず、直後に上書き差分のブロックを出す |

## 設計

### 1. CLI 面

`--override` を引数レベルのフラグとして追加する。値は取らない。

- `argument-hint` を
  `"<task1>, <task2>, ... [--loop] [--setup] [--reset [runners|config|all]] [--override]"`
  に更新する
- **`--loop` / `--setup` / `--reset` と排他**。`--setup` の既存の排他規則と同じ文面
  (`references/setup-mode.md:74`) に倣い、2 つ以上指定されたらエラーで停止する。
  `--loop` との排他は「無人実行では対話できない」ことが理由なので、エラーメッセージに
  その理由を含める
- Step 1a のタスク解析より前に検出し、**タスク名として扱わない**。`--setup` / `--reset`
  が Step 1a へ落ちないのと同じ扱い

### 2. 質問の位置と流れ

**Step 1g の後、Step 1h (サマリー表示) の前**に置く。通常の解決を先に完了させることで、
各質問の「変更なし」に現在の解決値を表示できる。

`--override` が無いときはこのステップ全体をスキップする。

```
Call 1: which tasks to override        (multiSelect, 4 options max)
Call 2: which roles for <task>         (multiSelect: design / review / exec)
Call 3..: per selected role, one call of 3 questions (runner / model / effort)
```

役割 1 つなら 1 タスクあたり 3 コール、3 役割すべてでも 5 コール。

**タスクが 4 件を超える場合**は、AskUserQuestion の 4 択上限に合わせて先頭 3 件を
明示し、残りは自動付与される "Other" の自由入力でタスク名を受ける。これは
`runners[]` が 5 件以上のときの既存規約 (`setup-mode.md` S5) と同じ扱いにする。

### 3. 質問の選択肢

すべての質問で **先頭の選択肢は `変更なし (現在: <解決値>)`** とする。解決値は Step 1f/1g が
出したもので、`runners.json` の役割フィールドと既定値を適用済みの値を表示する。

| 次元 | 選択肢 |
|------|--------|
| runner | `変更なし` + `runners[].name` を 3 件まで。残りは Other 自由入力 |
| model (claude engine) | `変更なし` / `opus[1m]` / `sonnet` / `fable`。任意値は Other |
| model (codex engine) | `変更なし` + その runner の役割モデル。任意値は Other |
| effort (claude engine) | `変更なし` / `xhigh` / `max` / `high` |
| effort (codex engine) | `変更なし` / `xhigh` / `high` / `medium` |

model 文字列は v1.20.0 と同じく検証しない。effort は engine 別の allowlist
(claude `low|medium|high|xhigh|max` / codex `minimal|low|medium|high|xhigh`) で
検証する。**codex に `max` は提示しない** — v1.20.0 で codex の `max` 受理を確認できず
安全側に倒した判断をそのまま引き継ぐ。

runner / model / effort の 3 問は 1 コールにまとめるため、**選択肢を組み立てる時点では
runner の回答がまだ分からない**。したがって選択肢は「現在の解決 engine」で組み立てる。

回答が揃った結果、上書き後の runner の engine と、選ばれた model / effort が食い違う
ことがある (例: runner を codex にしつつ model に `fable` を選ぶ)。この場合は次の規則で
解決する。

- **runner の回答が engine を決める。** model / effort は従属する
- 選ばれた effort が新しい engine の allowlist に無ければ、警告を出し、その役割の
  **新しい engine における既定 effort** (plan/review `xhigh` / exec `high`) を使う
- 選ばれた model が claude 専用のエイリアス (`opus[1m]` / `sonnet` / `fable`) で新しい
  engine が codex なら、警告を出し、その役割の **model 上書きを取り消す**
  (= `runners.json` の役割フィールド → 既定値の通常解決に戻す)。model 文字列は検証
  しないので、これは alias 名の一致だけで判定する
- どちらの場合も dispatch は止めない。警告は Step 1h の上書きブロックにも残す

### 4. precedence

```
--override  >  <project>/.dispatch/config.json  >  ~/.claude/.../config.json
            >  runners.json の役割フィールド  >  組み込み既定値
```

上書きはメモリ上の解決値 (`DESIGN_RUNNER` / `DESIGN_ENGINE` / `PLAN_MODEL` /
`PLAN_EFFORT` / `EXEC_CHOICE` / `EXEC_RUNNER` / `EXEC_ENGINE` / `EXEC_MODEL` /
`EXEC_EFFORT` / `REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` / `REVIEW_EFFORT`)
を置き換えるだけで、`config-edit.sh` を呼ばない。

exec の runner を上書きしたときは、その runner の `engine` を `EXEC_ENGINE` と
`EXEC_CHOICE` の両方へ反映する。`EXEC_CHOICE` は engine 語彙 (`claude` / `codex`) なので
そのまま代入できる。

**`REVIEW_EFFORT` は新規に導入する。** 現行の SKILL.md には review 役割の effort 変数が
無く、`SKILL.md:559` は「`REVIEW_RUNNER` / `REVIEW_ENGINE` / `REVIEW_MODEL` が review の
入力のすべて」と明言している。review の effort を上書き対象にする以上、Step 1g の review
解決に `REVIEW_EFFORT` を追加し (runner の `review_effort` → 既定 `xhigh`)、`SKILL.md:559`
の記述を 4 変数へ改める必要がある。あわせて substitution tuple にも `{{REVIEW_EFFORT}}` を
追加する — v1.20.0 が `{{PLAN_EFFORT}}` / `{{EXEC_EFFORT}}` を足したときに review だけ
取り残されていた穴でもある。

なお `prewarm-panes.sh` は v1.20.0 で未使用の `REVIEW_EFFORT` 変数を削除している。今回
追加するのは同名だが別物 (親側の解決値であり、prewarm へは `--reviewer-effort` として
明示的に渡る) なので、削除を巻き戻すのではなく新しい配線として実装する。

### 5. `prewarm-panes.sh` への配線

役割別の model / effort 上書きフラグを追加する。既存の `--design-runner` /
`--reviewer-runner` / `--exec-runner` と同じ命名に揃える。

```
--design-model <m>    --design-effort <e>
--reviewer-model <m>  --reviewer-effort <e>
--exec-model <m>      --exec-effort <e>
```

`prewarm-panes.sh` はこれらを該当ペインの `launch-workspace.sh` 呼び出しへ
`--model <m>` / `--effort <e>` として転送する。`launch-workspace.sh` の優先度は既に
`明示 > runner の役割フィールド > 既定値` なので、転送された値が勝つ。

既存の `--review-model` (claude 設計 + codex reviewer の legacy 指定) は**別物として
残す**。新しい `--reviewer-model` は `--reviewer-runner` 経路の上書きで、legacy 経路には
関与しない。両者を同時に渡すのは誤用なのでエラーにする。

> v1.20.0 で prewarm から `--model` を取り除いたのは、暗黙のハードコードをやめて役割
> フォールバックへ委ねるためだった。ここで入れるのは明示的な上書きであり、documented な
> precedence の第 1 段に乗るだけなので方針と矛盾しない。

非 prewarm の spawn 経路 (`launch-workspace.sh --mode execute`) には
`--effort "$EXEC_EFFORT"` を追加する (`--model "$EXEC_MODEL"` は既にある)。

### 6. in-session ルールとの関係

上書きは `IN_SESSION` の計算より前に解決値へ適用されるので、特別扱いを入れない。

- exec を design と同じ runner / model / effort に上書きすれば in-session になり、
  prewarm は実装ペインを起動しない
- 逆に片方だけ変えれば in-session が解除され、実装ペインが起動する

`prewarm-panes.sh` 側の in-session 判定も、新しい `--exec-model` / `--exec-effort` /
`--design-model` / `--design-effort` が渡されたときはそれを解決値として使う。
渡されていない役割は従来どおり `runners.json` + 既定値から解決する。

### 7. 子セッションへの伝播

v1.20.0 で整えた substitution tuple がそのまま使える。上書きは tuple に入る**値**を
変えるだけで、**新しい placeholder は追加しない**。

### 8. 既存の Step 1f 分岐との関係

Step 1f の「今回だけタスクごとに runner を選ぶ」(switch 質問の選択肢 2) は残す。両者の
役割分担を SKILL.md に明記する。

| 経路 | 対象 | 粒度 |
|------|------|------|
| Step 1f の switch 質問 | design runner のみ | タスクごと |
| `--override` | design / review / exec の runner / model / effort | タスクごと |

両方が指定された場合は `--override` が後段なので勝つ。Step 1f で選んだ design runner を
`--override` がさらに上書きしても矛盾は起きない。

### 9. 表示

Template A の表そのものは変更しない (表示規約が厳格なため)。表の直後に上書き差分の
ブロックを出す。

```
上書き (この dispatch のみ):
  auth-api  exec    runner codex / model gpt-5.6-terra / effort xhigh
  auth-api  design  effort max
```

出すのは**変更した次元だけ**で、変更していない次元は行に含めない。上書きが 1 件も
無いときはブロックごと出さない。

## テスト計画

新規 `test/test-override.sh`:

- OV1: `prewarm-panes.sh` が `--design-model` / `--design-effort` を design ペインの
  `--model` / `--effort` として転送すること
- OV2: 同じく `--exec-model` / `--exec-effort` を実装ペインへ転送すること
- OV3: 同じく `--reviewer-model` / `--reviewer-effort` を review ペインへ転送すること
- OV4: 転送された明示値が `runners.json` の役割フィールドより優先されること
  (runner に別値を持たせた fixture で確認する)
- OV5: `--reviewer-model` と legacy `--review-model` の同時指定がエラーになること
- OV6: `--exec-model` / `--exec-effort` が in-session 判定に反映されること
  (上書きで design と一致させると実装ペインが起動しないこと)
- OV7: engine 別 effort allowlist が新フラグにも効くこと (codex へ `max` を渡すと die)
- OV9: `--reviewer-effort` が claude / codex 双方の review ペインへ届くこと
  (claude は `--effort`、codex は `-c model_reasoning_effort=`)

SKILL.md 側の静的検査 (`test-setup-skill.sh` に相当する形):

- OV8: `--override` と `--loop` / `--setup` / `--reset` の排他が SKILL.md に記述され、
  `argument-hint` に `--override` が含まれること

既存スイートは全て通ること。テストは worktree ディレクトリを事前作成し、実リポジトリへ
`git worktree add` を走らせないこと。

## ドキュメント整合

`CLAUDE.md` の 4 ファイル整合ルールに従い、同一 commit で更新する。

1. `skills/cmux-team-dispatch-task/SKILL.md` (英語・SoT)
2. `skills/cmux-team-dispatch-task/references/guide-ja.md`
3. `README.md`
4. `CLAUDE.md`

`--loop` との排他は `references/loop-mode.md` と `loop-mode-ja.md` にも書く。
`--setup` / `--reset` との排他は `references/setup-mode.md` と `setup-mode-ja.md` にも書く。
`pnpm check:doc-lang` を通すこと。

## 実装時に検証する未確定事項

1. **AskUserQuestion の "Other" 自由入力が multiSelect でも使えるか** — タスクが 4 件を
   超えるときの逃がし方がこれに依存する。使えない場合は「タスク選択を 1 問ではなく
   4 件ずつのページに分ける」へ切り替える
2. **`--reviewer-effort` が claude reviewer に効くこと** — claude の review ペインは
   `--mode review --role review` で起動する。`--effort` がこの経路で composed command に
   入ることを実機で確認する
