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
| `~/.cache/cc-skills/cmux-e2e/<project>/surfaces/` | サーフェスレジストリとロック（4.0） | 消えると孤児が出る。消してはならない |
| `~/.cache/cc-skills/cmux-e2e/<project>/auth/` | 認証ステート・検証条件・ロック（4.0） | 消すと再ログインが必要 |
| `<worktree>/.cmux-e2e-scenarios/` | シナリオ | プロジェクト側の資産 |
| `<worktree>/.cmux-e2e-results/` | 成果物 | いつ消してもよい |

データフロー:

```
project key 解決（.dev-up.yaml の project → git common dir の名前 + hash 16 桁）
        │
        ▼
ロック取得（worktree → auth の順。--auth 指定時のみ auth も取る）
        │
        ▼
surface 解決（レジストリの surface_id を tree --all と突き合わせ、現在の ref を採る）
        │  CMUX_E2E_SURFACE + identity guard ラッパー
        ▼
認証（--auth 指定時のみ。locked core: digest 照合 → state load 1 回 → 条件があれば検証）
        │
        ▼
タブ数の確認（load 後に 1 つであること）→ console / errors clear
        │
        ▼
シナリオ実行（bash。cmux-e2e-browser 経由で操作）
        │
        ▼
結果集約（screenshot / console / errors）→ summary.md → 合否判定 → ロック解放
```

## 4. 設計判断

要件定義の「設計で詰めるべき論点」6 項目に 1:1 で対応する。

## 4.0 cache root のレイアウト

名前が衝突しうる要素を同じ親に並べない。auth 名は名前中の `.` を許すため、
`<name>.lock` や `<name>.meta.json` のように**接尾辞で種別を表すと必ず衝突する**
（auth `foo` の lock と auth `foo.lock` の実体が同じパスになる）。
種別は接尾辞ではなく**固定のディレクトリ名**で表す。

```
~/.cache/cc-skills/cmux-e2e/<project>/
├── auth/
│   ├── entries/<name>/state.json      ← cmux が書く storageState 本体
│   ├── entries/<name>/meta.json       ← cmux-e2e が書く付帯情報
│   ├── locks/<name>/owner.json        ← auth ロック
│   └── locks-quarantine/<name>.<gen>/ ← 回収した stale ロックの隔離先
└── surfaces/
    ├── entries/<worktree-key>.json    ← サーフェスレジストリ
    ├── locks/<worktree-key>/owner.json
    └── locks-quarantine/<worktree-key>.<gen>/
```

`entries` / `locks` / `locks-quarantine` は固定名なので、
`<name>` がどんな値でも別の種別と衝突しない。

**すべてのディレクトリを `0700`、すべてのファイルを `0600`** で作成する。
`entries/` の state と meta だけでなく、レジストリ・ロックディレクトリ・`owner.json` も対象である。

**`auth list` が列挙する対象**: `auth/entries/<name>/` のうち、`state.json` と `meta.json` の
**両方が揃っているもの**だけ。作りかけの一時ファイルを含むディレクトリ、`locks/`、
`locks-quarantine/` は列挙しない。種別が別ディレクトリなので、
そもそも `locks` 配下が `auth/entries` の列挙に混ざることはない。

## 4.1 サーフェスのライフサイクル

**決定**: worktree ごとに 1 サーフェスを保持して使い回す（保持型）。破棄は `down` でのみ行う。

**レジストリ**: `~/.cache/cc-skills/cmux-e2e/<project>/surfaces/entries/<worktree-key>.json`（4.0）

| フィールド | 内容 |
|-----------|------|
| `surface_id` | サーフェスの UUID。**これが主キー**である |
| `surface_ref` | 直近に観測した短 ref。表示用のキャッシュにすぎない |
| `worktree` | worktree の canonical realpath |
| `created_at` | 作成時刻 |

`<worktree-key>` は **worktree の canonical realpath の SHA-256 先頭 16 桁**とする。
レジストリの作成・読み取り・更新・削除と `down --sweep` は `surfaces/entries/` だけを対象とし、
`locks/` や `locks-quarantine/` を走査しない。
basename では同名 worktree が衝突し、session key では slot が変わると以前のレコードを見失う。

短 ref ではなく UUID を主キーにする根拠: surface は pane / workspace / window 間を移動でき、
移動しても identity は保たれる。短 ref は表示上の番号であり、レジストリの同一性判定に使うと
移動を追跡できない。

**パスの保護**: `surfaces/` にも `auth/` と同じ規則を適用する。すなわち解決後の絶対パスが
固定 cache root 配下にあることを再確認し、経路上に symlink があれば拒否し、書き込みは
一時ファイル + `mv` で置き換え、ディレクトリは `0700`、ファイルは `0600` とする。

**孤児の回収**: worktree ごと消された場合はレコードだけが残る。`down --sweep` は
`worktree` が実在しないレコードを走査し、対応する surface を閉じてレコードを消す。
dev-up の `reserve-slot.sh` が Phase 1 で行う zombie sweep と同じ発想である。

**サーフェスの探索範囲**: `cmux --json --id-format both tree --all` を使う。

`list-pane-surfaces` は使わない。`--pane` を省略すると**フォーカス中の pane しか列挙しない**
（実測: `{"pane_ref":"pane:28","surfaces":[…1 件…]}`）。これで存在判定すると、
別 pane へ移動しただけの生きたサーフェスを「消滅した」と誤判定し、新しいサーフェスを
作って孤児を増やす。

`tree --all` は全 window → workspace → pane を走査し、各サーフェスについて
`id`（UUID）/ `ref` / `type` / `url` / `selected_in_pane` を返す（実測: 20 件を列挙）。
レジストリの `surface_id` と `id` を突き合わせれば、移動後も追跡できる。

**UUID に一致した後に使う ref**: `tree --all` で `surface_id` に一致したノードの
**現在の `ref`** を、以後の `identify` / `cmux browser --surface` / `close-surface` すべてに使う。
レジストリの `surface_ref` キャッシュもこの値へ更新する。

レジストリに保存された古い `surface_ref` を使ってはならない。サーフェスが移動すると
短 ref は変わりうるため、古い ref で `identify` すると UUID で正しく発見したサーフェスを
状態 C と誤判定し、`down` が別のサーフェスを閉じようとする。

したがって状態 C の判定は「`identify` の `surface_ref`」対「`tree --all` で得た現在の `ref`」の
比較である。レジストリの値との比較ではない。

**サーフェス解決の状態遷移**: 3 状態を区別し、状態ごとに `up` と `run` の挙動を固定する。

| 状態 | 判定方法 | `up` の挙動 | `run` の挙動 |
|------|---------|------------|-------------|
| A. レコードが無い | ファイル不在 | 新規作成して記録 | exit 1（`up` を促す） |
| B. `surface_id` が `tree --all` に無い | UUID 不一致 | 作り直して記録を更新 | exit 1（`up` を促す） |
| B'. `surface_id` はあるが `type` が browser でない | UUID 一致・type 不一致 | **中断（exit 1）** | **中断（exit 1）** |
| C. `identify` の `surface_ref` が要求と不一致 | 応答不一致 | **中断（exit 1）** | **中断（exit 1）** |

B と B' を分ける根拠: 前者は対象が消えているので作り直してよいが、後者は UUID が生きたまま
別種のサーフェスになっている（通常は起こりえない）状態であり、作り直すと元の何かを
放置したまま増やすことになる。異常として中断する。

C を作り直しにしないのは、他人の画面を操作しうる状態でサーフェスを増やすと、
どちらが自分のものか判別できなくなるためである。

**検証後レースの扱い — 保証ではなく best-effort である**:

上の検証は `run` 開始時点のものでしかない。シナリオ実行中に対象サーフェスが閉じられると、
以降の `cmux browser --surface` は実測 T4 のフォールバックにより別画面へ届きうる。
UUID を渡しても回避できない（UUID 指定でも別サーフェスが返った）。

対処として `run` は一時ディレクトリに実行可能な `cmux-e2e-browser` を作り `PATH` の先頭へ置く。
このラッパーは毎回 `identify` で一致を確認してから本来のコマンドを実行する。

**ただしこれは identity の保証ではない**。`identify` と本コマンドは別々の CLI 呼び出しであり、
その間にサーフェスが閉じられれば本コマンド側でフォールバックが起きる余地は残る。
ラッパーが縮めるのは窓であって、閉じるものではない。cmux が「対象解決と操作を 1 RPC で
fail-close する」手段を提供するまで、この残余レースは仕様上の既知の穴として明記する。

残余レースを実務上許容できる水準まで下げるため、次を併せて行う。

- サーフェスを触る操作（`up` / `run` / `down` / `auth save|load|check`）を worktree ロックで直列化する（4.4）
- 実行中に対象サーフェスを手で閉じることを禁止事項として SKILL.md に書く
- ラッパーの無効化は**明示的な CLI フラグ `run --no-guard`** でのみ行う。環境変数では変えられない。無効化した事実は `summary.md` に必ず記録する

環境変数で無効化できるようにしない根拠: `.env.dispatch` や親シェルから意図せず安全性が変わり、
実行結果からどちらで走ったのか判別できなくなる。

**破棄の経路**: `browser close|quit|kill|destroy` は存在しない（`Unsupported browser subcommand`）。
teardown は `cmux close-surface --surface <ref>` を使う。`down` は冪等とし、
レコードが無い場合もサーフェスが既に無い場合も exit 0 で終わる。

**根拠（保持型を選ぶ理由）**:

- 本タスクの中核は認証である。ログイン済みの状態はサーフェスとプロファイルに紐づくため、
  シナリオごとに開いて閉じると毎回ログインし直すことになり、要件そのものを壊す
- 目視できることが `cmux browser` を選ぶ理由そのものなので、シナリオ終了時に自動で閉じるのは
  この手段の利点を捨てることになる

**却下案**: シナリオごとに open して閉じる。認証状態が毎回失われるうえ、失敗時に画面が残らず、
「実際に画面を見ながら原因を追う」という採用理由が消える。

## 4.2 worktree 並列時の分離

**決定**: 鍵を 2 種類に分ける。混ぜてはならない。

| 鍵 | 用途 | 解決 | worktree ごとに変わるか |
|----|------|------|----------------------|
| project key | 認証ステートとサーフェスレジストリの置き場所 | ① `.dev-up.yaml` の `project` があればそれ ② 無ければ `<git common dir の親ディレクトリ名>-<realpath(git common dir) の SHA-256 先頭 16 桁>` | **変わらない** |
| session key | 同時実行の識別（ログ表示・診断） | `.env.dispatch` があれば `<PROJECT>-<SLOT>`、無ければ worktree ディレクトリ名 | 変わる |

**git remote の basename を使わない根拠**: `git@github.com:org-a/admin.git` と
`git@gitlab.example:org-b/admin.git` はどちらも `admin` になる。無関係なリポジトリが
同じ project key を共有すると、片方から他方の認証ステートを `auth list` / `auth load` /
`auth delete` でき、同じサーフェスレジストリに対して `down --sweep` まで実行できてしまう。
複数 remote があるときにどれを選ぶかも決められない。

**ハッシュ長を 16 桁にする根拠**: 8 hex は 32 bit しかなく、同じ表示名を持つクローン群が
約 9,300 個あれば偶発衝突の確率が 1% に達する。この衝突は単なるキャッシュミスではなく、
別クローン間で `auth list` / `load` / `delete` と `down --sweep` が混線することを意味する。
`<worktree-key>` が 16 桁である以上、こちらを弱くする利点も無い。

**git common dir を使う根拠**: worktree から見てもメインチェックアウトが一意に定まり、
同一リポジトリの worktree 群だけが同じ project key を共有する。これは
「worktree をまたいで認証を使い回す」という要件そのものである。
agmsg の `agmsg_gitcommon_project` が同じ手法を採っている。

ハッシュを付ける理由は、別の場所にクローンした同名リポジトリと衝突させないためである。
先頭にディレクトリ名を残すのは、`~/.cache` を人が覗いたときに判別できるようにするため。

**クローン間で共有したい場合**: 別クローンでも同じ認証を使いたいなら、`.dev-up.yaml` に
`project` を明示する。これが解決順 ① を用意した理由であり、共有は暗黙ではなく宣言で行う。

**project key の検証**: 解決結果は次をすべて満たさなければならない。満たさなければ exit 1 とし、
`.dev-up.yaml` へ明示するよう促す。

- `^[A-Za-z0-9._-]+$` に一致する
- 空文字列でない
- `.` でも `..` でもない

`^[A-Za-z0-9._-]+$` は `.` と `..` を受理してしまうため、正規表現だけでは
「`..` をパス要素にしない」を担保できない。明示的に弾く。

**分離の実体**: サーフェスを worktree ごとに分けることで成立させる。ブラウザプロファイルの
分離は既定にしない。プロファイルを分けると認証ステートまで分断され、中核要件と衝突する。
プロファイルを分けたい場合は `up --profile <name>` で明示的に選ばせる。

**`.env.dispatch` を必須にしない根拠**:

- `.env.dispatch` は `PROJECT` と `SLOT` を固定キーとして持ち、e2e-test は
  `AGENT_BROWSER_SESSION="$PROJECT-$SLOT"` の 1 行だけで分離を成立させている
- ただし **このリポジトリには `.dev-up.yaml` も `.env.dispatch` も存在しない**。dev-up を
  導入していないプロジェクトで使えなければ、完了条件である実機確認自体が実行できない
- dev-up の main worktree はそもそも slot を持たない設計であり、`.env.dispatch` 不在は
  異常ではなく正常系のひとつである

## 4.3 認証状態の扱い（中核）

**前提の整理**: `state save` / `state load` の**使い方そのものは cmux-browser スキルが
既に全面的に文書化している**（`references/authentication.md` に基本ログイン・OAuth/SSO・2FA・
cookie 認証・トークン更新・セキュリティ規則まで揃っている）。cmux-e2e は認証の**やり方**を
再説明せず、cmux-browser の該当リファレンスへリンクする。cmux-e2e が持つのは運用の側、すなわち
**保存先の規約・鍵付け・入力契約・実行前の有効性検証・秘密情報の保護・失敗時の報告**である。

**保存レイアウト**: 4.0 のとおり `auth/entries/<name>/state.json` と
`auth/entries/<name>/meta.json` に置く。接尾辞で種別を表さないので、auth 名がどんな値でも
別の種別と衝突しない。

**`<name>` の規則**（4.2 の project key と同一の規則にそろえる）:

- `^[A-Za-z0-9._-]+$` に一致する
- 空文字列でない
- `.` でも `..` でもない

違反は exit 2。`.` を許すので `oauth.v1` のような名前は有効である。禁じるのは
パス要素として意味を持つ `.` / `..` / `/` であって、名前中のドットではない。

**パスの保護**: 書き込み前に解決後の絶対パスが固定 cache root 配下にあることを再確認し、
経路上に symlink があれば拒否する。ディレクトリは `0700`、ファイルは `0600` で作成する。

**`meta.json` の内容**:

| キー | 内容 |
|------|------|
| `state_sha256` | 対になる `state.json` の SHA-256。**世代整合の判定はこれだけで行う** |
| `check_url` | 検証で遷移する URL（省略可） |
| `check_selector` | 認証済みでのみ現れる目印（省略可） |
| `saved_at` | 保存時刻。人間が見るための情報であり、判定には使わない |

**`state.json` に独自キーを足さない根拠**: このファイルは `cmux browser state save` が書き、
`state load` が読む。形式の所有者は cmux であり、cmux-e2e が `saved_at` などを注入してよい
根拠は無く、`load` の前に取り除く手順も定義できない。世代の同一性は、ファイルの中身を
変えずに外側から確認できる SHA-256 で判定する。

`saved_at` を判定に使わない根拠: 粒度と一意性が定義できない。同一秒内の連続保存では
別世代の組を一致と誤認する。

**`auth save` の公開手順（実装可能な形にする）**:

ディレクトリ単位の原子的置換は使わない。**`mv` は既存の非空ディレクトリを原子的に置換できない**。
destination が既存ディレクトリなら source をその中へ移す第 2 形式になり、`rename(2)` 自体も
空でない既存ディレクトリを置換できない。仕様としてこれを要求すると、portable な bash 実装が書けない。

代わりに **同一ディレクトリ内でのファイル単位の atomic rename** を使う。

1. worktree ロック → auth ロックの順に取得する（4.4）
2. タブが 1 つであることを確認する。2 つ以上なら exit 1
3. `auth/entries/<name>/` を作る（既存ならそのまま使う）
4. `cmux browser --surface <ref> state save auth/entries/<name>/.state.json.tmp.$$` を実行する
   一時ファイルは**同じディレクトリ**に置く。`$TMPDIR` に置くと別ファイルシステムになりえ、
   `mv` が copy + delete へ退化して原子性を失う
5. 一時 state の SHA-256 を計算し、`auth/entries/<name>/.meta.json.tmp.$$` を書く
6. `.state.json.tmp.$$` を `state.json` へ rename する
7. `.meta.json.tmp.$$` を `meta.json` へ rename する

6 と 7 の間で落ちた場合、`meta.json` は古い digest を指したまま `state.json` が新しくなる。
このとき digest は一致しないので、**次の読み手は load する前に fail-close する**。
逆順に落ちた場合も同様に不一致になる。どちらの順で落ちても、不整合な組が
「有効なもの」として使われることはない。

これが「世代を原子的に切り替える」代わりに採る保証である。切り替えの原子性ではなく、
**読み取り側の fail-close** で安全性を担保する。

完全な世代切り替えが必要になった場合の代替案（現時点では採らない）: 不変の
`generations/<gen>/` を作り、`current` という 1 ファイルの atomic rename で切り替える。
今回は digest による fail-close で十分であり、複雑さに見合わない。

**有効性の検証手順（load の前に照合する）**:

1. `meta.json` を読む
2. `state.json` の SHA-256 を計算し、`state_sha256` と比較する
3. 一致しなければ exit 1（「保存が中断されている。`auth save` で保存し直せ」）
4. 一致した場合に限り `state load` する
5. `check_url` / `check_selector` があれば遷移して `wait` する

**digest 照合と `state load` は locked core の中で 1 回だけ行う**（4.4）。
`auth_load_locked` が「digest 照合 → 不一致なら fail-close → `state load`」を行い、
`auth_check_locked` がそれに「遷移 → `wait`」を足す。CLI の `auth load` / `auth check` は
ロックを取ってこの core を呼ぶだけであり、`run --auth` は自分が取得したロックの下で
core を直接呼ぶ。`run` 側で先に digest を照合しない。

**共有 auth の差し替えレース**: auth は project 内の全 worktree で共有されるため、
照合と load の間に別 worktree が同じ auth を保存し直す可能性がある。
2〜5 は同一の auth ロックを保持したまま行う（4.4）。

**サブコマンドと入力契約**:

| 操作 | 形 | 内容 |
|------|-----|------|
| 保存 | `auth save <name> [--check-url <url> --check-selector <css>]` | storageState と meta を 1 世代として保存する |
| 読込 | `auth load <name>` | 検証せず state を適用する（単独操作） |
| 検証 | `auth check <name>` | digest 照合 → `load` → `check_url` へ遷移 → `check_selector` を `wait` |
| 一覧 | `auth list` | `<project>` 配下の name を列挙する（引数を取らない） |
| 削除 | `auth delete <name>` | auth ロックを保持したまま `auth/entries/<name>/` **だけ**を消す。`locks/` は消さない |

**`--check-url` と `--check-selector` は両方指定または両方省略**とし、片方だけなら exit 2。
片側だけでは検証が成立せず、「指定したのに検証されない」という最も紛らわしい状態になるためである。

**`auth save` はタブが 1 つのときだけ許可する**。state は開いているタブの情報を含むため、
複数タブの状態を保存すると、`load` するたびに複数タブへ復元され、4.6 のタブ 1 つ要求に
毎回引っかかる state を「正常に」保存できてしまう。

**`run` との結び付け — 明示 opt-in にする**:

`run <scenario> [--auth <name>]` とし、`--auth` が無ければ認証を一切扱わない。

根拠: 要件は「認証を含む UI フロー」を検証できることであって、全シナリオが保存済み認証を
前提とするとは定めていない。ログイン画面そのものや未認証からのリダイレクトを検証する
シナリオは、`run` が常に `auth check` を通すと実行できなくなる。また同一プロジェクトに
admin / customer など複数の state がある場合、どれを使うかを `run` が決められない。

`--auth <name>` が与えられたときの動作:

1. `auth/entries/<name>/state.json` が無ければ exit 1（`auth save` を促す）
2. meta に検証条件が無ければ `auth_load_locked` を呼ぶ。
   digest が一致しなければ exit 1（**load しない**）。load できたら
   「検証していない」と警告を出して続行する
3. 検証条件があれば `auth_check_locked` を呼ぶ。digest 不一致なら exit 1。
   検証に失敗したら exit 1 とし、「ステートが失効している。`auth save` で保存し直せ」と手順を示す

**失効検知の限界**: `state load` は「ファイルを読めたか」しか判定できない。セッションが
有効かどうかは、認証済みでのみ現れる目印を実際に待つ以外に判定手段が無い。

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

## 4.4 排他制御

保護すべき資源は 2 つあり、影響範囲が違う。

| ロック | 場所 | 守るもの |
|--------|------|---------|
| worktree ロック | `surfaces/locks/<worktree-key>/` | この worktree のサーフェスとレジストリ |
| auth ロック | `auth/locks/<name>/` | project 内で共有される 1 つの auth |

**サブコマンドごとに取るロック**:

| サブコマンド | worktree | auth |
|-------------|----------|------|
| `up` | 取る | — |
| `down` | 取る | — |
| `run`（`--auth` なし） | 取る | — |
| `run --auth <name>` | 取る | 取る |
| `auth save <name>` | 取る | 取る |
| `auth load <name>` | 取る | 取る |
| `auth check <name>` | 取る | 取る |
| `auth delete <name>` | — | 取る |
| `auth list` | — | — |

**`up` も取る根拠**: 状態 A で `up` が 2 本同時に走ると両方がサーフェスを作り、
最後のレジストリ書き込みだけが残って孤児ができる。

**auth ロックが worktree ロックと別に必要な根拠**: auth は project 内の全 worktree で
共有される。worktree ロックだけでは、worktree A の `run --auth foo` と worktree B の
`auth save foo` / `auth delete foo` を防げない。

**取得順序は worktree → auth に固定する**。逆順で取る経路を作らない。

### ロックを再入させない — CLI と locked core を分ける

`run --auth` がロックを取った後に CLI の `auth check` を呼ぶと、`auth check` 自身も
同じロックを取ろうとして、自分の live ロックに対して exit 1 になるか自己デッドロックする。
ロックは再入可能ではない。

したがって実装を 2 層に分ける。

| 層 | 置き場所 | ロック |
|----|---------|--------|
| locked core | `skills/cmux-e2e/scripts/lib/auth-core.sh` の `auth_save_locked` / `auth_load_locked` / `auth_check_locked` | **取らない**。呼び出し側が保持している前提 |
| CLI | `auth save` / `auth load` / `auth check` | 取得 → core を呼ぶ → 解放 |

`run --auth` は CLI を呼ばず、自分が取得したロックの下で core を直接呼ぶ。

**digest 照合と `state load` は core の中で 1 回だけ行う**。`run` 側で先に digest を照合しない。
core の `auth_load_locked` が「digest 照合 → 不一致なら fail-close → `state load`」を行い、
`auth_check_locked` がそれに「遷移 → `wait`」を足す。これにより正常経路の `state load` は
ちょうど 1 回になり、照合と load の間に別 worktree が割り込む余地も無い（auth ロックの内側だから）。

`auth load` と `auth check` の違いは検証条件を使うかどうかだけで、どちらも digest 照合を行う。

### ロックの実体

取得は 2 段階で行う。**`mkdir` が claim、`owner.json` の create-only 公開が確定**である。

1. `mkdir locks/<name>/` に成功する（claim）
2. そのディレクトリに `.owner.json.tmp.<generation>` を**内容を完成させてから**書く
3. `ln .owner.json.tmp.<generation> owner.json` で公開する。
   ハードリンクの作成は atomic かつ **create-only** で、`owner.json` が既に存在すれば失敗する
4. 3 が失敗したら、このロックは自分のものではない。一時ファイルを消して exit 1 とし、
   critical section に入らない
5. `owner.json` を読み直し、`generation` が自分のものであることを確認する。
   違えば exit 1 とし、critical section に入らない
6. 一時ファイルを消して critical section へ入る

`owner.json` の内容:

| キー | 内容 |
|------|------|
| `generation` | この取得に固有の ID（UUID）。**公開・解放・回収の判定に使う** |
| `pid` | 取得したプロセスの PID |
| `pid_start` | その PID の開始時刻（`ps -o lstart= -p <pid>` の値） |
| `host` | ホスト名 |
| `worktree` | worktree の canonical realpath |
| `started_at` | 取得時刻 |

**create-only で公開する根拠**: `mkdir` の成功から `owner.json` の公開までには必ず窓がある。
この窓で取得者が停止（SIGSTOP・ホストの suspend・長いスケジューラ遅延）し、その間に
ロックディレクトリが別の経路で隔離されて新しいディレクトリが同じパスに作られると、
停止していた取得者が復帰したときに**新しい所有者の `owner.json` を上書きしうる**。
パス名は再解決されるため、古いディレクトリハンドルを握っているわけではないからである。
公開を create-only にすれば、この上書きは EEXIST で失敗し、復帰した側は
critical section に入らずに脱落する。

**内容を完成させてからリンクする根拠**: 書きかけの `owner.json` を他プロセスが読む状態を作らない。

**解放**: 正常終了と捕捉可能なシグナル（INT / TERM / HUP）で `trap` により行う。
解放の前に `owner.json` の `generation` が自分のものと一致することを確認する。
一致しなければ何もしない。

### stale ロックは自動回収しない

`SIGKILL` や端末の強制終了では `trap` が走らず、ロックが残る。
**これを自動で回収する経路は設けない。**

**自動回収を捨てる根拠**:

- 自動回収には「回収してよいか」の判定と「回収そのもの」を原子的に行う必要があるが、
  portable な bash でこれを安全に実装する手段が無い。判定と回収の間に別プロセスが
  取得すれば、回収は live なロックを奪う
- 回収を直列化する別 mutex を導入すると、今度は**その mutex を保持したまま落ちた場合に
  誰も回収できなくなる**。mutex を回収する仕組みが要り、同じ問題が 1 段深いところで再発する
- どちらの失敗も、E2E テストの利便性のために排他保証を壊す取引になる。
  ロックが守っているのは認証ステートとサーフェスであり、二重所有は
  「別の worktree のテストが自分の認証を上書きする」形で表面化する

したがって**回復は明示的な人手の操作に限る**。

### ロックの状態報告と手動回復

取得に失敗したときは、判定して**報告するだけ**にする。回収はしない。

| # | 条件 | 報告 |
|---|------|------|
| 1 | `owner.json` が無い | 「取得中、または取得者が異常終了した」。`unlock` の手順を示す |
| 2 | `owner.json` が読めない / 壊れている | 「ロックが壊れている」。`unlock` の手順を示す |
| 3 | `host` が自ホストと異なる | 「別ホストが保持している」。生存は判定できない |
| 4 | `host` が自ホスト、`pid` が生きていて `pid_start` も一致 | 「実行中」。PID を示す |
| 5 | `host` が自ホスト、`pid` が生きているが `pid_start` が一致しない | 「取得者は終了している（PID 再利用）」。`unlock` の手順を示す |
| 6 | `host` が自ホスト、`pid` が生きていない | 「取得者は終了している」。`unlock` の手順を示す |
| 7 | `ps` が使えず `pid_start` を判定できない | 「生存を判定できない」。`unlock` の手順を示す |

いずれも exit 1。4 以外はメッセージに次の形の復旧コマンドを含める。

```
cmux-e2e unlock <surface|auth> <key> --generation <観測した generation>
```

**`--generation` を必須にする根拠**: 人間が状態を確認してから実行するまでの間に、
別プロセスが正常に取得している可能性がある。観測した `generation` と現在の `owner.json` の
`generation` が一致する場合だけ隔離すれば、その間に取得された live ロックを奪わない。

`owner.json` が無い、または壊れている場合は `--generation` を照合できないので、
`--force` を追加で要求する。このときに何が起こりうるか（停止していた取得者が復帰した場合の挙動）を
メッセージに明記する。create-only 公開があるため、復帰した取得者は新しい所有者を上書きせず脱落する。

`unlock` は対象を `locks-quarantine/<key>.<generation または timestamp>/` へ `mv` する。
削除しないのは、原因調査に使えるようにするためと、削除と再取得の競合を避けるためである。

**`down --sweep` との関係**: `--sweep` は孤児レコードの回収と `locks-quarantine/` の掃除を行う。
stale ロックの回収は `--sweep` の責務ではない。

## 4.5 シナリオの記法

**決定**: `apps/e2e-test` と同じ bash スクリプトに揃える。置き場は
`<worktree-root>/.cmux-e2e-scenarios/<name>.sh`。契約は**環境変数と `cmux-e2e-browser` ラッパーのみ**とし、
アサーションやテスト記述のためのヘルパーライブラリは提供しない。合否はシナリオの終了ステータスとする。

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

## 4.6 結果の集約と失敗条件

**決定**: `<worktree-root>/.cmux-e2e-results/<scenario>/` に集約する。
実行基盤が自動で集めるのは次の 4 つ。

| 成果物 | 取得元 | タイミング |
|--------|--------|-----------|
| `console.log` | `cmux browser --surface <s> console list` | シナリオ終了後（成否によらず） |
| `errors.log` | `cmux browser --surface <s> errors list` | シナリオ終了後（成否によらず） |
| `failure.png` | `cmux browser --surface <s> screenshot --out <path>` | シナリオが失敗したときのみ |
| `summary.md` | 実行基盤が生成 | 常に |

シナリオ自身が撮った screenshot / snapshot は同じディレクトリへ番号付きで置く（e2e-test の慣習）。

**成果物の権限と保持**: `console.log` / `errors.log` / `failure.png` およびシナリオが撮った
snapshot / screenshot は、アクセストークンや個人情報を含みうる。認証済みの画面を撮っているので
当然そうなる。したがって結果ディレクトリは `umask 077` の下で作成し、ディレクトリを `0700`、
ファイルを `0600` とする。既定の umask 次第では同一ホストの別ユーザーから読める状態で
残るため、`mkdir -p` と gitignore だけでは足りない。

保持と共有について SKILL.md と guide-ja.md に次を明記する。

- `.cmux-e2e-results/` は成果物であり、いつ消してもよい。`down` では消さない（証跡を残すため）
- 外部へ共有する前に内容を確認し、必要なら伏せる。特に `console.log` はトークンを含みやすい

**`summary.md` の責務**: `run` が必ず生成する単一ファイルで、シナリオ名・開始終了時刻・
終了コード・失敗理由の区分・収集した成果物の一覧・**`--no-guard` を使ったかどうか**を書く。
エージェントが読んで人間へ報告するための入力であり、エージェントの考察を書く場所ではない。

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

**`run` の工程順（固定・入れ替えてはならない）**:

1. ロック取得（worktree → auth の順。4.4。取れなければ exit 1）
2. サーフェス解決（状態 A / B / B' / C の判定）
3. `--auth <name>` があれば locked core を直接呼ぶ（digest 照合 → `state load` 1 回 → 条件があれば検証）。CLI の `auth check` は呼ばない（ロックの再入を避けるため。4.4）
4. **タブ数の確認**（1 つでなければ exit 1）
5. `console clear` / `errors clear`
6. シナリオ実行
7. 証跡の収集
8. `summary.md` の生成
9. ロック解放

**タブ数の確認を 3 の後に置く根拠**: state は開いているタブの情報を含むため、`load` 前に
タブが 1 つでも `load` 後に複数へ復元されうる。実際に判定対象となるのは `load` 後の状態なので、
確認は必ず `load` の後に行う。

**タブを実行基盤が自動で閉じない根拠**: 利用者が目視のために開いた画面を黙って消す動作になる。
タブが 2 つ以上あった場合の案内は、`down` / `up` のやり直しではなく
「余分なタブを閉じ、必要なら `auth save` で state を保存し直せ」とする。
複数タブを復元する state が原因の場合、`down` / `up` では直らないためである。

**判定対象を 1 タブに限定する根拠**: `errors list` はサーフェス単位であり、保持型サーフェスでは
別タブが出したエラーも混ざりうる。

**実行前に console / errors をクリアする**: サーフェスを使い回す設計なので、前回の実行で
出たエラーが残っていると次の実行を誤って失敗させる。

**終了コードの優先順位**: 上から順に判定し、最初に該当したものを採用する。
どの理由で落ちたかは必ず標準エラーへ明示する。

| 順位 | 事象 | 終了コード |
|------|------|-----------|
| 1 | ロックを取得できない（同一 worktree で実行中） | 1 |
| 2 | サーフェス解決の失敗（状態 A / B / B' / C） | 1 |
| 3 | 認証の失敗（state 不在 / 世代不整合 / 失効） | 1 |
| 4 | タブが 1 つでない | 1 |
| 5 | identity guard がシナリオ実行中に不一致を検出 | 1 |
| 6 | シナリオの非ゼロ終了 | シナリオの終了コードをそのまま返す |
| 7 | JS エラー検出（`--allow-js-errors` 未指定） | 1 |
| 8 | 証跡の収集失敗 | 1 |
| 9 | `summary.md` の書き込み失敗 | 1 |
| 10 | すべて成功 | 0 |

8 と 9 は、6 や 7 が先に成立していればそちらを優先し、失敗の事実は標準エラーへ出す
（テストの合否を収集や要約の失敗で塗り替えない）。9 が単独で起きた場合は、
`summary.md` が無いまま成功と報告すると後続が結果を読めないため exit 1 とする。

## 5. サブコマンド構成

**決定**: 5 本。`install` と `report` は作らない。

| サブコマンド | 形 | 役割 |
|-------------|-----|------|
| `up` | `up [--profile <name>]` | サーフェスを確保する（状態 A/B なら作成、B'/C なら中断）。ref を出力しレジストリへ記録 |
| `auth save` | `auth save <name> [--check-url <url> --check-selector <css>]` | storageState と検証条件を 1 世代として保存 |
| `auth load` | `auth load <name>` | state をサーフェスへ適用 |
| `auth check` | `auth check <name>` | load → 遷移 → 目印を待って有効性を確認 |
| `auth list` | `auth list` | 引数なし。`<project>` 配下の name を列挙 |
| `auth delete` | `auth delete <name>` | state と meta を削除 |
| `run` | `run <scenario> [--auth <name>] [--allow-js-errors] [--no-guard]` | ロックを取り、サーフェスを解決し、認証を通し、シナリオを実行して結果を集約する |
| `down` | `down [--sweep]` | サーフェスを破棄しレコードを消す。`--sweep` は worktree が消えた孤児と `locks-quarantine/` を掃除する |
| `unlock` | `unlock <surface\|auth> <key> --generation <gen> [--force]` | 異常終了で残ったロックを手動で隔離する。自動回収は行わないため、これが唯一の回復経路 |

**排他制御**: どのサブコマンドがどのロックを取るかは 4.4 の表で定める。
取得順は常に worktree → auth である。ロックは再入できないため、`run --auth` は
CLI の `auth check` / `auth load` を呼ばず、locked core を直接呼ぶ（4.4）。

**`--no-guard` を環境変数にしない根拠**: identity guard は安全機構であり、
`.env.dispatch` や親シェルから意図せず無効化されると、実行結果からどちらで走ったのか
判別できなくなる。CLI フラグに限定し、使用した事実を `summary.md` へ記録する。

**`install` を作らない根拠**: `cmux browser` は cmux 本体の機能であり、導入すべき依存が無い。
e2e-test の `install` は agent-browser を npm から入れるためだけに存在する。依存ゼロが
本プラグインの売りなので、何もしないサブコマンドを置くのは害になる。

**`report` を作らない根拠**: 4.6 のとおり、集約は `run` の一部として `summary.md` に畳む。
独立させると生成主体が二重定義になる。

**e2e-test との対応**:

| e2e-test | cmux-e2e | 差分の理由 |
|----------|----------|-----------|
| `install` | （無し） | 依存が無い |
| `run <scenario>` | `run <scenario> [--auth <name>] [--allow-js-errors] [--no-guard]` | 認証の指定、JS エラーの扱い、guard の制御を追加 |
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
| `cmux-e2e-browser` | `PATH` の先頭に置かれる identity guard ラッパー。`cmux browser --surface <ref>` と等価だが、毎回 `surface_ref` の一致を確認する（best-effort。4.1 の残余レースを参照） |
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
テスト記述の DSL でもなく、実行基盤が identity を確認するためのラッパーである。
操作の作法（snapshot → ref → 操作 → wait）は cmux-browser の管轄であり、ここでは説明しない。

## 7. 失敗モード表

| 状況 | 挙動 |
|------|------|
| cmux CLI が見つからない | exit 1。cmux 内で実行しているか確認するよう案内 |
| worktree ロックを取得できない（生きた owner あり） | exit 1。実行中である旨と owner の PID を示す |
| auth ロックを取得できない（生きた owner あり） | exit 1。別 worktree が同じ auth を操作中である旨を示す |
| ロックの owner が別ホスト | exit 1。生存を判定できないため回収せず、手動で消す手順を示す |
| ロックの owner が自ホストで死んでいる | stale として回収し、取得し直す（exit 0 で続行） |
| レコードが無い（`up` 未実行）で `run` | exit 1。`up` を先に実行するよう案内 |
| `surface_id` が `tree --all` に無い（状態 B）で `up` | 作り直して記録を更新（exit 0） |
| `surface_id` が `tree --all` に無い（状態 B）で `run` | exit 1。`up` を促す |
| `surface_id` はあるが type が browser でない（状態 B'） | exit 1。異常として中断する |
| `identify` の `surface_ref` が現在の ref と不一致（状態 C） | exit 1。別の画面を操作しないために中断する |
| identity guard がシナリオ実行中に不一致を検出 | exit 1。ラッパーが非ゼロで終了しシナリオを止める |
| project key を解決できない / 空 / `.` / `..` / regex 違反 | exit 1。`.dev-up.yaml` へ明示するよう案内 |
| シナリオ名に `/` または `.` が含まれる | exit 2 |
| auth 名が空 / `.` / `..` / `^[A-Za-z0-9._-]+$` 違反 | exit 2（名前中の `.` 自体は許可する） |
| `--check-url` と `--check-selector` の片方だけを指定 | exit 2。両方指定か両方省略のみ |
| `auth save` 時にタブが 2 つ以上 | exit 1。余分なタブを閉じてから保存し直すよう案内 |
| シナリオファイルが存在しない | exit 1。解決後の絶対パスを示す |
| `.env.dispatch` が無い | 続行する。ポート変数が無いことを警告に出すのみ |
| `--auth <name>` の `state.json` が存在しない | exit 1。`auth save <name>` で作成するよう案内 |
| `meta.json` が存在しない、または読めない（初回保存が state の rename 直後に中断した場合を含む） | exit 1。整合性の失敗として扱い、**state は load しない**。`auth save` での保存し直しを案内 |
| `state.json` の SHA-256 が `meta.json` の `state_sha256` と不一致 | exit 1。保存が中断されている旨と `auth save` での保存し直しを案内。**state は load しない** |
| 認証ステートが失効している | exit 1。ログインし直して保存し直す手順を示す |
| meta に検証条件が無い | `auth load` のみ行い、検証していない旨を警告に出す |
| state load 後にタブが 1 つでない | exit 1。余分なタブを閉じ、必要なら `auth save` で保存し直すよう案内 |
| auth / surfaces の保存先を作成・書き込みできない | exit 1。パスと必要な権限を示す |
| 保存先の経路に symlink がある | exit 1。cache root の外へ書かないために中断する |
| 結果ディレクトリを作成できない | exit 1。パスを示す |
| シナリオが非ゼロ終了 | 失敗。シナリオの終了コードを返し、console/errors を集約して failure.png を撮る |
| シナリオは成功したが JS エラーを検出 | exit 1。JS エラーが理由であることを明示 |
| 証跡の収集に失敗 | 単独なら exit 1。シナリオ失敗や JS エラーが先に成立していればそちらを優先し、警告に残す |
| `summary.md` の書き込みに失敗 | 単独なら exit 1。先に成立した失敗があればそちらを優先し、警告に残す |
| ロックディレクトリはあるが `owner.json` が無い | exit 1。取得中または異常終了と報告し、`unlock` の手順を示す（自動回収しない） |
| ロックの `owner.json` が壊れている | exit 1。`unlock --force` の手順を示す |
| ロックの owner の `pid` は生きているが `pid_start` が一致しない | exit 1。PID 再利用と報告し、`unlock` の手順を示す |
| `ps` が使えず `pid_start` を判定できない | exit 1。生存を判定できないと報告し、`unlock` の手順を示す |
| `owner.json` の create-only 公開が EEXIST で失敗 | exit 1。critical section に入らず脱落する |
| 公開後の読み直しで `generation` が自分のものでない | exit 1。critical section に入らず脱落する |
| 解放時に `owner.json` の `generation` が自分のものと違う | 何もしない |
| `unlock` の `--generation` が現在の `owner.json` と一致しない | exit 1。別プロセスが取得済みである旨を伝える |
| `auth save` の rename が state と meta の間で中断した | 次の読み手が digest 不一致で exit 1。**load はしない** |
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
    ├── scripts/*.sh          ← CLI（up / auth / run / down）
    └── scripts/lib/*.sh      ← locked core とロック実装。CLI から source する
```

`scripts/lib/` に置くのは `auth-core.sh`（`auth_*_locked`）と `lock.sh`（取得・解放・stale 回収）、
`surface.sh`（`tree --all` による解決）である。dev-up が `scripts/` に公開サブコマンド、
`scripts/lib/` に内部を置く構成と同じにする。ただし dev-up は lib を `bash` で実行するのに対し、
ここでは locked core をロック保持のまま呼ぶ必要があるため `source` する。

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

**サーフェスのライフサイクル**

| # | 確認内容 |
|---|---------|
| T1 | 状態 A（レコード無し）で `run` が exit 1、`up` が作成する |
| T2 | 状態 B（`surface_id` が `tree --all` に無い）で `up` が作り直す |
| T3 | 状態 B'（`surface_id` はあるが type が browser でない）で `up` と `run` が exit 1 |
| T4 | 状態 C（`identify` の `surface_ref` が不一致）で `up` と `run` が exit 1 |
| T5 | サーフェスを**別 pane / workspace / window へ移動**しても、`surface_id` で追跡でき状態 B に落ちない |
| T6 | `down` を 2 回続けて実行しても exit 0（冪等） |
| T7 | `down --sweep` が worktree 消滅済みのレコードだけを回収し、生きたレコードを消さない |

**identity guard と並行実行**

| # | 確認内容 |
|---|---------|
| T8 | guard が不一致を検出したらシナリオを非ゼロで止める |
| T9 | シナリオ実行中にサーフェスが閉じられた場合、guard が次の呼び出しで検出する |
| T10 | `--no-guard` で guard を通らず、その事実が `summary.md` に記録される |
| T11 | 環境変数では guard を無効化できない |
| T12 | 同一 worktree で `run` を 2 本同時に起動すると 2 本目が exit 1 |
| T13 | `run` と `down` が同じロックで直列化される |

**認証**

| # | 確認内容 |
|---|---------|
| T14 | `--auth` 未指定なら認証を一切扱わない |
| T15 | `--auth` 指定で state 不在なら exit 1 |
| T16 | `auth check` が成功 / 失効 / 検証条件未設定の 3 経路で正しく分岐する |
| T17 | `--check-url` と `--check-selector` の片方だけなら exit 2 |
| T18 | auth 名が `..` / `/` / 空なら exit 2。`oauth.v1` は通る |
| T19 | 保存された state のパーミッションが `0600`、ディレクトリが `0700` |
| T22 | `auth save` はタブが 2 つ以上なら exit 1 |
| T23 | 複数タブを復元する state を `--auth` で load したとき、タブ確認が exit 1 になる |

**パスの保護**

| # | 確認内容 |
|---|---------|
| T24 | project key が `..` / 空 / regex 違反なら exit 1 |
| T25 | `auth/` と `surfaces/` の両方で、経路上の symlink を拒否する |
| T26 | 異なる worktree（realpath が違う）が別の `<worktree-key>` になり、同名 basename でも衝突しない |
| T27 | 別クローンのリポジトリが別の project key になり、`auth list` に互いの name が出ない |

**合否判定**

| # | 確認内容 |
|---|---------|
| T28 | シナリオ失敗と JS エラー検出が同時に起きたとき、シナリオの終了コードが優先される |
| T29 | `--allow-js-errors` で JS エラーが合否に影響しない |
| T30 | 証跡収集の失敗がシナリオの合否を塗り替えない |
| T31 | `summary.md` の書き込み失敗が単独で起きたら exit 1、先行する失敗があればそちらを優先する |
| T32 | 開始時（state load 後）にタブが 2 つ以上あれば exit 1 |
| T33 | どの経路からも `cmux browser ... import` を呼ばない（スタブが呼び出しを記録して検証） |


**排他制御とロック回復**

| # | 確認内容 |
|---|---------|
| T34 | `up` を 2 本同時に起動すると 2 本目が exit 1 になり、サーフェスが 2 つ作られない |
| T35 | worktree A の `run --auth foo` と worktree B の `auth save foo` が同時に走らない |
| T36 | worktree A の `run --auth foo` 中に worktree B の `auth delete foo` が待たされる |
| T37 | ロック取得順が常に worktree → auth である（逆順の経路が存在しない） |
| T38 | `run` を SIGKILL で落とした後、次の `run` が stale ロックを回収して続行する |
| T39 | 生きた owner のロックは回収されない |
| T40 | 別ホストの owner のロックは回収せず exit 1 になる |
| T41 | 壊れた `owner.json` を stale として回収する |

**auth の保存レイアウトと世代整合**

| # | 確認内容 |
|---|---------|
| T42 | `foo` と `foo.meta` を同時に保存しても互いの state / meta を壊さない |
| T43 | `auth delete foo` が `foo.meta` を消さない |
| T44 | `auth list` が `foo` と `foo.meta` を別々に列挙する |
| T45 | `state.json` を改変すると digest 不一致になり、**load されずに** exit 1 になる |
| T46 | 正常経路での `state load` がちょうど 1 回だけ呼ばれる（スタブが呼び出し回数を記録） |
| T47 | 同一秒内に連続して `auth save` しても、digest により別世代を取り違えない |
| T48 | `entries/<name>/` の rename が中断して state と meta の世代が食い違っても、読み手が digest 不一致で **load せずに** exit 1 になる |

**UUID と現在の ref**

| # | 確認内容 |
|---|---------|
| T49 | UUID が同じで `ref` が変わったとき、`run` と `down` が**新しい ref** を使う |
| T50 | レジストリの `surface_ref` キャッシュが解決のたびに更新される |

**成果物の権限**

| # | 確認内容 |
|---|---------|
| T51 | 結果ディレクトリが `0700`、成果物ファイルが `0600` で作られる |
| T52 | `down` が `.cmux-e2e-results/` を消さない |

**project key**

| # | 確認内容 |
|---|---------|
| T53 | 異なる git common dir が異なる project key になる（導出ヘルパーをスタブして確認） |
| T54 | project key のハッシュが 16 桁である |


**保存レイアウトの衝突（round 4 指摘 1）**

| # | 確認内容 |
|---|---------|
| T55 | `foo` と `foo.lock` を同時に保存しても、一方の lock が他方の state / meta を移動・削除しない |
| T56 | `auth list` が `foo` と `foo.lock` を別々に列挙する |
| T57 | `auth list` が `locks/` / `locks-quarantine/` を列挙しない |
| T58 | `auth list` が state と meta の片方しか無いディレクトリを列挙しない |

**公開手順（round 4 指摘 2）**

| # | 確認内容 |
|---|---------|
| T59 | 既存の非空 `entries/<name>/` に対する上書き保存が成功する |
| T60 | state の rename 後・meta の rename 前に中断した状態で、読み手が digest 不一致により **load せずに** exit 1 になる |
| T61 | 一時ファイルが `entries/<name>/` と同じディレクトリに作られる（別ファイルシステムへ退化しない） |
| T62 | 初回保存（`entries/<name>/` が存在しない）が成功する |

**ロックの公開と回復（round 4 指摘 3 / round 5 ブロッカー 1・2）**

| # | 確認内容 |
|---|---------|
| T63 | `mkdir` 直後・`owner.json` 公開前のロックに対し、別プロセスが**回収せず** exit 1 になる |
| T64 | `owner.json` が部分的に書かれた状態を読み手が観測しない（内容を完成させてから `ln` する） |
| T65 | **取得者を `mkdir` 後に停止させ、その間に別プロセスが `unlock --force` で隔離し新たに取得した後、停止していた取得者を再開しても、create-only 公開が EEXIST で失敗して critical section に入らない** |
| T66 | 公開後の読み直しで `generation` が自分のものでなければ critical section に入らない |
| T67 | 解放時に `generation` が一致しなければ何もしない |
| T68 | 取得失敗時に自動回収が**一切行われない**（`locks/` が勝手に消えない・移動しない） |
| T69 | `unlock --generation` が一致しなければ exit 1 になり、隔離しない |
| T70 | `unlock` が削除ではなく `locks-quarantine/` への `mv` で行われる |
| T71 | `unlock` 後に同じキーを正常に取得できる |
| T72 | 取得失敗の 7 分岐（owner 無し / 壊れ / 別ホスト / live / PID 再利用 / 死亡 / `ps` 不可）がそれぞれ正しい報告を出す |

**ロックの再入（round 4 指摘 4）**

| # | 確認内容 |
|---|---------|
| T73 | `run --auth`（検証条件あり）がロックを再取得せず完走する |
| T74 | `run --auth`（検証条件なし）がロックを再取得せず完走する |
| T75 | どちらの経路でも `state load` がちょうど 1 回だけ呼ばれる |
| T76 | CLI の `auth check` を単独で実行したときはロックを取得する |

**control-plane の権限とパス（round 4 指摘 6 / round 5 指摘 4）**

| # | 確認内容 |
|---|---------|
| T77 | `meta.json` / レジストリ / ロックディレクトリ / `owner.json` がすべて `0700` / `0600` |
| T78 | レジストリの作成・読み取り・更新・削除が `surfaces/entries/` だけを対象にする |
| T79 | `down --sweep` が `surfaces/entries/` と `locks-quarantine/` だけを触り、`locks/` を消さない |
| T80 | `auth delete` が `auth/entries/<name>/` だけを消し、`auth/locks/<name>/` を消さない |

**meta 欠落の fail-close（round 5 指摘 5）**

| # | 確認内容 |
|---|---------|
| T81 | 初回保存が state の rename 直後に中断し `meta.json` が存在しない状態で、読み手が **load せずに** exit 1 になる |
| T82 | `meta.json` が壊れている状態でも **load せずに** exit 1 になる |

### 実機確認（必須）

ドキュメントとスタブだけで完成としない。実際の `cmux browser` に対して次を通し、
出力を証跡として dispatch の `result.md` に残す。

| # | 確認内容 |
|---|---------|
| E1 | 公開ページを開いて snapshot → click → wait → screenshot → `state save` → `state load` が通る |
| E2 | `wait` がタイムアウトしたときの終了コードを実測する（R3） |
| E3 | ブラウザサーフェスが 2 つ存在する状態で ref 指定が正確に解決されるかを実測する（R2） |
| E4 | `up` → `run` → `down` を通し、`down` 後にサーフェスが実際に閉じている |
| E5 | ブラウザサーフェスを別 pane へ移動しても `tree --all` の `id` で追跡できる |

## 10. 未決事項とリスク

| # | 事項 | 扱い |
|---|------|------|
| R1 | `browser open` が `--json` で返す surface ref / UUID の形は文書化されているが未検証 | 実機確認 E1 で確かめる。返り値が使えない場合は `cmux --json --id-format both tree --all` の差分から拾う（4.1 のとおり `list-pane-surfaces` は使わない） |
| R2 | 要求 ref と異なる surface に解決される事象が、ブラウザサーフェス不在時のフォールバックなのか常時の挙動なのか未確定 | 安全側に倒して「不一致なら中断」+ identity guard ラッパーで設計済み。実機確認 E3 で 2 つ以上のブラウザサーフェスを作って再測定し、常時ではないと確認できれば guard の既定を緩める |
| R3 | `wait` のタイムアウト時の終了コードが未検証 | 実機確認 E2 で確かめる。非ゼロでなければ合否判定の設計を見直す |
| R4 | `screenshot` の `--out` 省略時に base64 が stdout へ出るという記述が cmux-browser スキル由来で未検証 | 実行基盤は常に `--out` を付けるため影響しない |
| R5 | `.env.dispatch` を必須にしないため、ポート変数を前提にしたシナリオは dev-up 未導入プロジェクトで動かない | シナリオ側の責任として文書化する。実行基盤は警告を出すのみ |
| R6 | identity guard ラッパーは CLI 呼び出しを 2 倍にする | `run --no-guard` で無効化できる（使用は `summary.md` に記録される）。R2 の実測結果しだいで既定を見直す |
| R7 | **identity guard は残余レースを閉じない**。`identify` と本コマンドは別々の CLI 呼び出しであり、その間にサーフェスが閉じられればフォールバックが起きうる | 仕様上の既知の穴として 4.1 に明記した。ロックによる直列化と「実行中に手で閉じない」規約で実務上の発生確率を下げる。cmux が対象解決と操作を 1 RPC で fail-close できるようになれば解消する。上流へ要望として出す価値がある |
| R9 | **異常終了（SIGKILL・端末の強制終了）で残ったロックは自動回復しない**。人手で `unlock` を実行するまで、その worktree または auth は使えない | 意図した取引である。portable な bash で自動回収を安全に行う手段が無く、回収を直列化する mutex を足すと今度はその mutex が孤児化する。排他保証を壊すより、1 コマンドの手動回復を要求するほうが安全と判断した。失敗時のメッセージに復旧コマンドを必ず含める |
| R10 | `pid_start` の取得は `ps -o lstart=` に依存する | 取得できない場合は「生存を判定できない」と報告して `unlock` を促す（fail-close）。判定できないことを live とも dead とも決めつけない |
| R11 | `auth save` は世代の切り替えを原子的に行わない。state と meta の rename の間で中断すると不整合な組（meta 欠落を含む）がディスクに残る | 読み取り側が digest で fail-close するため、不整合な組が有効なものとして使われることはない。残骸は次の `auth save` が上書きする |
| R8 | `tree --all` の JSON 構造は実測（cmux 0.64.22）に依存する。将来のバージョンで変わりうる | スタブテスト T2 / T5 が構造を前提にしているため、構造が変われば必ずテストが落ちる。無言で壊れることはない |
