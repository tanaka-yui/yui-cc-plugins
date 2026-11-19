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

# 名前は 2 語目で受け取る（make setup work）。省くと main。名前は make の目標ではないので何もしない規則を足す。
# コマンドラインの NAME=<名前> も今までどおり効く（コマンドラインの変数はこのファイルの代入に勝つ）
NAME_TARGETS := auto setup hosts roles
GOAL_NAME := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
ifneq ($(and $(GOAL_NAME),$(filter $(firstword $(MAKECMDGOALS)),$(NAME_TARGETS))),)
ifneq ($(words $(GOAL_NAME)),1)
$(error 名前は 1 つだけ書いてください（例: make setup main）)
endif
ifneq ($(filter $(GOAL_NAME),help check test test-unit $(NAME_TARGETS)),)
$(error $(GOAL_NAME) は make の目標と同じなので名前に使えません)
endif
NAME := $(GOAL_NAME)
$(eval $(GOAL_NAME):;@:)
endif
NAME ?= main
.PHONY: auto
auto: ## --auto を1回まわす。判定が必要なときだけClaudeを起動 (make auto <名前>。省くと main)
	@rc=0; node bin/orca-auto.ts tick --name $(NAME) || rc=$$?; \
	case $$rc in \
	  0) claude --model "$$(node bin/orca-auto.ts judge-model --name $(NAME))" --effort "$$(node bin/orca-auto.ts judge-effort --name $(NAME))" 'Run `node $(CURDIR)/bin/orca-auto.ts judge-doc --name $(NAME)` and follow the printed instructions exactly.' ;; \
	  1) exit 0 ;; \
	  *) exit $$rc ;; \
	esac

.PHONY: setup
setup: ## --auto の設定から automation の有効化までを対話で済ませる (make setup <名前>。省くと main)
	@node bin/orca-auto.ts setup --name $(NAME)

.PHONY: hosts
hosts: ## --auto のマシン（接続端末）だけを変える。確認・並列数・保存の段まで (make hosts <名前>。省くと main)
	@node bin/orca-auto.ts hosts --name $(NAME)

.PHONY: roles
roles: ## --auto の review_mode / phase_b だけを on/off する (make roles <名前>。省くと main)
	@node bin/orca-auto.ts roles --name $(NAME)
