---
name: codex-review
description: >-
  agmsg の inbox を確認したうえで、新しい cmux ペインで codex (gpt-5.6-sol / reasoning effort
  xhigh = extra high) によるコードレビューを起動するスキル。ユーザーが「codex でレビュー」「codex review」
  「5.6 sol でレビュー」「extra high でレビュー」「agmsg 起動してレビュー」「別ペインでレビューを回して」等と
  言ったとき、または現在の変更を codex に第三者レビューさせたいときに必ず使う。cmux セッション内
  (CMUX_SOCKET_PATH が設定されている) が前提。単に diff を自分で読むのではなく、独立した codex プロセスに
  高リーズニングでレビューさせたい意図があればこのスキルを起動すること。
---

# codex-review

現在の作業を **codex に第三者レビューさせる** ためのスキル。agmsg の受信箱を確認してから、
新しい cmux ペインで codex を起動し、`codex review` を高リーズニングで走らせる。

デフォルト設定:

- **モデル**: `gpt-5.6-sol`
- **reasoning effort**: `xhigh`（extra high）
- **対象**: 未コミット変更（`--uncommitted`）
- **分割方向**: `right`

## なぜこの構成か

レビューを独立した codex プロセスに委ねると、実装した本人（＝このセッション）の思い込みに
引きずられない指摘が得られる。effort を `xhigh` まで上げるのは、レビューは実装より
「見落としの発見」に価値があり、多少遅くても深く考えさせる方が費用対効果が高いため。
新ペインで対話起動するのは、ユーザーが指摘を目で追いながら必要なら追質問できるようにするため。

## 前提

- **cmux セッション内**であること（`CMUX_SOCKET_PATH` が必要）。cmux 外ではペイン分割できない。
- `codex` CLI がインストール済みで PATH 上にあること。
- agmsg は任意。未参加・未インストールでもレビュー起動は止めない。

## 実行手順

### 1. agmsg の inbox を確認（非ブロッキング）

`~/.agents/skills/agmsg/` が無ければ、プラグインの install.sh を一度だけ実行してブートストラップする。
その後 `whoami.sh` で identity を解決し、参加済みなら `inbox.sh` で受信箱を確認する。未参加・未インストール
なら一言添えてスキップし、レビュー起動へ進む。詳細な分岐は `/codex-review` コマンド（`commands/codex-review.md`）
の Step 1 と同じ。

### 2. codex レビューを起動

bin スクリプトを実行する。cmux ペインを分割し、そのペインで `codex review` を送信する。

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" [引数]
```

主な引数（すべて任意、詳細は bin のヘッダコメント参照）:

| 引数 | 意味 |
|------|------|
| `right` / `down` / `left` / `up` | 分割方向（default: right） |
| `--base <branch>` | 未コミット変更ではなく base ブランチとの差分をレビュー |
| `--commit <sha>` | 指定コミットの変更をレビュー |
| `-m <model>` / `-e <effort>` | モデル / effort の上書き（default: gpt-5.6-sol / xhigh） |
| `-- <指示>` | codex review へのカスタムレビュー指示 |

### 3. 報告

bin が出力する起動サマリ（`codex review 起動: <surface> (...)`）を 1 行で伝える。
codex 側でレビューが流れ始めるので、このセッションでのポーリングは不要。

## 起動される codex コマンド（参考）

```bash
codex review --uncommitted -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh"
```

`codex review` は非対話でレビューを実行するサブコマンド。`-c` でモデルと effort を
`~/.codex/config.toml` の設定より優先して上書きする。
