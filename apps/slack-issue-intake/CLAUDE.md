# slack-issue-intake 開発ガイド

## 構成

bin が入口と安定パスのランチャー、lib が取得・状態・副作用・管理コマンド、skills が対話と無人の手順、test が模擬 Slack / gh / Orca を使う検証です。実行時依存はありません。

## 手順と状態の正本

無人手順の正本は `skills/slack-issue-intake/references/procedure.md`。変更時は procedure-ja.md、lib/permissions.ts、CA9 を揃えます。Claude が書くのは今回の decisions.json だけです。Slack / GitHub へ送るのは apply と poll です。
状態遷移は lib/db.ts と設計書の6.5節に対応します。起動できる設定かの検査と権限の指紋を分け、poll の毎回で両方を確認します。

## リースとフェンシング

状態、履歴区間、cursor、作成中の印はフェンス付きの比較更新で書きます。副作用の直前は renewLease。setInflightChild だけは持ち主 PID を条件に記録し、リース喪失後も送り手の身元を残します。
Issue の作成は、持ち主と子がすべて止まったと確認するまで再開しません。停止を初めて確認した時刻から90秒待ち、一覧の全ページで作者と最終行のマーカーを照合します。子はゲートで待ち、DB に身元を書いてから go を送ります。書く前に親が死ねば gh は起動されません。

## run のディレクトリ

各 run は連番付き台帳に登録してから作成します。消せるのは自分の runId と、台帳で自分より前の連番だけです。後から登録された run は消しません。Issue 本文の一時ファイルも台帳に登録した独立の run/runs/UUID に置きます。強制終了で残ったものは、次の collect が前の連番として片付けます。古い処理は新しいファイルを壊せません。

## 締め切り・ランチャー・定数

すべての Slack / gh 呼び出しへ deadline を渡します。残り時間がなければ呼びません。poll の予算は45秒です。
ランチャーは dev-digest の bin/launch.ts を元にし、lib を読みません。定数の写しと LAUNCHER_VERSION の重複だけを認め、LA2 で一致を確かめます。固定値は lib/defaults.ts にまとめます。添付リンクだけで上限に達する場合は、リンクを丸ごと省いて件数を示します。必須の骨組みすら収まらなければ送信せず失敗を記録します。

## セットアップのウィザード

`make setup`（`setup` サブコマンド、lib/commands/setup.ts）は11段で、済んだ段は飛ばして再開します。設定と automation がそろっていれば、送り先は変えずに今の設定を見せてリポジトリの追加と間隔を聞き直し、どちらかが変わったときだけ `init --every` で automation を書き換えます。プロジェクトにアプリの記録が無いときは既存のアプリ ID を聞き、入力されたら `slack app link --app <ID> --environment deployed`（チームが分かれば `--team`）でつないでから deploy します（Slack CLI は名前でアプリを探せないため）。文言は lib/defaults.ts の SETUP_TEXT と MSG_FORM\_* で、README の節名「Slack CLI を使わないセットアップ」「Workflow Builder で手で作る」を指します。名前を変えるときは両方を揃えます。入力は端末だけを読み、子のコマンドには stdin を渡しません。
Slack CLI のプロジェクトはホームの隣の `<ホーム>-slack-app`（既定 `~/.slack-issue-intake-slack-app/`、0700）に置きます。Slack CLI が `.slack/apps.json` にアプリ ID を書くので、プラグインのディレクトリ（更新で入れ替わる）にもホーム（退避で一緒に動く）にも置きません。`.slack/hooks.json` と form-trigger-<種類>.json は毎回書き直します（setup の毎回と form の開始時。プラグインの更新でパスが変わるため）。`.slack/config.json` は Slack CLI が書いた項目を残して manifest.source だけを local にし、apps.json は読むだけです。
トークンは deploy フックで受け取ります。Slack CLI がインストール後に `SLACK_BOT_TOKEN` を入れてフックを起こすので、`slack-hook deploy` は最初にマニフェストの指紋（SHA-256）を残し、トークンを secrets.json に保存します。setup は deploy の前に指紋を消すので、deploy のあとに指紋が無ければフックまで進まなかった（アプリが無い）とみなし、set-token ではなく deploy の失敗を示します。設定があれば、そのチームを `--team` に渡します。指紋が変わると次の setup で deploy し直します。実装上の動きで、約束された仕様ではありません。受け取れなければ set-token への案内で止まります。
`slack deploy` には `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_TOKEN` を除いた環境を渡します。Slack CLI は環境に既にある値を上書きせず使うので、残すと別のトークンを保存してしまいます。
`form`（make slack-form）は `slack trigger create` でカテゴリごとの4つのボタン（FORM_KINDS の順）、`slack trigger access` で使える人（チャンネルのメンバー）、ボットのトークンの workflows.featured.add（bookmarks:write）でチャンネルのおすすめワークフローにして入力欄の所にボタンを出し、ID を meta（form_trigger_id:<種類> など）に残して再実行で重ねません。0.2 の1つのボタン（キーが form_trigger_id のまま）は、新しいボタンをおすすめにしたあとで workflows.featured.remove と slack trigger delete で片付けます。消せなければ印を残して次の実行でやり直し、見つからない（not found）ものは消えたとみなします。おすすめが手作業の印（manual）の間は、新しいボタンが出るまで古いボタンを残します。deploy 済みの指紋が今のマニフェストと違えば、ボタンを作らず make setup へ案内して exit 2 で止まります。setup の9段は、すべてのボタンとおすすめがそろい、古い印が無い（または manual の）ときだけ済みにします。bookmarks.add で関連ページに足したリンクは Slack が外部リンクとして扱いブラウザを開くので使いません。`form --manifest`（make manifest）は guide のマニフェストに、組み込みの open_form と send_message だけのワークフロー4つ、`org_deploy_enabled: true`、FORM_EXTRA_SCOPES を足して出します。通常のマニフェストは変えません。
投稿の形は lib/form-message.ts の1か所で作り、ワークフローと手で作る手順のテンプレートが共有します。解析器は新しい形（太字の項目名、コードブロック）と 0.2 の `本文:` の形の両方を読み、カテゴリ別の項目を「項目名:」の行と値にして本文に入れます。このワークフローは自分のボットとして投稿します。poll と inspect は自分の投稿でもマーカーで始まるものを受け付け、起票者は本文のメンションだけから取ります。自分の返信は常にスレッド内なので履歴には出ません。
Slack CLI の呼び先の差し替えは SLACK_ISSUE_INTAKE_SLACK_CLI（テスト専用）です。実環境では未確認の点（deploy の受理、フックへのトークン、trigger create、conversations.join、投稿の太字とコードブロック、4つのおすすめ、0.2 のボタンの片付け）があり、README に書いてあります。
名前つきのホーム: 名前は必須。入口（bin/slack-issue-intake.ts）は先頭の --name を読み、知らないサブコマンドと引数なしは先に使用法を出す。slack-hook だけは環境変数が無ければ cwd の <ホーム>-slack-app から homeOfSlackProject でホームを決める（実機では未確認）。まだホームが無ければ、listIntakeNames の今ある名前と --name を足したコマンドを案内して exit 2。intakeHome() に既定は無い。名前は INTAKE_NAME_PATTERN に合い、ホームのディレクトリ名が INTAKE_NAME_RESERVED_SUFFIX（-slack-app）で終わらないこと（slack-app も不可）。orca-team-dispatch-task の lib/intake-homes.ts に写しがあり、scripts/check-shared-contracts.mjs が定数と一覧の選び方を照合します。--name と SLACK_ISSUE_INTAKE_HOME の両方があれば exit 2（ランチャーには付けない）。後ろの --name はそのサブコマンドの引数のままです。automation の名前は名前つきのホームで slack-issue-intake-<名前>（nameOfHome がディレクトリ名から読む）、名前なしは今のまま。Makefile の setup・manifest・slack-form・knowledge は 2 語目の名前（make setup ws2。コマンドラインの NAME=<名前> も効く）を --name にして渡し、環境変数の NAME は拾いません。2 語目が 2 つ以上・目標と同じ名前なら make が止めます。名前が無ければ --ask-name=<対象> を付け、質問は標準エラー、答えは標準入力から 1 バイトずつ読む。尽きたら make <対象> <名前> を示して exit 2。SLACK_ISSUE_INTAKE_HOME があれば聞かない。フックとランチャーはこの環境変数でホームを伝えるので --name を足さない（両方になり exit 2 になるため）。名前なしのホームは setup では作らないが、ランチャーからの poll・procedure・collect・apply と automation の名前 slack-issue-intake は今までどおり動く（MW9）。setup の最初と名前が無いときの案内で 1 行知らせ、消さない・移さない。Slack CLI のプロジェクトは ~/.slack-issue-intake-<名前>-slack-app/ で、29 行目の「既定」のパスは名前なしのホームのもの。lib/workspace.ts の案内は見たホームとそのまま打てるコマンドを出し、名前を読めないホームでは <名前> にする。名前つきのホームでは、setup の最初に make の名前と --name の付け方を 1 行出します。permissionFingerprint は、同じ親ディレクトリにある別の有効な intake ホームの secrets.json に対する user の Read / Edit の deny だけを指紋から除きます（自分の拒否と1ホームの旧指紋は保つ。MW7〜MW9）。ほかの拒否・継承権限・モードは今までどおり検出し、自分の拒否の欠落は safetyProblems が止めます。--auto の指紋は従来どおりなので、新しいワークスペースを追加したら --auto の make setup で権限を承認し直します。

## 質問と仕様の索引

「質問する」（FORM_KINDS の question、titled: false）は題と優先度の欄を持たない。parse は本文の先頭行を題にし、優先度は QUESTION_ISSUE_PRIORITY、fields.questionKind で質問を見分ける（それより前の行には無い）。投稿の形の種類別の分岐は form-message.ts・form.ts・guide.ts・parse.ts の titled だけ。
状態: answer は asking→waiting を使い回し（decision.action で分岐）、close は driven の closing→終端 closed（Issue なし。statusSync などは issue_number の無い行を見ない）。返信なしの時間切れは sync が waiting から closed にして Claude を起こさない。mustClose は rounds が MAX_ANSWER_ROUNDS 以上。質問の mustCreate は常に false。
質問からの create は validateDecisions が unsure・issueProposed・answered・title を確かめ、apply が fields をバグ・middle・決定の題に書き換えてから creating へ進める（ラベルを足さないので labels_hash は変わらない）。issueProposed は自分の投稿に MSG_ANSWER_PROPOSE があるかで決めるので、文言を変えると投稿済みの提案を見失う。
sources は work.json の knowledge.files（collect が meta.json から写す）にあるものだけ。permalink は validateDecisions が knowledge.commit から作り、決定に links として残す。FAQ は drive が answer の投稿と状態の保存に成功したあとで足す（poll の再試行でも）。足すのは sources のある回答だけ（根拠の無い回答とスレッドの文を次の回答の材料に混ぜない。QA3）。書けなくても結果は変えない。
索引は lib/knowledge.ts。clone は config.ghPath の `gh repo clone <repo> <dir> -- --depth 1`（独自の timeout。createGh の30秒では足りない）、commit は git rev-parse、claude -p は orca-team-dispatch-task の lib/setup-suggest.ts を写した読み取りだけの形（import しない）だが、clone は信頼できない中身なので 2 つ絞る: `--setting-sources user`（clone の .claude/settings.json の hooks などを読ませない）と、`--allowedTools` を素の Read,Glob,Grep ではなく `Read(/<clone の realpath>/**)` だけにする（素の許可はホームの鍵など clone の外まで読ませ、要約に混ぜて Slack へ出しうる）。dontAsk で clone の中の Glob / Grep が通るかは実機で未確認（KN1）。AI の文字列と写すドキュメントは maskSecrets を通す。docs/ は全部書けたあとにリネームで入れ替え、meta.json を最後に書き、faq.jsonl には触れない。リースは取らない（faq を書くのは apply / poll だけ）。setup の8段は全リポジトリに meta.json があれば済み、失敗しても止めない。form は始めに作り直し、setup からは --skip-knowledge で呼ぶ（二度作らない）。
無人の Claude に足した許可は `Read(/<home>/knowledge/**)` だけ（PM1）。許可の一覧が変わるので、更新した環境は setup の10段で承認し直すまで poll が permissions で止まる。

## 複数リポジトリと既存 Issue

config の repos / defaultRepo は init だけが書き換えます。repo の正本は submissions.repo で、fields の JSON には持ちません。Issue は owner/repo#番号、DB の状態は (repo, issue_number) で区別します。formRepos は既定を常に含め、2件以上なら任意の repo 欄を出します。setup は11段で、7段が report、8段が knowledge、9段が form、10段が承認、11段が有効化です。

表・列は openDb、0.4 の行と meta の移行は migrateToRepos がリース下でフェンス付きで行います。呼ぶのは poll と init だけで、init は config 保存前に旧defaultRepoで移します。これで既定の変更が過去の Issue の行き先を変えません。

adoptExisting は走査・投稿・ラベルの三段です。走査中は GitHub に書かず、更新順の増分と作成順の1ページずつの見直しを行います。5件のうち見直しに1件を残し、先頭のリポジトリを交代します。投稿とラベルは adopted のDB行から各5回まで進め、tried_atで順番を回します。ts の無い行は閉じても404でも削除しません。ts と issue_status2 の最初の状態は同じフェンス付きトランザクションで残します。slack-thread は orca-team-dispatch-task との管理対象の約束です。

## 向き先（base ラベル）

repos[].branches が向き先の候補（setup の4段か init --branches だけが書く。無いリポジトリには鍵ごと無く、空配列は読めない設定）。formBranches はフォームの対象のうち候補が FORM_BASE_FIELD_MIN_BRANCHES（2）以上のリポジトリの候補を合わせたもので、空でなければ題のある種類（質問以外）に任意の「向き先」欄（BASE_ANY と候補）を出す。manifestHash と renderFormManifest は候補も受け取るので、setup・form・slack-hook のすべてで formBranches を渡す（渡し忘れると指紋が合わず deploy や form が止まる）。
parseSubmission の 4 つ目の引数が選んだリポジトリ（null は既定）の候補を返し、BASE_ANY・空・候補外・質問の投稿は fields.base を持たない。apply は質問からの起票で base を外す（withoutBase）。起票は drive が findIssueByMarker と本文のあと、setInflight の前に `gh label create base:<b> --force`（色と説明は固定）を呼び、作れなければ base を外して起票し、DriveOutcome.warning を poll（errors）と apply（標準エラー）に出す。締め切りで呼べなかったとき、または呼び出しの途中で締め切りが来た（timeout で切られた）ときは、ラベルの失敗とみなさず、setInflight の前に起票せずに止める。選んだ向き先は本文の表に「向き先」の行（ISSUE_TABLE.base。選ばなければ行を足さない）としても書く。本文はラベルを作る前に作るので、ラベルを付けられなくても残る。orca-team-dispatch-task はこの行を読まない（約束はラベルだけ）。base:* は LABEL_SPECS と labels_hash に入れない（orca-team-dispatch-task との約束。BASE_LABEL_PREFIX）。
setup は追加したリポジトリ（フォームに出すもの）と、候補を持たない既定のリポジトリについて、`gh api repos/<r>/branches --paginate --jq .[].name` と `gh repo view <r> --json defaultBranchRef` で既定ブランチと BASE_BRANCH_CANDIDATES のうち在るものが2つ以上のときだけ聞く（fake-gh は FAKE_GH_BRANCHES と FAKE_GH_DEFAULT_BRANCH。パスを api の直後に置くのは fake-gh がそこで見分けるため）。聞かないときは入力の位置が変わらない。試験: CF6、IN19、SU29、FM9、PA25、IB11、IB12、PO31（PO30 は使用済み）、PO32、QA10、IS9（needs-base の新しい文面の素通し）。

## 定期報告

--auto の report.json（両プラグインの test/fixtures/auto-report.json が同じ形の約束）を読み、ステータス通知のあと、既存 Issue の取り込みより先に postReport を呼びます。表示時刻・経過は材料の updatedAt。ハッシュが同じなら更新せず、普段は chat.update、1日1回は新規投稿します。report_channel と今のチャンネルを照合し、違えば新規投稿します。ts/channel/hash は同じ書き込みで保存し、report コマンドは投稿の meta を消しません。材料が間隔の3倍より古ければ停止の警告を表示します。報告はそのホームのリポジトリの Issue だけを出し（scopeReport が issue の最後の `#` より前を repoSetting で照合し、取り出せない issue は出さない。件数・番号・ハッシュは絞ったあとの文面から作る）、マシンは名前とつながるかだけを出します（ほかのワークスペースの作業が分かる数を出さない）。

## ステータスの通知

poll は取り込み（sync）のあと、残りが STATUS_MIN_REMAINING_MS（10秒）以上あるときだけ lib/status-sync.ts の statusSync を呼びます。失敗は errors と partial に足すだけで、終了コードと agent_work は変えません（Claude を起こさない）。致命エラーやリース喪失のあとは呼びません。
ステータスラベル8つ（STATUS_LABELS、orca-team-dispatch-task と共通。並びは2つ付いたときの優先順）は LABEL_SPECS に入り、init が作ります。init はラベル名の指紋を meta labels_hash:<repo> に残し、起票は指紋が今と一致するときだけ Backlog を付けます（無いラベルを付けると gh issue create が失敗するため。更新直後で setup 前の poll を守る）。setup の5段は指紋が違えば init をやり直します。ensureLabels は名前を大文字小文字を区別せずに比べます。
前回の状態は表 issue_status2（repo と番号を主キーにし、submissions の created は書き換えないので別の表）に持ちます。起票とマーカーでの採用は transitionWithStatus で同じトランザクションに最初の行を入れます。行の無い Issue（前からあるもの）は、初めて見たときに記録だけします。一覧は sort=updated の昇順で読み、処理し終えた Issue まで meta status_cursor:<repo>:<label> を進めます（次の回は60秒戻して since に使う）。コメントは行の seenUpdatedAt を since にして読み、lastCommentId より大きい id だけを見ます。
AI が変えたとみなすのは、新しいコメントのうち信じられる書き手（OWNER / MEMBER / COLLABORATOR か config の github.login）の最新のマーカーが、今のラベルの slug と一致するときだけです。部分 C はコメントを先に書いてからラベルを動かす約束（spec 5.4）なので、ラベルが変わらず最新のマーカーが合わない回は、行を保存せず（seenUpdatedAt を進めず）次の回に同じコメントを読み直します。完了（Done か閉じた）は、前回すでに完了だったときは書きません。文言とメンションの有無は STATUS_EVENTS（event ごと）。ステータスが変わらなくても書く event（stalled と needs-base）は STATUS_EVENTS_WITHOUT_CHANGE に集め、`renderStatusMessage` がこれで判断する。human-merged と ai-merged の文言は {comment} を持ち、orca-team-dispatch-task が Done の本文に戻しの PR のリンクを載せる。コメントは HTML コメントの行を除き、maskSecrets と escapeMrkdwn を通し、太字とリンクだけを Slack の形にして3000字で切ります。マーカーの形と event の名前は部分 C との約束で、例は test/fixtures/orca-auto-comments.json です（C は同じファイルを写して使う）。
statusSync の例外は poll が errors に入れ、結果の行と終了コードは変えません。Slack に書いたあとでフェンス付きで行を保存します。thread_not_found なら諦めて記録を進め、ほかの失敗は STATUS_MAX_ATTEMPTS（5）回まで、その Issue で止めて次の回にやり直します。
メンション先は config.mention（0.3 の config には無いので asked:false として読む）。書くのは mention サブコマンドだけで、init は base.mention を引き継ぎます。usergroups.list（usergroups:read）は mention でだけ呼び、poll では呼びません（poll では missing_scope が致命エラーになるため）。

## 試験と秘密

テスト専用の差し替えは SLACK_ISSUE_INTAKE_HOME、SLACK_ISSUE_INTAKE_API_BASE（loopback のみ）、SLACK_ISSUE_INTAKE_CLAUDE_HOME、SLACK_ISSUE_INTAKE_CLAUDE_BIN（索引を作る claude。fake-gh の repo clone は FAKE_GH_CLONE_SOURCE があるときだけ成功する）。Orca の呼び先には ORCA_BIN を使えます。本番の設定手順にテスト変数を使いません。
外部文字列を出力・保存する前に maskSecrets を通します。トークンを argv に置きません。実テストは `bash test/run-all.sh`、型と lint はワークスペースの check です。実サービスへの受け入れ確認は README に分けています。

添付・名前のメタデータ取得は成功と失敗を区別します。一時失敗はその件を skipped にし、記録済みの files・transcript・名前を空で確定しません。連続スキップは attempts に数え、MAX_ACTION_ATTEMPTS で failed にして lastError を残します。取得が成功したら回数をリセットします。恒久的に見えない名前は以前の値か不明、見えない添付はその1件だけを除外して進めます。認証などの致命エラーは縮退せず停止します。--now は検証済みの loopback API を使う試験環境だけで受け付けます。

プロセスの身元を読む ps は UTC / C ロケールで実行します。実行元の TZ の違いを PID の再利用と取り違えません。