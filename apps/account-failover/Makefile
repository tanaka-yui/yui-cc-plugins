SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help
help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

.PHONY: types
types: ## Orca の型定義を .orca/types に書き出す
	@orca plugin types .

.PHONY: check
check: ## 型チェックと biome
	@pnpm --filter @tanaka-yui/account-failover check

.PHONY: test
test: ## テストを実行 (orca plugin test)
	@orca plugin test .

.PHONY: validate
validate: ## マニフェストを検証
	@orca plugin validate .

.PHONY: dev
dev: ## 開発用に読み込み、ログを流す (Ctrl-C で外す)
	@orca plugin dev watch .

.PHONY: install
install: ## Orca にインストール (承認が必要なら確認してから --approve)
	@bash bin/install.sh
