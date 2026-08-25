# cmux-e2e 設計仕様

## 1. 目的とスコープ

cmux 内蔵ブラウザ（`cmux browser` CLI）を使った E2E テスト実行基盤を、新規プラグイン
`apps/cmux-e2e` として追加する。

### 既存手段の欠点

| 手段 | 欠点 |
|------|------|
| Playwright | ランタイムが重い。ブラウザバイナリの導入が必要 |
| Claude in Chrome extension | MCP 経由で Claude 専用。codex ペインから使えない |
| `apps/e2e-test`（agent-browser） | 固定的なシナリオ実行向け。認証など「画面を見ながら操作したい」用途に弱い |

`cmux browser` は CLI なので codex ペインからも叩け、実際に cmux の画面へ表示されるため
認証フローを目視しながら進められる。この 2 つを同時に満たす手段は他に無い。

### 非目標（決定済み・再検討しない）

- `apps/e2e-test` を置き換えない。並存させ、当該ディレクトリに差分を出さない
- `--engine cmux|agent-browser` のようなバックエンド切替を作らない
- `~/.agents/skills/cmux-browser`（cmux 公式の汎用ブラウザ操作スキル）と役割を重複させない

## 2. 責任境界

3 つの近接資産があり、それぞれ層が違う。

| 資産 | 層 | 担当 |
|------|----|------|
| `~/.agents/skills/cmux-browser` | 操作プリミティブ | 1 回のブラウザ操作の作法（snapshot → ref で操作 → wait → 再 snapshot） |
| `apps/cmux-e2e`（本件） | テスト実行基盤 | サーフェス確保・認証ステート・シナリオ実行・結果集約・合否判定 |
| `apps/e2e-test` | 別バックエンドの実行基盤 | agent-browser によるヘッドレス / CI 向け実行 |
| `apps/dev-up` | 環境供給 | worktree ごとのポートスロットと `.env.dispatch` |

重複回避の原則: **cmux-e2e は個々のブラウザ操作の使い方を説明しない**。
`click` / `snapshot` / `find` の作法は cmux-browser の管轄であり、cmux-e2e はそれらを
「シナリオの中で自由に呼ぶもの」として扱い、その外側（何を用意し、何を残し、何をもって失敗とするか）
だけを規定する。

## 3. アーキテクチャ

3 層に分ける。

```
scripts/*.sh              … CLI 入口。サーフェス確保・認証・シナリオ起動・結果集約
skills/cmux-e2e/SKILL.md  … エージェント向けの手順書。どのサブコマンドをいつ使うか
.cmux-e2e-scenarios/*.sh  … 検証したい UI フロー。プロジェクト側が書く（プラグインは同梱しない）
```

状態の置き場所は 2 つに分かれる。**control-plane はリポジトリの外に置く**。

| 置き場所 | 内容 | 消えてよいか |
|---------|------|-------------|
| `~/.cache/cc-skills/cmux-e2e/<project>/surfaces/` | サーフェスレジストリ | 消えると孤児が出る。消してはならない |
| `~/.cache/cc-skills/cmux-e2e/<project>/auth/` | 認証ステートと検証条件 | 消すと再ログインが必要 |
| `<worktree>/.cmux-e2e-scenarios/` | シナリオ | プロジェクト側の資産 |
| `<worktree>/.cmux-e2e-results/` | 成果物 | いつ消してもよい |

データフロー:

```
project key 解決（.dev-up.yaml → git remote → git common dir）
        │
        ▼
surface 確保（保持型・レジストリを cache root に記録）
        │  CMUX_E2E_SURFACE + identity guard ラッパー
        ▼
認証ステート適用（--auth 指定時のみ: load → check）
        │
        ▼
シナリオ実行（bash。cmux-e2e-browser 経由で操作）
        │
        ▼
結果集約（screenshot / console / errors）→ summary.md → 合否判定
```

## 4. 設計判断

要件定義の「設計で詰めるべき論点」6 項目に 1:1 で対応する。

## 4.1 サーフェスのライフサイクル

**決定**: worktree ごとに 1 サーフェスを保持して使い回す（保持型）。破棄は `down` でのみ行う。

**レジストリの置き場所**: `~/.cache/cc-skills/cmux-e2e/<project>/surfaces/<worktree-key>.json`。
worktree 内には置かない。`.cmux-e2e-results/` は成果物であり掃除の対象なので、そこへ
control-plane の状態を置くと「結果を消したら ref を失い、画面に残った surface を `down`
できなくなる」経路が生まれる。レコードは dev-up の `owner.json` に倣い
`{surface_ref, worktree, created_at}` を持つ。

**孤児の回収**: worktree ごと消された場合はレコードだけが残る。`down --sweep` は
`worktree` が実在しないレコードを走査し、対応する surface を閉じてレコードを消す。
dev-up の `reserve-slot.sh` が Phase 1 で行っている zombie sweep と同じ発想である。

**サーフェス解決の状態遷移**: 「一致しなければ作り直す」と「不一致なら中断」を混ぜてはならない。
3 状態を区別して、状態ごとに `up` と `run` の挙動を固定する。

| 状態 | 判定方法 | `up` の挙動 | `run` の挙動 |
|------|---------|------------|-------------|
| A. レコードが無い | ファイル不在 | 新規作成して記録 | exit 1（`up` を促す） |
| B. ref が消滅、または browser ではない | `cmux --json list-pane-surfaces` に ref が無い、または type が browser でない | 作り直して記録を更新 | exit 1（`up` を促す） |
| C. ref が**生きている別の surface** に解決される | `cmux --json browser --surface <ref> identify` の `surface_ref` が要求と不一致 | **中断（exit 1）** | **中断（exit 1）** |

C を作り直しにしないのは、他人の画面を操作しうる状態で新しい surface を増やすと、
どちらが自分のものか判別できなくなるためである。B と C を分けるために、存在確認は
`browser` 経路ではなく汎用の `list-pane-surfaces` で行う。実測 T4 のフォールバックは
`browser` 経路固有であり、汎用リゾルバは正確だった（`read-screen --surface surface:36` は
surface:36 を正しく読んだ）。

**検証後レースの扱い**: 上の検証は `run` の開始時点のものでしかない。シナリオ実行中に
対象 surface が閉じられると、以降の `cmux browser --surface` は実測 T4 のフォールバックにより
別画面へ届きうる。UUID を渡しても回避できない（UUID 指定でも別 surface が返った）。

対処として、シナリオへは生の ref だけでなく **identity を保証するラッパー**を渡す。
`run` は一時ディレクトリに実行可能な `cmux-e2e-browser` を作り、`PATH` の先頭へ置く。
ラッパーは毎回 `identify` で `surface_ref` の一致を確認してから本来のコマンドを実行し、
不一致なら非ゼロで終了する。

これは 4.4 の「ヘルパーライブラリを提供しない」に反しない。禁じているのはアサーションや
テスト記述のための DSL（cmux-browser と責務が重なるもの）であって、これは identity guard、
すなわち実行基盤の側の責務である。

呼び出しが 2 倍になるため、`CMUX_E2E_NO_GUARD=1` で無効化できるようにする。
実測 T4 がブラウザサーフェス不在時のフォールバックに過ぎないと確認できれば（R2）、
既定を緩める余地がある。

**破棄の経路**: `browser close|quit|kill|destroy` は存在しない（`Unsupported browser subcommand`）。
teardown は `cmux close-surface --surface <ref>` を使う。`down` は冪等とし、
レコードが無い場合も surface が既に無い場合も exit 0 で終わる。

**根拠（保持型を選ぶ理由）**:

- 本タスクの中核は認証である。ログイン済みの状態はサーフェスとプロファイルに紐づくため、
  シナリオごとに開いて閉じると毎回ログインし直すことになり、要件そのものを壊す
- surface identity は move / reorder をまたいで安定（`~/.agents/skills/cmux/references/panes-surfaces.md`）
- 目視できることが `cmux browser` を選ぶ理由そのものなので、シナリオ終了時に自動で閉じるのは
  この手段の利点を捨てることになる

**却下案**: シナリオごとに open して閉じる。認証状態が毎回失われるうえ、失敗時に画面が残らず、
「実際に画面を見ながら原因を追う」という採用理由が消える。

## 4.2 worktree 並列時の分離

**決定**: 鍵を 2 種類に分ける。混ぜてはならない。

| 鍵 | 用途 | 解決順 | worktree ごとに変わるか |
|----|------|--------|----------------------|
| project key | 認証ステートとサーフェスレジストリの置き場所 | ① `.dev-up.yaml` の `project` ② git remote の basename（`.git` を除去） ③ git common dir の親ディレクトリ名（= メインチェックアウト名） | **変わらない** |
| session key | 同時実行の識別（ログ表示・診断） | `.env.dispatch` があれば `<PROJECT>-<SLOT>`、無ければ worktree ディレクトリ名 | 変わる |

**分けなければならない根拠**: 認証ステートを worktree ごとに分断すると「一度ログインしたら
以降のシナリオで使い回す」という中核要件を壊す。worktree は cmux-team-dispatch-task が
使い捨てる前提の存在なので、project key が worktree 名に依存してはならない。
解決順 ③ が git common dir を使うのは、worktree から見てもメインチェックアウトが同一に定まるためである
（agmsg の `agmsg_gitcommon_project` が同じ手法を採っている）。

**project key の検証**: 解決結果は `^[A-Za-z0-9._-]+$` に一致しなければならない。
一致しない場合は exit 1 とし、`.dev-up.yaml` へ明示するよう促す。`..` や `/` を含む値を
パス要素にしないための最低条件である。

**分離の実体**: サーフェスを worktree ごとに分けることで成立させる。ブラウザプロファイルの
分離は既定にしない。プロファイルを分けると認証ステートまで分断され、上記の中核要件と衝突する。
プロファイルを分けたい場合は `up --profile <name>` で明示的に選ばせる。

**`.env.dispatch` を必須にしない根拠**:

- `.env.dispatch` は `PROJECT` と `SLOT` を固定キーとして持ち、e2e-test は
  `AGENT_BROWSER_SESSION="$PROJECT-$SLOT"` の 1 行だけで分離を成立させている
- ただし **このリポジトリには `.dev-up.yaml` も `.env.dispatch` も存在しない**。dev-up を
  導入していないプロジェクトで使えなければ、完了条件である実機確認（公開ページに対する操作）
  自体が実行できない
- dev-up の main worktree はそもそも slot を持たない設計であり、`.env.dispatch` 不在は
  異常ではなく正常系のひとつである

## 4.3 認証状態の扱い（中核）

**前提の整理**: `state save` / `state load` の**使い方そのものは cmux-browser スキルが
既に全面的に文書化している**（`references/authentication.md` に基本ログイン・OAuth/SSO・2FA・
cookie 認証・トークン更新・セキュリティ規則まで揃っている）。cmux-e2e は認証の**やり方**を
再説明せず、cmux-browser の該当リファレンスへリンクする。cmux-e2e が持つのは運用の側、すなわち
**保存先の規約・鍵付け・入力契約・実行前の有効性検証・秘密情報の保護・失敗時の報告**である。

**保存レイアウト**:

```
~/.cache/cc-skills/cmux-e2e/<project>/auth/<name>.json     ← storageState 本体
~/.cache/cc-skills/cmux-e2e/<project>/auth/<name>.meta.json ← 検証条件
```

`<project>` は 4.2 の project key。`<name>` は `^[A-Za-z0-9._-]+$` に一致しなければならず、
一致しない場合は exit 2（シナリオ名と同じ扱い）。これにより `..` や `/` による
別プロジェクトの読み書きを構造的に封じる。書き込み前に解決後の絶対パスが固定 cache root
配下にあることを再確認し、経路上に symlink があれば拒否する。

**秘密情報の保護**: state は bearer token 相当を含む。

- ディレクトリは `0700`、ファイルは `0600` で作成する
- 保存は一時ファイルへ書いてから `mv` で置き換える（atomic rename）。途中で落ちたときに
  中途半端な state を残さない
- リポジトリの外に置くため、`.gitignore` への追加漏れがそのままコミット事故になる経路が消える

**サブコマンドと入力契約**:

| 操作 | 形 | 内容 |
|------|-----|------|
| 保存 | `auth save <name> [--check-url <url>] [--check-selector <css>]` | 現在のサーフェスの storageState を保存し、検証条件を meta へ書く |
| 読込 | `auth load <name>` | state をサーフェスへ適用する |
| 検証 | `auth check <name>` | `load` → `--check-url` へ遷移 → `--check-selector` を `wait` |
| 一覧 | `auth list` | `<project>` 配下の name を列挙する |
| 削除 | `auth delete <name>` | state と meta を消す |

**`run` との結び付け — 明示 opt-in にする**:

`run <scenario> [--auth <name>]` とし、`--auth` が無ければ認証を一切扱わない。

根拠: 要件は「認証を含む UI フロー」を検証できることであって、全シナリオが保存済み認証を
前提とするとは定めていない。ログイン画面そのものや未認証からのリダイレクトを検証する
シナリオは、`run` が常に `auth check` を通すと実行できなくなる。また同一プロジェクトに
admin / customer など複数の state がある場合、どれを使うかを `run` が決められない。

`--auth <name>` が与えられたときの動作:

1. `<name>.json` が無ければ exit 1（`auth save` を促す）
2. `auth check <name>` を実行する
3. meta に `check_url` / `check_selector` の両方が無ければ検証せず、
   「検証していない」と警告を出して続行する（黙って通さない）
4. 検証に失敗したら exit 1。「ステートが失効している。`auth save` で保存し直せ」と手順を示す

**失効検知の限界**: `state load` は「ファイルを読めたか」しか判定できない。セッションが
有効かどうかは、認証済みでのみ現れる目印を実際に待つ以外に判定手段が無い。
だから meta に検証条件を持たせ、実行基盤の工程として通す。

**`import` の扱い — 実測による重大な注意**:

実測中に `cmux browser --surface surface:9999 import` が**実際に走り、Chrome から 3808 件の
cookie をデフォルトプロファイルへ取り込んだ**。surface 引数は無視され（プロファイル単位の
操作である）、既定が非対話・デフォルトプロファイル宛て・確認なしである。

したがって次を規約とする。

- 実行基盤は `import` を**自動では呼ばない**。`up` / `auth` / `run` / `down` のどの経路からも呼ばない
- SKILL.md では `--from <browser> --to-profile <name> --non-interactive` を明示した形でのみ提示し、
  無引数呼び出しが破壊的であることを警告として書く
- SSO 済みセッションの持ち込みは有用なので導線としては残すが、実行するのは人間または
  エージェントの明示的な判断とする

**却下案**: cookie を個別に `cookies set` する。`state save|load` が storageState 相当を
まとめて扱えるのに、localStorage / sessionStorage の分を取りこぼす。

## 4.4 シナリオの記法

**決定**: `apps/e2e-test` と同じ bash スクリプトに揃える。置き場は
`<worktree-root>/.cmux-e2e-scenarios/<name>.sh`。契約は環境変数のみで、ヘルパーライブラリを
提供しない。合否はシナリオの終了ステータスとする。

**根拠**:

- e2e-test の実装がまさにこの形（`bash "$SCENARIO_FILE"` を呼ぶだけ、アサーションヘルパー無し、
  合否は `set -euo pipefail` 下の exit status）。要件定義も「揃えるほうが学習コストが低い」と述べている
- `cmux browser` は失敗経路が一律 exit 1 なので（実測 T8）、`wait` のタイムアウトも
  非ゼロ終了になるとみてよい。アサーションを別途発明しなくても `wait` がそのまま
  アサーションとして機能する。ただし実際のタイムアウトは未検証であり、実機確認で確かめる
- ヘルパーライブラリを作ると cmux-browser（操作プリミティブの管轄）と責務が重なる

**ディレクトリ名を e2e-test と分ける理由**: `.e2e-scenarios/` と `.e2e-results/` は
e2e-test が既に使っている。同一 worktree で両方を使う可能性があり、混在するとどちらの
バックエンド向けのシナリオか判別できない。`.cmux-e2e-scenarios/` / `.cmux-e2e-results/` と
prefix を分けることで、並存という決定済み事項をディレクトリ構造の水準でも守る。

**シナリオ名の検証**: e2e-test と同じく単一トークンとし、`/` や `.` を含む場合は exit 2。

## 4.5 結果の集約と失敗条件

**決定**: `<worktree-root>/.cmux-e2e-results/<scenario>/` に集約する。
実行基盤が自動で集めるのは次の 4 つ。

| 成果物 | 取得元 | タイミング |
|--------|--------|-----------|
| `console.log` | `cmux browser --surface <s> console list` | シナリオ終了後（成否によらず） |
| `errors.log` | `cmux browser --surface <s> errors list` | シナリオ終了後（成否によらず） |
| `failure.png` | `cmux browser --surface <s> screenshot --out <path>` | シナリオが失敗したときのみ |
| `summary.md` | 実行基盤が生成 | 常に |

シナリオ自身が撮った screenshot / snapshot は同じディレクトリへ番号付きで置く（e2e-test の慣習）。

**`summary.md` の責務**: `run` が必ず生成する単一ファイルで、シナリオ名・開始終了時刻・
終了コード・失敗理由の区分・収集した成果物の一覧を書く。エージェントが読んで人間へ報告するための
入力であり、エージェントの考察を書く場所ではない。

**命名の注意**: dispatch の STATUS_DIR に置く `result.md`（タスク全体の結果報告）とは別物である。
混同を避けるため、シナリオ単位の要約は `summary.md` と呼ぶ。

**`report` サブコマンドを作らない**: 集約は `run` の一部であり、独立させると
「いつ誰が summary を書くのか」が二重定義になる。`run` が常に `summary.md` を書く形に畳む。

**trace を使わない根拠（実測 T6）**: `trace` / `screencast` / `viewport` / `network` /
`offline` / `geolocation` は WKWebView 実装のため `not_supported` を返す。RPC メソッドは存在するが
未実装である。要件定義の機能表には trace / screencast が載っているが、**実機では使えない**。
証跡は screenshot と snapshot に限定する。

**JS エラーを失敗とするか**: **既定で失敗とする**。無効化は `run --allow-js-errors` の
1 経路のみとし、環境変数では変えられないようにする。無効化手段を 2 つ用意すると、
どちらが効いているのか実行ログから追えなくなる。

根拠: E2E テストの目的は「画面が期待どおり動くこと」の確認であり、コンソールに例外が出ている
状態を成功と報告するのは誤報になる。一方、サードパーティスクリプトが恒常的にエラーを吐く
実プロジェクトは珍しくないため、逃げ道の無い強制は実用性を損なう。

**判定対象を 1 タブに限定する**: `errors list` はサーフェス単位であり、保持型サーフェスでは
別タブが出したエラーも混ざりうる。`run` は開始時に `tab list` を確認し、タブが 2 つ以上あれば
exit 1 として「`down` して `up` し直すか、余分なタブを閉じよ」と案内する。
シナリオが自分で開いたタブはシナリオが閉じる責任を持つ。

タブを実行基盤が自動で閉じない理由は、利用者が目視のために開いた画面を黙って消す動作になるためである。

**実行前に console / errors をクリアする**: サーフェスを使い回す設計なので、前回の実行で
出たエラーが残っていると次の実行を誤って失敗させる。シナリオ開始前に
`console clear` / `errors clear` を実行する。

**終了コードの優先順位**: 上から順に判定し、最初に該当したものを採用する。
どの理由で落ちたかは必ず標準エラーへ明示する。

1. サーフェス解決の失敗（状態 C）→ exit 1
2. シナリオの非ゼロ終了 → シナリオの終了コードをそのまま返す
3. JS エラー検出（`--allow-js-errors` 未指定）→ exit 1
4. 証跡の収集失敗 → exit 1。ただし 2 と 3 が先に成立していればそちらを優先し、
   収集失敗は `summary.md` と警告に残す（テストの合否を収集の失敗で塗り替えない）
5. すべて成功 → exit 0

## 5. サブコマンド構成

**決定**: 4 本。`install` と `report` は作らない。

| サブコマンド | 形 | 役割 |
|-------------|-----|------|
| `up` | `up [--profile <name>]` | サーフェスを確保する（状態 A/B なら作成、C なら中断）。ref を出力しレジストリへ記録 |
| `auth` | `auth <save\|load\|check\|list\|delete> <name> [--check-url <url>] [--check-selector <css>]` | 認証ステートの保存 / 読込 / 検証 / 一覧 / 削除 |
| `run` | `run <scenario> [--auth <name>] [--allow-js-errors]` | 環境変数とラッパーを組み立て、console/errors をクリアし、シナリオを実行し、結果を集約して合否を返す |
| `down` | `down [--sweep]` | サーフェスを破棄しレコードを消す。`--sweep` は worktree が消えた孤児を回収する |

**`install` を作らない根拠**: `cmux browser` は cmux 本体の機能であり、導入すべき依存が無い。
e2e-test の `install` は agent-browser を npm から入れるためだけに存在する。依存ゼロが
本プラグインの売りなので、何もしないサブコマンドを置くのは害になる。

**`report` を作らない根拠**: 4.5 のとおり、集約は `run` の一部として `summary.md` に畳む。
独立させると生成主体が二重定義になる。

**e2e-test との対応**:

| e2e-test | cmux-e2e | 差分の理由 |
|----------|----------|-----------|
| `install` | （無し） | 依存が無い |
| `run <scenario>` | `run <scenario> [--auth <name>] [--allow-js-errors]` | 認証の指定と JS エラーの扱いを追加 |
| `snapshot [url]` | （無し） | 単発のブラウザ操作は cmux-browser の管轄。重複させない |
| `teardown` | `down [--sweep]` | サーフェス破棄という実体に名前を寄せ、孤児回収を足した |
| （無し） | `up` | 保持型ライフサイクルに必要 |
| （無し） | `auth` | 本プラグインの中核 |

## 5.1 CLI 呼び出しの規約（実測トラップへの対処）

cmux-browser スキルはこれらを一切警告していない。スクリプトが必ず守る規約として明文化する。

| 規約 | 理由（実測） |
|------|-------------|
| 常に `--surface <ref>` をフラグ形式で渡す | 第 1 位置引数は無条件に surface として食われる。`cmux browser console list` は `list` を subcommand と誤認して失敗する |
| セレクタ・テキスト・キーもフラグ形式（`--selector` / `--text` / `--key`）で渡す | 位置引数との二重化があり、位置引数形式は曖昧さを持ち込む |
| 使用前に `--json` の `surface_ref` が要求と一致することを検証する | 要求と異なる surface に解決される事例を 8 件観測した |
| 成否は exit code で分岐する。stderr を JSON として解析しない | `--json` はエラー出力に適用されず、stderr は常に `Error: <message>` の平文 |
| `wait` のタイムアウトは `--timeout-ms` に統一する | `--timeout <seconds>` も受け付けるため、混在すると 1000 倍の取り違えが起きる |
| `import` を無引数で呼ばない | 実測で 3808 件の cookie をデフォルトプロファイルへ取り込んだ。既定が非対話・破壊的 |

## 6. シナリオ規約

置き場は `<worktree-root>/.cmux-e2e-scenarios/<name>.sh`。名前は単一トークンとし、
`/` や `.` を含む場合は exit 2（e2e-test と同じ）。

シナリオへ渡す契約（これがすべて）:

| 変数 / 経路 | 内容 |
|------------|------|
| `cmux-e2e-browser` | `PATH` の先頭に置かれる identity guard ラッパー。`cmux browser --surface <ref>` と等価だが、毎回 `surface_ref` の一致を確認する |
| `CMUX_E2E_SURFACE` | 操作対象のサーフェス ref（ラッパーを使わず読み取り系を直接叩きたい場合のため） |
| `CMUX_E2E_SESSION` | session key（4.2） |
| `CMUX_E2E_PROJECT` | project key（4.2） |
| `RESULTS_DIR` | `<worktree-root>/.cmux-e2e-results/<scenario>/`（自動で mkdir -p） |
| `WORKTREE_ROOT` | git toplevel |
| `.env.dispatch` の全キー | 存在する場合のみ（`PROJECT` / `SLOT` / `*_PORT` など） |

合否はシナリオの終了ステータス（`set -euo pipefail` 前提）。アサーションヘルパーは提供しない。
`wait` がタイムアウトで非ゼロ終了することがそのままアサーションとして機能する。

テンプレート:

```bash
#!/usr/bin/env bash
set -euo pipefail

cmux-e2e-browser goto "http://localhost:$VITE_PORT/login"
cmux-e2e-browser wait --load-state complete --timeout-ms 10000
cmux-e2e-browser snapshot --interactive > "$RESULTS_DIR/01-login.txt"
cmux-e2e-browser fill --selector "#email" --text "test@example.com"
cmux-e2e-browser click --selector "button[type=submit]"
cmux-e2e-browser wait --url-contains "/dashboard" --timeout-ms 10000
cmux-e2e-browser screenshot --out "$RESULTS_DIR/02-dashboard.png"
```

gitignore へ追加すべき行（消費側プロジェクトの責任として文書化する）:

```
.cmux-e2e-scenarios/
.cmux-e2e-results/
```

**ヘルパーライブラリを提供しない方針との関係**: `cmux-e2e-browser` はアサーションでも
テスト記述の DSL でもなく、実行基盤が identity を保証するためのラッパーである。
操作の作法（snapshot → ref → 操作 → wait）は cmux-browser の管轄であり、ここでは説明しない。

## 7. 失敗モード表

| 状況 | 挙動 |
|------|------|
| cmux CLI が見つからない | exit 1。cmux 内で実行しているか確認するよう案内 |
| レコードが無い（`up` 未実行）で `run` | exit 1。`up` を先に実行するよう案内 |
| ref が消滅、または browser ではない（状態 B）で `up` | 作り直して記録を更新（exit 0） |
| ref が消滅、または browser ではない（状態 B）で `run` | exit 1。`up` を促す |
| ref が生きている別 surface に解決される（状態 C） | exit 1。別の画面を操作しないために中断する |
| project key を解決できない、または `^[A-Za-z0-9._-]+$` に反する | exit 1。`.dev-up.yaml` へ明示するよう案内 |
| シナリオ名または auth 名に `/` `.` などが含まれる | exit 2 |
| シナリオファイルが存在しない | exit 1。解決後の絶対パスを示す |
| `.env.dispatch` が無い | 続行する。ポート変数が無いことを警告に出すのみ |
| 開始時にタブが 2 つ以上ある | exit 1。`down` して `up` し直すか余分なタブを閉じるよう案内 |
| `--auth <name>` の state が存在しない | exit 1。`auth save <name>` で作成するよう案内 |
| 認証ステートが失効している | exit 1。ログインし直して保存し直す手順を示す |
| meta に検証条件が無い | 検証せず続行し、検証していない旨を警告に出す |
| auth の保存先を作成 / 書き込みできない | exit 1。パスと必要な権限を示す |
| 保存先の経路に symlink がある | exit 1。cache root の外へ書かないために中断する |
| 結果ディレクトリを作成できない | exit 1。パスを示す |
| シナリオが非ゼロ終了 | 失敗。シナリオの終了コードを返し、console/errors を集約して failure.png を撮る |
| シナリオは成功したが JS エラーを検出 | exit 1。JS エラーが理由であることを明示 |
| 証跡の収集に失敗 | 単独なら exit 1。シナリオ失敗や JS エラーが先に成立していればそちらを優先し、収集失敗は警告と `summary.md` に残す |
| `down` でレコードが無い / surface が既に無い | exit 0（冪等） |
| `down --sweep` で worktree が消えた孤児を検出 | 対応する surface を閉じてレコードを消す（exit 0） |
| `snapshot --interactive` が `js_error` | cmux-browser の案内どおり `get text body` へフォールバックするようシナリオ側で対処 |

## 8. リポジトリ統合

### ファイルレイアウト

```
apps/cmux-e2e/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── CLAUDE.md
├── LICENSE
├── README.md
├── test/test-*.sh
└── skills/cmux-e2e/
    ├── SKILL.md
    ├── references/guide-ja.md
    └── scripts/*.sh
```

`test/` はスタブ `cmux` を使った分岐テスト（9 章）を置く。`apps/cmux-team-dispatch-task/test/`
と同じ配置である。turbo には test タスクが無いため、実行は手動または plan の検証手順で行う。

`package.json` は作らない。bash のみのプラグイン 7 件はいずれも持っておらず、
`pnpm-workspace.yaml` の `apps/*` glob は `package.json` の無いディレクトリを無視するため、
turbo の対象外となり `check` スクリプトも不要になる。

### repo 外で触るファイル

| ファイル | 必須 | 内容 |
|---------|------|------|
| ルート `.claude-plugin/marketplace.json` | 必須 | `plugins` 配列の末尾へ 7 キーのエントリを追加 |
| ルート `install.sh` | 必須 | `claude plugin install cmux-e2e@yui-cc-plugins` を列挙へ追加 |
| ルート `README.md` | 慣習 | install スニペットと Plugins 表 |
| ルート `CLAUDE.md` | 慣習 | Apps 表 |
| `.agents/plugins/marketplace.json` | 任意 | codex カタログ。9 中 3 件しか載っておらず必須ではない |

marketplace.json / plugin.json（claude）/ plugin.json（codex）の 3 箇所で version を一致させる。
これを検証する仕組みはリポジトリに無いため、手順として明記する。

### 言語規約への適合

- `skills/cmux-e2e/SKILL.md` は frontmatter を除き日本語を含めない
- frontmatter の `description` のみ日本語可（起動トリガー語のため）
- `## Output Language` ブロックは frontmatter 直後・H1 より前に置き、本文 3 行を逐語一致させる
- `skills/cmux-e2e/references/guide-ja.md` を必ず用意する（H1 が先、`## Output Language` が後）
- `CLAUDE.md` / `README.md` は日本語（`check-doc-lang` の対象外）

## 9. 検証手順（完了条件）

### 静的検証

| # | 検証 | コマンド / 手段 |
|---|------|----------------|
| 1 | レイアウトが規約どおり | ファイル存在確認 |
| 2 | version が 3 箇所で一致 | 3 ファイルの version を突き合わせ |
| 3 | 全スクリプトが構文エラー無し | `bash -n` を全 `*.sh` に適用 |
| 4 | shellcheck の主要指摘が無い | `shellcheck` があれば実行（リポジトリには未導入） |
| 5 | 言語規約 | `node scripts/check-doc-lang.mjs apps/cmux-e2e` |
| 6 | 全体 | `pnpm install && pnpm check`（この worktree は node_modules 未導入） |
| 7 | e2e-test に差分が無い | `git status --short apps/e2e-test` と `git diff -- apps/e2e-test` が空 |

### スタブによる分岐テスト

`bash -n` と shellcheck は分岐・終了コード・後始末のバグを検出しない。設計の中核は
そこにあるため、`cmux` を置き換えるスタブを `PATH` に置いて挙動を確認するテストを
`apps/cmux-e2e/test/test-*.sh` に置く（リポジトリの既存慣習と同じ配置）。

| # | 確認内容 |
|---|---------|
| T1 | 状態 A（レコード無し）で `run` が exit 1、`up` が作成する |
| T2 | 状態 B（ref 消滅）で `up` が作り直す |
| T3 | 状態 C（別の生きた surface へ解決）で `up` と `run` の両方が exit 1 |
| T4 | 2 つの worktree を模して同時に実行しても互いのレコードを壊さない |
| T5 | `--auth` 未指定なら認証を一切扱わない |
| T6 | `--auth` 指定で state 不在なら exit 1 |
| T7 | `auth check` が成功 / 失効 / 検証条件未設定の 3 経路で正しく分岐する |
| T8 | auth 名に `../` を与えると exit 2 で拒否される |
| T9 | 保存された state のパーミッションが `0600`、ディレクトリが `0700` |
| T10 | シナリオ失敗と JS エラー検出が同時に起きたとき、シナリオの終了コードが優先される |
| T11 | `--allow-js-errors` で JS エラーが合否に影響しない |
| T12 | 証跡収集の失敗がシナリオの合否を塗り替えない |
| T13 | 開始時にタブが 2 つ以上あれば exit 1 |
| T14 | `down` を 2 回続けて実行しても exit 0（冪等） |
| T15 | `down --sweep` が worktree 消滅済みのレコードだけを回収する |
| T16 | どの経路からも `cmux browser ... import` を呼ばない（スタブが呼び出しを記録して検証） |

### 実機確認（必須）

ドキュメントとスタブだけで完成としない。実際の `cmux browser` に対して次を通し、
出力を証跡として dispatch の `result.md` に残す。

| # | 確認内容 |
|---|---------|
| E1 | 公開ページを開いて snapshot → click → wait → screenshot → `state save` → `state load` が通る |
| E2 | `wait` がタイムアウトしたときの終了コードを実測する（R3） |
| E3 | ブラウザサーフェスが 2 つ存在する状態で ref 指定が正確に解決されるかを実測する（R2） |
| E4 | `up` → `run` → `down` を通し、`down` 後に surface が実際に閉じている |

## 10. 未決事項とリスク

| # | 事項 | 扱い |
|---|------|------|
| R1 | `browser open` が `--json` で返す surface ref の形は文書化されているが未検証 | 実機確認 E1 で確かめる。返り値が使えない場合は `cmux --json list-pane-surfaces` から拾う |
| R2 | 要求 ref と異なる surface に解決される事象が、ブラウザサーフェス不在時のフォールバックなのか常時の挙動なのか未確定 | 安全側に倒して「不一致なら中断」+ identity guard ラッパーで設計済み。実機確認 E3 で 2 つ以上のブラウザサーフェスを作って再測定し、常時ではないと確認できれば guard の既定を緩める |
| R3 | `wait` のタイムアウト時の終了コードが未検証 | 実機確認 E2 で確かめる。非ゼロでなければ合否判定の設計を見直す |
| R4 | `screenshot` の `--out` 省略時に base64 が stdout へ出るという記述が cmux-browser スキル由来で未検証 | 実行基盤は常に `--out` を付けるため影響しない |
| R5 | `.env.dispatch` を必須にしないため、ポート変数を前提にしたシナリオは dev-up 未導入プロジェクトで動かない | シナリオ側の責任として文書化する。実行基盤は警告を出すのみ |
| R6 | identity guard ラッパーは CLI 呼び出しを 2 倍にする | `CMUX_E2E_NO_GUARD=1` で無効化できる。R2 の実測結果しだいで既定を見直す |
| R7 | project key の解決順 ② が git remote に依存するため、remote 名を変えると認証ステートの置き場所が変わる | `.dev-up.yaml` の `project` を書けば ① が優先される。SKILL.md の失敗モードに記載する |
