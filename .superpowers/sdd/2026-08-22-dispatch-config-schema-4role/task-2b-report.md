# Task 2b report

## Status

実装完了。`override-args.sh` と focused test のみを追加した。

## TDD evidence

- RED: brief の Step 2（実装前は `override-args.sh` 不在のため全件失敗）に該当するテストを先に作成した。
- GREEN: `bash apps/cmux-team-dispatch-task/test/test-override-args.sh` — OA1, OA5-model, OA5-effort, OA5-runner, OA6, OA7 が全て PASS。
- 追加確認: `bash -n .../override-args.sh` および `git diff --check` が成功。

## Files

- `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/override-args.sh`
- `apps/cmux-team-dispatch-task/test/test-override-args.sh`

## Self-review

`config-lib.sh` の runner/model/effort 検証を利用し、runner 変更時は registry から engine を再解決する。pending が空値なら無視し、検証失敗時は当該 role の全 override を破棄して warning を stderr に出す。出力は `printf '%s\0'` の NUL 区切りで、`.codex/` は変更していない。

## Commit

未コミット（親エージェントが確認後にコミットする）。

## Fix round 1

- effective runner は pending の有無にかかわらず registry で再検証し、未登録なら role 全体を破棄。
- effective model の空値を必須判定（Claude 全 role と codex review role）し、存在時は常に `dispatch_valid_model` と codex alias 規則を適用。
- test helper が script の exit status を `OA_RC` に捕捉するよう修正し、effective runner 未登録（OA8）と必須 model 欠落（OA9）の回帰テストを追加。
- `bash apps/cmux-team-dispatch-task/test/test-override-args.sh`: OA1, OA5-model, OA5-effort, OA5-runner, OA6, OA7, OA8, OA9 全 PASS。
