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

# 名前は 2 語目で受け取る（make auto-setup work）。省くと main。名前は make の目標ではないので何もしない規則を足す。
# コマンドラインの NAME=<名前> も今までどおり効く（コマンドラインの変数はこのファイルの代入に勝つ）
NAME_TARGETS := auto-setup setup hosts roles repos
GOAL_NAME := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
ifneq ($(and $(GOAL_NAME),$(filter $(firstword $(MAKECMDGOALS)),$(NAME_TARGETS))),)
ifneq ($(words $(GOAL_NAME)),1)
$(error 名前は 1 つだけ書いてください（例: make auto-setup main）)
endif
ifneq ($(filter $(GOAL_NAME),help check test test-unit $(NAME_TARGETS)),)
$(error $(GOAL_NAME) は make の目標と同じなので名前に使えません)
endif
NAME := $(GOAL_NAME)
$(eval $(GOAL_NAME):;@:)
endif
NAME ?= main
.PHONY: setup
setup: ## worker のモデル・取りかかり方などの既定・--auto の判定役のモデル・worktree を作る場所を設定し直す (make setup <名前>。名前は判定役の設定。省くと main)
	@node bin/orca-setup.ts --name $(NAME)

.PHONY: auto-setup
auto-setup: ## --auto の設定から automation の有効化までを対話で済ませる (make auto-setup <名前>。省くと main)
	@node bin/orca-auto.ts setup --name $(NAME)

.PHONY: hosts
hosts: ## --auto のマシン（接続端末）だけを変える。確認・並列数・保存の段まで (make hosts <名前>。省くと main)
	@node bin/orca-auto.ts hosts --name $(NAME)

.PHONY: roles
roles: ## --auto の review_mode / phase_b だけを on/off する (make roles <名前>。省くと main)
	@node bin/orca-auto.ts roles --name $(NAME)

.PHONY: repos
repos: ## --auto の関連リポジトリ（実装の対象）を足す・外す。マシン・確認・並列数・保存・判定の権限の承認の段まで (make repos <名前>。省くと main)
	@node bin/orca-auto.ts repos --name $(NAME)
