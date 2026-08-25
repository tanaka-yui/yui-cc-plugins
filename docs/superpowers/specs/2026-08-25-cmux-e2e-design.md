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
scripts/*.sh          … CLI 入口。サーフェス確保・環境変数の組み立て・シナリオ起動・結果集約
skills/cmux-e2e/SKILL.md … エージェント向けの手順書。どのサブコマンドをいつ使うか
.cmux-e2e-scenarios/*.sh  … 検証したい UI フロー。プロジェクト側が書く（プラグインは同梱しない）
```

データフロー:

```
dev-up の .env.dispatch（あれば）
        │  PROJECT / SLOT / *_PORT
        ▼
surface 確保（保持型・ref をファイルへ永続化）
        │  CMUX_E2E_SURFACE
        ▼
認証ステート適用（state load）
        │
        ▼
シナリオ実行（bash。cmux browser を自由に呼ぶ）
        │
        ▼
結果集約（screenshot / console / errors）→ 合否判定
```

## 4. 設計判断

要件定義の「設計で詰めるべき論点」6 項目に 1:1 で対応する。

## 4.1 サーフェスのライフサイクル

**決定**: worktree ごとに 1 サーフェスを保持して使い回す（保持型）。ref は
`<worktree-root>/.cmux-e2e-results/.surface` に永続化する。使う前に必ず
**「要求した ref が実際に応答しているか」まで検証**し、一致しなければ作り直す。
破棄は `down` サブコマンドでのみ行う。

**根拠**:

- 本タスクの中核は認証である。ログイン済みの状態はサーフェスとプロファイルに紐づくため、
  シナリオごとに開いて閉じると毎回ログインし直すことになり、要件そのものを壊す
- surface identity は move / reorder をまたいで安定（`~/.agents/skills/cmux/references/panes-surfaces.md`）。
  ファイルへ永続化して次回も使う設計が成立する
- 目視できることが `cmux browser` を選ぶ理由そのものなので、シナリオ終了時に自動で閉じるのは
  この手段の利点を捨てることになる

**生存確認を「存在するか」で終わらせない根拠（実測 T3 / T4）**:

- 存在しない ref を渡してもエラーにならない。`--surface surface:9999` は
  `Surface is not a browser` を返した。これは「9999 は存在しないので別の何かに解決された」ことを意味する
- さらに、要求した ref とは異なる surface に解決される事例を 8 件観測した
  （surface:5 を要求して surface:14 が返るなど）。規則は
  「ref → その workspace → その workspace のフォーカス中ペインの選択サーフェス」に見える。
  ただし測定時にブラウザサーフェスが 1 つも存在しなかったため、ブラウザサーフェス不在時の
  フォールバックである可能性が残る
- どちらであれ、**要求した ref に操作が届いた保証が無い**。したがって検証は
  `cmux --json browser --surface <ref> identify` 等で返る `surface_ref` が要求と一致することまで行う。
  一致しなければ「サーフェスを解決できない」として失敗させ、暗黙に別の画面を操作しない

**破棄の経路**: `browser close|quit|kill|destroy` は存在しない（`Unsupported browser subcommand`）。
teardown は `cmux close-surface --surface <ref>` を使う。

**却下案**: シナリオごとに open して閉じる。認証状態が毎回失われるうえ、失敗時に画面が残らず、
「実際に画面を見ながら原因を追う」という採用理由が消える。

## 4.2 worktree 並列時の分離

**決定**: 分離キーは dev-up と同じ `<project>-<slot>` を第一候補とし、`.env.dispatch` が
無い場合は worktree ディレクトリ名へフォールバックする。分離は「サーフェスを分ける」ことで
成立させ、ブラウザプロファイルの分離は認証ステートを共有したいかどうかで選ばせる。

**根拠**:

- `.env.dispatch` は `PROJECT` と `SLOT` を固定キーとして必ず持ち、e2e-test も
  `AGENT_BROWSER_SESSION="$PROJECT-$SLOT"` の 1 行だけで分離を成立させている。同じ規約に
  揃えるのが学習コスト最小
- ただし **このリポジトリには `.dev-up.yaml` も `.env.dispatch` も存在しない**。dev-up を
  導入していないプロジェクトでも cmux-e2e を使えなければ、要件定義の完了条件
  （公開ページに対する実機確認）自体が満たせない。したがって `.env.dispatch` を必須にはできない
- 一方 dev-up の main worktree はそもそも slot を持たない設計であり、`.env.dispatch` 不在は
  異常ではなく正常系のひとつである
- surface identity は move / reorder をまたいで安定（cmux の panes-surfaces リファレンス）。
  worktree ごとに surface ref を 1 つ持てば衝突しない

**却下案**: プロファイルを常に worktree ごとに分ける。認証ステートまで worktree ごとに
分断されるため、「一度ログインしたら以降のシナリオで使い回す」という本タスクの中核要件と
衝突する。プロファイル分離は既定にせず、必要なときだけ選べるようにする。

## 4.3 認証状態の扱い（中核）

**前提の整理**: `state save` / `state load` の**使い方そのものは cmux-browser スキルが
既に全面的に文書化している**（`references/authentication.md` に基本ログイン・OAuth/SSO・2FA・
cookie 認証・トークン更新・「state ファイルをコミットしない」等のセキュリティ規則まで揃っている）。
したがって cmux-e2e は認証の**やり方**を再説明しない。cmux-e2e が持つのは運用の側、すなわち
**保存先の規約・プロジェクト単位の鍵付け・実行前の有効性検証・失敗時の報告**である。

**決定**:

1. 保存先を規約化する。`~/.cache/cc-skills/cmux-e2e/<project>/<name>.json`
2. `auth save <name>` / `auth load <name>` / `auth check <name>` の 3 操作を提供する
3. `auth check` は「ログイン済みでのみ現れる目印」を指定させ、`load` → 遷移 → `wait` で検証する
4. `run` は実行前に必ず 3 を通す。目印が未設定なら検証せずにその旨を警告する（黙って通さない）

**保存先を worktree の外に置く根拠**:

- worktree 内に置くと、worktree を捨てるたびに再ログインが必要になる。worktree は
  cmux-team-dispatch-task が使い捨てる前提の存在であり、認証だけは使い捨てたくない
- dev-up が slot レジストリを `~/.cache/cc-skills/dev-up/<project>/slots/` に置く前例がある。
  同じ `~/.cache/cc-skills/<plugin>/<project>/` 規約に揃える
- リポジトリの外に置けば、`.gitignore` への追加漏れがそのまま資格情報のコミット事故になる
  という経路が構造的に消える。cmux-browser のセキュリティ規則を仕組みで担保することになる

**失効検知**: `state load` は「ファイルを読めたか」しか判定できず、セッションが有効かは判定できない。
そこで `auth check` を実行基盤側の工程として持つ。失敗時は「ステートが失効している。
`auth save` で保存し直せ」と復旧手順付きで報告する。

**`import` の扱い — 実測による重大な注意**:

実測中に `cmux browser --surface surface:9999 import` が**実際に走り、Chrome から 3808 件の
cookie をデフォルトプロファイルへ取り込んだ**。surface 引数は無視される（プロファイル単位の
操作である）うえ、既定が非対話・デフォルトプロファイル宛てで、確認も無い。

したがって cmux-e2e は次を規約とする。

- 実行基盤は `import` を**自動では呼ばない**
- SKILL.md では必ず `--from <browser> --to-profile <name> --non-interactive` を明示した形でのみ提示し、
  無引数呼び出しが破壊的であることを警告として書く
- SSO 済みセッションの持ち込みは有用なので導線としては残すが、実行するのは人間かエージェントの
  明示的な判断とする

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
実行基盤が自動で集めるのは次の 3 つ。

| 成果物 | 取得元 | タイミング |
|--------|--------|-----------|
| `console.log` | `cmux browser --surface <s> console list` | シナリオ終了後（成否によらず） |
| `errors.log` | `cmux browser --surface <s> errors list` | シナリオ終了後（成否によらず） |
| `failure.png` | `cmux browser --surface <s> screenshot --out <path>` | シナリオが失敗したときのみ |

シナリオ自身が撮った screenshot / snapshot は同じディレクトリへ番号付きで置く（e2e-test の慣習）。
`report.md` はエージェントが書く。雛形は提供しない（e2e-test も提供していない）。

**trace を使わない根拠（実測 T6）**: `trace` / `screencast` / `viewport` / `network` /
`offline` / `geolocation` は WKWebView 実装のため `not_supported` を返す。RPC メソッドは存在するが
未実装である。要件定義の機能表には trace / screencast が載っているが、**実機では使えない**。
証跡は screenshot と snapshot に限定する。ネットワークモックや viewport エミュレーションを
前提にした設計も同様に成立しない。

**JS エラーを失敗とするか**: **既定で失敗とする**。ただしシナリオ側で無効化できる。

根拠: E2E テストの目的は「画面が期待どおり動くこと」の確認であり、コンソールに例外が出ている
状態を成功と報告するのは誤報になる。一方、サードパーティスクリプトが恒常的にエラーを吐く
実プロジェクトは珍しくないため、逃げ道の無い強制は実用性を損なう。既定は厳しく、明示的に
緩められる形にする。

**実行前に console / errors をクリアする**: サーフェスを使い回す設計なので、前回の実行で
出たエラーが残っていると次の実行を誤って失敗させる。シナリオ開始前に
`console clear` / `errors clear` を実行する。

**終了コード**: シナリオの exit status を優先し、シナリオが成功していて JS エラー検出で
失敗にする場合のみ実行基盤が非ゼロを返す。どちらの理由で落ちたかを標準エラーへ明示する。

## 5. サブコマンド構成

**決定**: 5 本。`install` は作らない。

| サブコマンド | 役割 |
|-------------|------|
| `up` | サーフェスを確保する（永続化 ref が生きて一致すれば再利用、無ければ作成）。ref を出力 |
| `auth <save\|load\|check> <name>` | 認証ステートの保存 / 読込 / 有効性検証 |
| `run <scenario>` | 環境変数を組み立て、console/errors をクリアし、シナリオを実行し、結果を集約して合否を返す |
| `report <scenario>` | 集約済みの結果を読める形にまとめる |
| `down` | `cmux close-surface` でサーフェスを破棄し、永続化 ref を消す |

**`install` を作らない根拠**: `cmux browser` は cmux 本体の機能であり、導入すべき依存が無い。
e2e-test の `install` は agent-browser を npm から入れるためだけに存在する。依存ゼロが
本プラグインの売りなので、何もしないサブコマンドを置くのは害になる。

**e2e-test との対応**:

| e2e-test | cmux-e2e | 差分の理由 |
|----------|----------|-----------|
| `install` | （無し） | 依存が無い |
| `run <scenario>` | `run <scenario>` | 同じ |
| `snapshot [url]` | （無し） | 単発のブラウザ操作は cmux-browser の管轄。重複させない |
| `teardown` | `down` | サーフェス破棄という実体に名前を寄せた |
| （無し） | `up` | 保持型ライフサイクルに必要 |
| （無し） | `auth` | 本プラグインの中核 |
| （無し） | `report <scenario>` | 結果集約を明示的な工程にした |

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

シナリオへ渡す環境変数（これが契約のすべて）:

| 変数 | 内容 |
|------|------|
| `CMUX_E2E_SURFACE` | 操作対象のサーフェス ref |
| `CMUX_E2E_SESSION` | 分離キー（`<project>-<slot>` または worktree 名） |
| `RESULTS_DIR` | `<worktree-root>/.cmux-e2e-results/<scenario>/`（自動で mkdir -p） |
| `WORKTREE_ROOT` | git toplevel |
| `.env.dispatch` の全キー | 存在する場合のみ（`PROJECT` / `SLOT` / `*_PORT` など） |

テンプレート:

```bash
#!/usr/bin/env bash
set -euo pipefail

B=(cmux browser --surface "$CMUX_E2E_SURFACE")

"${B[@]}" goto "http://localhost:$VITE_PORT/login"
"${B[@]}" wait --load-state complete --timeout-ms 10000
"${B[@]}" snapshot --interactive > "$RESULTS_DIR/01-login.txt"
"${B[@]}" fill --selector "#email" --text "test@example.com"
"${B[@]}" click --selector "button[type=submit]"
"${B[@]}" wait --url-contains "/dashboard" --timeout-ms 10000
"${B[@]}" screenshot --out "$RESULTS_DIR/02-dashboard.png"
```

gitignore へ追加すべき行（消費側プロジェクトの責任として文書化する）:

```
.cmux-e2e-scenarios/
.cmux-e2e-results/
```

## 7. 失敗モード表

| 状況 | 挙動 |
|------|------|
| cmux CLI が見つからない | exit 1。cmux 内で実行しているか確認するよう案内 |
| サーフェスが確保されていない（`up` 未実行） | exit 1。`up` を先に実行するよう案内 |
| 永続化 ref が指すサーフェスが消えている | 警告のうえ自動で作り直す（exit 0） |
| 要求 ref と応答 `surface_ref` が一致しない | exit 1。別の画面を操作しないために中断する |
| シナリオ名に `/` または `.` が含まれる | exit 2 |
| シナリオファイルが存在しない | exit 1。解決後の絶対パスを示す |
| `.env.dispatch` が無い | 続行する。ポート変数が無いことを警告に出すのみ |
| 認証ステートファイルが存在しない | exit 1。`auth save <name>` で作成するよう案内 |
| 認証ステートが失効している | exit 1。ログインし直して保存し直す手順を示す |
| `auth check` の目印が未設定 | 検証せず続行し、検証していない旨を警告に出す |
| シナリオが非ゼロ終了 | 失敗。console/errors を集約し failure.png を撮る |
| シナリオは成功したが JS エラーを検出 | 失敗。JS エラーが理由であることを明示 |
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
└── skills/cmux-e2e/
    ├── SKILL.md
    ├── references/guide-ja.md
    └── scripts/*.sh
```

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

| # | 検証 | コマンド / 手段 |
|---|------|----------------|
| 1 | レイアウトが規約どおり | ファイル存在確認 |
| 2 | version が 3 箇所で一致 | 3 ファイルの version を突き合わせ |
| 3 | 全スクリプトが構文エラー無し | `bash -n` を全 `*.sh` に適用 |
| 4 | shellcheck の主要指摘が無い | `shellcheck` があれば実行（リポジトリには未導入） |
| 5 | 言語規約 | `node scripts/check-doc-lang.mjs apps/cmux-e2e` |
| 6 | 全体 | `pnpm install && pnpm check`（この worktree は node_modules 未導入） |
| 7 | **実機確認** | `cmux browser` で公開ページを開き snapshot → click → wait → screenshot → `state save` → `state load` を通し、出力を result.md に証跡として残す |
| 8 | e2e-test に差分が無い | `git status --short apps/e2e-test` と `git diff -- apps/e2e-test` が空 |

7 は必須。ドキュメントだけ書いて完成としない。

## 10. 未決事項とリスク

| # | 事項 | 扱い |
|---|------|------|
| R1 | `browser open` が `--json` で返す surface ref の形は文書化されているが未検証 | 実機確認（完了条件 7）で確かめる。返り値が使えない場合は `cmux --json list-pane-surfaces` から拾う |
| R2 | 要求 ref と異なる surface に解決される事象が、ブラウザサーフェス不在時のフォールバックなのか常時の挙動なのか未確定 | どちらでも安全side に倒れるよう「一致検証して不一致なら中断」で設計済み。実機確認で 2 つ以上のブラウザサーフェスを作って再測定する |
| R3 | `wait` のタイムアウト時の終了コードが未検証 | 実機確認で確かめる。非ゼロでなければ合否判定の設計を見直す |
| R4 | `screenshot` の `--out` 省略時に base64 が stdout へ出るという記述が cmux-browser スキル由来で未検証 | 実行基盤は常に `--out` を付けるため影響しない |
| R5 | `.env.dispatch` を必須にしないため、ポート変数を前提にしたシナリオは dev-up 未導入プロジェクトで動かない | シナリオ側の責任として文書化する。実行基盤は警告を出すのみ |
