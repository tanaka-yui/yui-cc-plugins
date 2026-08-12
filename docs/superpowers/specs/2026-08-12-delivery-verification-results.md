# 配送前提の検証結果

実施日: 2026-08-13
対象: `docs/superpowers/specs/2026-08-12-dispatch-message-delivery-design.md` の V1 / V2

| ID | 検証内容 | 結果 | 観測 |
|----|---------|------|------|
| V1 | agmsg push が idle な claude セッションを起こすか | **fail** | 下記のとおり。ready sentinel は最後まで生成されなかった |
| V2 | codex bridge が codex 0.147 で通るか | **未実施** | V1 が fail した時点で「完全 agmsg 化」が到達不能になったため、`~/.zshrc` を変更する検証は行わないと判断した |

## V1 の観測

probe 用の空プロジェクトを作り、agmsg に join して delivery mode を `monitor` にしたうえで、
cmux の新規ワークスペースに claude を起動して観測した。

1. **フックは正しく入る。** `delivery.sh set monitor claude-code <dir>` は
   `<dir>/.claude/settings.local.json` に SessionStart / SessionEnd フックを書き込み、
   `delivery.sh status` は `mode: monitor` / `SessionStart entries: 1` を返した
2. **起動直後の idle セッションには watcher が無い。** claude を起動しただけの状態では
   `ready.v1probe__probe-cc` sentinel は作られなかった。SessionStart フックが出す指示は、
   セッションがターンを持って初めて実行されるため
3. **初回ターンを与えても watcher は起動しなかった。** `hi` を送って 1 ターン回したが、
   セッションは SessionStart ディレクティブに従わず、sentinel も作られなかった
4. **明示指示すると Monitor ツールではなく Bash を選んだ。** watcher の起動を直接指示したところ、
   セッションは `watch.sh` を **Bash ツールで** 実行しようとした。
   これはバックグラウンド Bash の stream 出力がプロセス終了まで注入されない、
   旧来の「idle セッションを起こせない」経路そのもの
5. **Monitor ツールはこのハーネスに存在しない。** 検証を行ったセッション自身の
   利用可能ツールに `Monitor` は無く（`ToolSearch select:Monitor` が no match、
   deferred ツール一覧にも不在）、それでも SessionStart フックは
   「Monitor ツールを今すぐ呼べ」という AGMSG-DIRECTIVE を出していた

## 結論

**「agmsg push が idle な claude セッションを起こす」は、この環境では成立しない。**

設計ドキュメントは、SKILL.md の既存記述（「agmsg push は inbox 記録専用で idle セッションを起こせない」）を
**古い前提だと判断していたが、その判断が誤りだった**。agmsg 1.1.13 の claude-code ドライバが
monitor モードで Monitor ツールを使う設計になっているのは事実だが、ハーネスがそのツールを
公開していなければ絵に描いた餅であり、実際にはフォールバックとして Bash watcher が使われる。

## ready sentinel は wake 能力の証明にならない

さらに重要な帰結がある。`ready.<team>__<agent>` sentinel は `watch.sh` が書くが、
`watch.sh` は **Monitor ツール配下でも Bash 配下でも同じ sentinel を書く**。
したがって sentinel の存在は「watcher プロセスが生きている」ことしか示さず、
「そのセッションを起こせる」ことは示さない。

`send-prompt.sh` の当初設計は sentinel を根拠に「agmsg 経路のみ / タイプ入力しない」を選ぶが、
Bash watcher 配下の sentinel に対してこれを行うと、**メッセージは相手が次にターンを持つまで届かない**。
dispatch の待機ペインは指示が来るまでターンを持たないので、事実上のデッドロックになる。

## 実装への反映

- claude 宛ての配送: **タイプ入力が主経路**
- codex 宛ての配送: **タイプ入力が主経路**
- `cmux send` の全廃: **不可**
- agmsg: wake 手段としては使わない。inbox への記録としてのみ使う

つまり **既存の dual-send プロトコル（常にタイプ入力し、watcher が生きていれば inbox にも記録する）が正しかった**。
本件で修正すべきだったのは配送経路の選択ではなく、タイプ入力そのものの信頼性
（長文の貼り付け判定と Enter の取りこぼし）だけだった。そちらは Task 3 / Task 4 で解決済みである。

## E2E の結果

実際の cmux ペインで動く Claude Code TUI を宛先に、事故を再現するサイズ（**1343 文字**、
本文 + `parallel-directive.sh --engine claude --mode review` の 899 文字）の
レビュー依頼を `send-prompt.sh` で送って観測した。

### 1 回目 — 欠陥を発見

配送そのものは完全に成功した。outbox ファイルが生成され、ポインタ 1 行がタイプされ、
Enter が効き、受信側の claude がファイルを読んで指示に従い始め、入力欄は空になっていた。
それでも `send-prompt.sh` は `exit 1` を返した。

原因は入力欄検証にあった。Claude Code は**送信済みプロンプトをトランスクリプトにも
`❯` 付きで表示し続ける**ため、全 `❯` 行を対象にした検査が、配送成功時の反響に必ずマッチしていた。

```
❯ review-code: read /private/.../outbox/review-code-1.md and     ← 送信済みの反響
  follow every instruction in it.
⏺ I'll read the instruction file first.
─────────────────────────
❯                                                                  ← 実際の入力欄（空）
```

影響は誤報告だけに留まらない。正常配送のたびに無駄な Enter が 3 回、動作中のセッションへ送られ、
`exit 1` を `|| return 1` で受ける `launch-workspace.sh` の `notify_parent` が失敗扱いになるため、
`notify_parent_once` が marker を更新できず**親への完了通知が繰り返し飛ぶ**。

計画外の Task 11 として、検査対象を**画面上で最後の `❯` 行**だけに絞る修正を入れた。

### 2 回目 — 修正後

| 観測項目 | 結果 |
|---------|------|
| `send-prompt.sh` 終了コード | 0 |
| `send-key` 呼び出し回数 | 1 回（初回のみ、再送なし） |
| outbox ファイル | `review-code-2.md` が生成され連番も正しくインクリメント |
| 入力欄 | 空。詰まりなし |
| 受信側 | ファイルを読んで指示に従い、レビューを開始 |

元の事故を再現するサイズの依頼文が、入力欄を一切通らずに届くことを実測で確認した。

### 未実施

実際の dispatch を丸ごと 1 本流す E2E は行っていない。上記は配送経路そのものを直接突く検証であり、
`SKILL.md` の指示文が組み立てる呼び出しが正しいかは静的検査（CS1-CS3）に委ねている。
