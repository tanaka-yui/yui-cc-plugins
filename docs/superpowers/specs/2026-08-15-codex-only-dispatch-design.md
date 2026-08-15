# cmux-team-dispatch-task Codex-only 実行構成の設計

対象: `apps/cmux-team-dispatch-task`

## 背景

現行 v1.17.0 は、設計・レビュー・実装を model role ではなく engine の組み合わせから推測している。

- design=claude のレビューは codex
- design=codex のレビューは claude
- Phase B-R の reviewer は implementer と反対 engine
- prewarm は sonnet を常時起動し、codex runner があれば codex standby も常時起動

この前提では design / review が同じ codex engine の構成を表現できず、Claude runner が未登録または
利用不能な環境では `review_mode=on` を成立させられない。

codex runner には `review_model` と `exec_model` がある一方、Phase A の model を明示する
`plan_model` がない。さらに、prewarm の design codex pane は `--mode standby` で起動するため、
現行の model fallback では plan 用 pane に `exec_model` が適用され得る。

## 目的

1. Phase A plan/brainstorming を `gpt-5.6-sol`、Phase A-R/B-R review を
   `gpt-5.6-sol`、Phase B implementation を `gpt-5.6-terra` で実行できる
2. この構成では Claude command、sonnet pane、claude-engine reviewer を一切起動しない
3. design runner と review runner が同じ codex engine でも正式に動作する
4. 既存の cross-engine 構成と設定ファイルを後方互換で維持する
5. prewarm / spawn / prompt / review / cleanup / notification を model role で解決する

## 非目的

- Codex や Claude CLI 本体の変更
- `cmux-team-dispatch-task` 以外のプラグインの runner schema 変更
- Phase A-R/B-R の verdict ファイル形式、最大ラウンド数、配送 label の変更
- 新しい execution model family の追加

## 検討した案

### 案1: design/review/exec の役割を独立解決する

`design_runner`、`review_runner`、`exec_choice` を独立に解決し、runner に
`plan_model` / `review_model` / `exec_model` を持たせる。

利点:

- 同一 engine・別 model を自然に表現できる
- all-Codex と既存 cross-engine の両方を同じ role resolver で扱える
- model 名を topology や prompt にハードコードしない

欠点:

- `standby` が plan/exec のどちらなのかを明示する model role が必要
- prompt protocol と prewarm schema の更新範囲が広い

### 案2: `all_codex` プリセットを追加する

config に `all_codex: true` を追加し、固定の runner/model/topology へ展開する。

利点:

- 選択 UI と初期実装が小さい

欠点:

- 特定の model 名や pane 構成を特殊分岐へ埋め込むことになる
- runner/account を役割ごとに変更できない
- model 世代が変わるたびにプリセット実装の変更が必要

### 案3: 1 runner に全 role を束ねる

選択した runner 1 件を design/review/exec のすべてに使用し、runner 内の model field だけを切り替える。

利点:

- all-Codex の schema が最も小さい

欠点:

- 別アカウント、別 command、cross-engine review を役割ごとに選べない
- 現行の runner 選択機能より表現力が下がる

## 採用案

案1を採用する。特殊な all-Codex flag は追加せず、汎用的な role resolution の具体例として
all-Codex を構成する。

## runner schema

codex runner に任意の `plan_model` を追加する。

```json
{
  "default": "codex",
  "runners": [
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "plan_model": "gpt-5.6-sol",
      "review_model": "gpt-5.6-sol",
      "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh",
      "review_effort": "xhigh",
      "exec_effort": "high"
    }
  ]
}
```

model field の意味は engine ではなく role で固定する。

| field | role | 適用先 |
|---|---|---|
| `plan_model` | plan | `plan`、`superpowers`、prewarm design standby |
| `review_model` | review | Phase A-R/B-R の review pane |
| `exec_model` | exec | Phase B の `execute`、execution standby |

3 field は任意とし、未設定時は各 CLI の既定 model を使う。明示 `--model` は runner field より優先する。
既存 runner に `plan_model` がなくても挙動は変わらない。

effort field は現行どおり同じ role に対応させる。model と effort の resolver は同一 role を入力に取る。

## config と選択 UI

all-Codex の実運用 config は次の形とする。

```json
{
  "design_runner": "codex",
  "review_runner": "codex",
  "exec_choice": "codex",
  "review_mode": "on",
  "prewarm": true
}
```

### `design_runner`

現行の precedence と UI を維持する。

1. `<project>/.dispatch/config.json`
2. `~/.claude/cmux-team-dispatch-task/config.json`
3. interactive selection

### `review_runner`

新しい独立設定として同じ precedence を使う。

- runner 名: Phase A-R/B-R の固定 review runner
- `"ask"`: dispatch ごとに review-capable runner から選ぶ
- 未設定: 現行の cross-engine reviewer 自動解決を使う互換モード

固定/interactive の候補は engine が design runner と異なるものに限定しない。同じ codex runner も
`review_model` が解決できれば選択肢に表示する。Claude runner は既存互換のため `review_model` 未設定時に
`opus[1m]` fallback を維持し、codex runner は `review_model` がない場合 review-capable とみなさない。

初回セットアップ UI は codex runner の `plan_model` を収集し、runner 登録後に review runner 方針を選べるようにする。
選択肢は「現行の自動解決」「毎回選ぶ」「固定 runner」で、後二者は global config の
`review_runner` へ atomic な `mktemp` + `mv` で保存する。既存ユーザーの config にキーがなければ
追加質問を出さず互換モードへ入る。

### `exec_choice`

`"opus 1m"` / `"sonnet"` / `"codex"` / `"ask"` の既存値を維持する。
execution runner は選択された model family を実行可能な runner から導出する。

- codex: design runner が codex ならそれを優先し、それ以外は現行どおり先頭の codex runner
- sonnet / opus 1m: design runner が claude ならそれを優先し、それ以外は互換モードで解決した claude runner

固定値の engine を実行できる runner がない場合は、その config layer だけを invalid として警告し、
既存の project → global → interactive fallback を続ける。

## `launch-workspace.sh` の model role

mode から model role を次のように導出する。

| mode | default role |
|---|---|
| `plan` | plan |
| `superpowers` | plan |
| `review` | review |
| `execute` | exec |
| `standby` | exec |

prewarm design pane は idle 起動のため `standby` を使うが role は plan である。この曖昧さを解消するため、
`launch-workspace.sh` に `--role plan|review|exec` を追加する。mode と異なる role override は
`standby` でのみ許可する。既存 standby call はフラグ未指定のまま exec role を維持する。

Codex の composed command は role ごとに `--model` を含める。

| mode/role | Codex command の model 部分 |
|---|---|
| `plan` / plan | `--model <plan_model>` |
| `superpowers` / plan | `--model <plan_model>` |
| `review` / review | `--model <review_model>` |
| `execute` / exec | `--model <exec_model>` |
| `standby` / plan | `--model <plan_model>` |
| `standby` / exec | `--model <exec_model>` |

review caller が明示 `--model` を渡す現行 call site は互換のため受理するが、runner resolver 自体でも
`review_model` を適用する。これにより role/model の正しさが caller の推測に依存しない。

## prewarm topology

`prewarm-panes.sh` に解決済み `design_runner`、`review_runner`、`exec_choice` を渡す。
固定 `exec_choice` のときは選択されない execution pane を作らない。`exec_choice` が unset/`ask` のときだけ、
実行可能な選択肢の standby pane を作る。

all-Codex 固定構成では次の3 pane だけを起動する。

| role | runner | model | engine |
|---|---|---|---|
| design | codex | `gpt-5.6-sol` | codex |
| review | codex | `gpt-5.6-sol` | codex |
| exec | codex | `gpt-5.6-terra` | codex |

同じ runner を使っても pane は role ごとに分離する。plan/review/exec では sandbox、prompt、status ownership、
model が異なるため、同一 TUI 内の model switch には統合しない。

この構成では次を実行しない。

- `claude` command
- `--model sonnet` launch
- agmsg の `claude-code` join/delivery setup
- claude-engine review pane

`prewarm:false` の spawn fallback でも design/review/exec の解決済み runner を必ず渡し、hardcoded claude fallback に
到達させない。

### `prewarm.json`

model 名由来の `opus` top-level key を role 名へ置き換え、実在 pane のみを記録する。

```json
{
  "design": {
    "surface_id": "surface:1",
    "agent": "task-slug",
    "runner": "codex",
    "engine": "codex",
    "role": "plan",
    "delivery": "agmsg"
  },
  "review": {
    "surface_id": "surface:2",
    "agent": "task-slug-review",
    "runner": "codex",
    "engine": "codex",
    "role": "review",
    "delivery": "agmsg"
  },
  "executors": {
    "codex": {
      "surface_id": "surface:3",
      "agent": "task-slug-codex",
      "runner": "codex",
      "engine": "codex",
      "role": "exec",
      "delivery": "agmsg"
    }
  }
}
```

`executors` の key は `opus` / `sonnet` / `codex` とする。同じ model の design pane で継続実装する場合は
executor alias を作らず、prompt protocol が design pane 継続を選ぶ。cleanup は surface ID を一意化して列挙する。

## Phase A / Phase A-R / Phase B / Phase B-R

### Phase A

design runner と plan role だけを参照する。prompt 内の `always opus` 文言を削除し、解決済み runner/model を表示する。
non-prewarm の `plan` / `superpowers` command と prewarm design standby の両方が `plan_model` を使う。

### Phase A-R

固定 `review_runner` がある場合は専用 review pane が plan/spec をレビューする。review pane engine は
`prewarm.json.review.engine` または spawn 結果から取得し、design engine の反対側として計算しない。
同じ codex engine の design/review を許可する。

`review_runner` 未設定の互換モードでは現行の cross-engine resolver を残す。ただし prompt と script は
「常に反対 engine」という不変条件を持たず、resolver が返した runner/engine を入力として扱う。

### Phase B

固定 `exec_choice` は質問を出さず、`prewarm.json.executors[choice]` または spawn fallback へ進む。
all-Codex の `codex` choice は design pane では実装せず、exec role の専用 pane へ委譲する。

`.assigned-*`、指示配送、`.deferred` の順序と `send-prompt.sh --label phase-b-exec` は維持する。

### Phase B-R

固定 `review_runner` 経路では Phase A-R と同じ review pane がすべての implementation engine をレビューする。
reviewer は implementer と同じ engine でもよい。design pane が reviewer へ転じる既存の engine 推測は使用しない。

互換モードは現行 cross-engine assignment を保つが、assignment を専用 resolver の出力として表現する。
`parallel-directive.sh` には resolver または `prewarm.json` から得た実 reviewer engine を渡す。

`review/code-review.json` には `reviewer_runner` と `reviewer_engine` を記録する。spawn/prewarm のどちらでも
実装者はこの値を使ってレビュー依頼を構築し、反対 engine を再計算しない。

verdict path、5秒 polling、15分 liveness chunk、最大5 round、stalled fallback は変更しない。

## unattended loop

`render-loop-prompt.sh` は `--design-engine` だけで review protocol を決めず、解決済みの
design/review/exec runner と engine を受け取る。`phase-block-claude.md` / `phase-block-codex.md` は
engine 固有の CLI 操作だけを記述し、reviewer assignment は共通 role block へ移す。

all-Codex loop prompt に `Claude design pane`、`claude reviewer`、`sonnet` を含めない。
review request と completion/abort notification の `send-prompt.sh` label は維持する。

## cleanup と notification

cleanup は固定の `<slug>-sonnet` / `<slug>-codex` / `<slug>-opus` 一覧ではなく、`prewarm.json` に存在する
surface/agent を再帰的に列挙する。surface ID は重複除去してから close し、agmsg leave も実在 agent にだけ行う。

runner wrapper 内の `CLAUDE_CMD` / `CLAUDE_EXIT` と `Claude session starting/completed` は
`SESSION_CMD` / `SESSION_EXIT` と `runner session starting/completed` へ変更する。status、signal、parent notification の
契約自体は変えない。

prewarm の agmsg join/delivery type は pane の実 `engine` から選ぶ。all-Codex 構成では codex type だけを使う。

## エラー処理

- project/global の runner 名が存在しない: その layer だけを警告して無視し、次の layer へ fallback
- `review_mode=on` だが review-capable runner がない: 警告してその task の review を無効化
- review pane spawn 失敗: 現行どおり品質 gate を skip し Phase B へ進む
- fixed `exec_choice` を実行できる runner がない: config layer を invalid として fallback
- explicit `--role` が non-standby mode の自然 role と矛盾: pane 作成前に usage error
- runner の model field が空: `--model` を付けず CLI 既定へ fallback

## TDD

実装前に失敗テストを追加し、失敗理由が本機能に一致することを確認する。

### `launch-workspace.sh`

- codex `plan` / `superpowers` が `plan_model` を `--model` へ渡す
- codex `review` が `review_model`、`execute` / exec standby が `exec_model` を使う
- design standby + `--role plan` が `exec_model` ではなく `plan_model` を使う
- explicit `--model` が role field より優先する
- model と effort が同じ role を参照する

### `prewarm-panes.sh`

- design/review が同じ codex runner でも validation を通る
- all-Codex 固定構成の起動記録が3件とも codex である
- `claude` command、`--model sonnet`、claude-code agmsg wiring が0件である
- design/review/exec の model が sol/sol/terra に分かれる
- `exec_choice=codex` で未選択 executor を作らない
- unset/ask では既存の利用可能な executor 選択肢を維持する

### prompt / loop / cleanup

- prompt に reviewer opposite-engine の不変条件が残らない
- fixed review runner の実 engine が Phase A-R/B-R parallel directive に使われる
- all-Codex unattended prompt に Claude/sonnet launch 指示がない
- cleanup が `prewarm.json` の実 pane/agent だけを対象にする
- notification wrapper の状態文言が engine-neutral である

## 検証

実装後に次を実行する。

```bash
cd apps/cmux-team-dispatch-task
for test_file in test/test-*.sh; do
  bash "$test_file"
done

cd ../..
pnpm check
pnpm check:doc-lang
pnpm format
pnpm sort-package
```

加えて manifest JSON validation、`launch-workspace.sh --help` と SKILL.md の対応、SKILL.md と
`guide-ja.md` の見出し対応を確認する。

実 cmux E2E では all-Codex config で1タスクを Phase A → A-R → B → B-R まで進め、cmux topology と
子プロセスの command line を取得する。design/review/exec が指定 model の codex であることに加え、
`claude` command と `--model sonnet` の child process が0件であることを確認する。

## ドキュメント同期

同一変更で次を同期する。

- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md`
- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md`
- `apps/cmux-team-dispatch-task/README.md`
- `apps/cmux-team-dispatch-task/CLAUDE.md`
- `references/unattended/*.md`
- runner/config/prewarm schema の設定例

SKILL.md と英語 reference は英語、guide-ja/README/CLAUDE.md は日本語とする。

## version / cachebuster / reinstall

ユーザー向け機能追加のため version は `1.18.0` とする。

1. Claude/Codex manifest の base version とリポジトリの Claude marketplace version を同期する。
   marketplace JSON は対象 plugin/version を指定した構造化更新で変更し、手編集しない
2. `.agents/plugins/marketplace.json` は手編集しない
3. plugin-creator の `update_plugin_cachebuster.py` で Codex manifest に単一 cachebuster suffix を付ける
4. `validate_plugin.py` で plugin を検証する
5. `.agents/plugins/marketplace.json` の marketplace 名を `read_marketplace_name.py` で読む
6. `codex plugin list` で local source を確認する
7. `codex plugin add cmux-team-dispatch-task@<marketplace-name>` で再インストールする
8. 新しい thread で更新版を読み込める状態にする

cachebuster は `<base-version>+codex.<timestamp>` の1個だけとし、既存 suffix があれば置換する。
Codex manifest だけに付く suffix は、ローカル Codex 再インストールのための意図的な surface 差分とする。

## 完了条件

次の設定で実 dispatch を構成できること。

```text
plan/brainstorm = gpt-5.6-sol
review = gpt-5.6-sol
implementation = gpt-5.6-terra
review_mode = on
exec_choice = codex
```

実行中の child process/pane は design Codex、review Codex、implementation Codex のみであり、
Claude process、sonnet pane、claude-engine reviewer は存在しない。既存の cross-engine config は
新しい必須 key を追加しなくても従来の互換 resolver で動作する。
