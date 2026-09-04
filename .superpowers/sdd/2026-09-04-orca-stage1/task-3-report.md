# Task 3 実施報告: 成果の merge

## 対象

- `apps/orca-team-dispatch-task/bin/orca-merge.sh`
- `apps/orca-team-dispatch-task/test/test-merge.sh`

`orca-merge.sh --status-dir <d>` は、記録済み branch を記録済み integration branch にだけ merge する。worker の worktree・branch・端末等の資源を削除しない。

## RED

最初に `test/test-merge.sh` を追加して実行した。

```text
failures: 11
```

未実装だったため、MG1〜MG10 の全ケースが失敗した。続けて、形式外の receipt が正しい `worker_done|task|dispatch|outcome` 文字列と混在しても受理しない MG11 を追加した。実装前の実行結果は次のとおり。

```text
FAIL: MG11
failures: 1
```

## GREEN

fail-closed な受理ガードを実装した。

- `status.json` が `done`
- 空でない `result.md`
- すべてが 4 フィールドの `worker_done|task|dispatch|outcome` 形式で、対象 task/dispatch の `succeeded` receipt が存在
- 記録された worker branch と integration branch
- 現在の親 checkout が記録した integration branch で、clean であること

上記が一つでも確認できない場合、`integration-result.json` に `merged:false` と理由を記録して exit 1 とする。merge 成功時は `merged:true` を原子的に記録し、再実行は exit 0 とする。conflict 時は parent merge を abort するだけで、worker の worktree と branch は保持する。

## 検証

```text
bash apps/orca-team-dispatch-task/test/test-merge.sh
failures: 0

bash -n apps/orca-team-dispatch-task/bin/orca-merge.sh apps/orca-team-dispatch-task/test/test-merge.sh
bash apps/orca-team-dispatch-task/test/test-start.sh
failures: 0

bash apps/orca-team-dispatch-task/test/test-wait.sh
failures: 0
```
