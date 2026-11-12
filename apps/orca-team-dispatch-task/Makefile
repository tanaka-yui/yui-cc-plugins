SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help
help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

.PHONY: check
check: ## 型チェックと biome
	@pnpm --filter @tanaka-yui/orca-team-dispatch-task check

.PHONY: test
test: ## 全テストを実行 (bash のテスト群 + node --test の単体テスト)
	@bash test/run-all.sh

.PHONY: test-unit
test-unit: ## lib/ の単体テストだけを実行
	@node --test 'test/unit/*.test.ts'
