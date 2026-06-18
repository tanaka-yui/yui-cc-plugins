SHELL := /bin/bash
REPO_ROOT := $(shell cd ../.. && pwd)
HOME_DIR := $(HOME)/.claude/token-meter

.DEFAULT_GOAL := help

.PHONY: help
help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

.PHONY: setup
setup: deps install-plugins setup-hooks ## 完全セットアップ (brew/pipx 含む)

.PHONY: setup-hooks
setup-hooks: state-init hook-link ## hook 配線のみ (brew/pipx インストールなし)

.PHONY: deps
deps: ## 依存パッケージをインストール
	@cd $(REPO_ROOT) && pnpm install --filter=@tanaka-yui/token-meter

.PHONY: install-plugins
install-plugins: install-rtk install-caveman install-headroom ## 3 圧縮 plugin を全てインストール

.PHONY: install-rtk
install-rtk: ## rtk をインストール
	@command -v rtk >/dev/null || brew install rtk-ai/tap/rtk
	@rtk init -g --hook-only || true

.PHONY: install-caveman
install-caveman: ## caveman skill をインストール
	@test -d $(HOME)/.claude/skills/caveman || \
	  curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash

.PHONY: install-headroom
install-headroom: ## headroom MCP をインストール (uv tool install で Python 3.13 隔離環境)
	@command -v headroom >/dev/null || { \
	  command -v uv >/dev/null || { echo "Error: uv が必要です (brew install uv で導入)"; exit 1; }; \
	  uv tool install "headroom-ai[all]" --python 3.13; \
	}
	@headroom mcp install --agent claude || true

.PHONY: hook-link
hook-link: ## settings.json に hook を配線
	@bun run scripts/hook-link.ts --bin $(HOME_DIR)/bin

.PHONY: hook-unlink
hook-unlink: ## settings.json から hook を除去
	@bun run scripts/hook-link.ts --remove

.PHONY: state-init
state-init: ## ~/.claude/token-meter ディレクトリと state.json を初期化
	@mkdir -p $(HOME_DIR)/logs
	@chmod 700 $(HOME_DIR)
	@ln -sfn $(PWD)/bin $(HOME_DIR)/bin
	@ln -sfn $(PWD)/lib $(HOME_DIR)/lib
	@ln -sfn $(PWD)/node_modules $(HOME_DIR)/node_modules
	@test -f $(HOME_DIR)/state.json || \
	  echo '{"enabled":true,"tools":{},"plugins":{"rtk":true,"caveman":true,"headroom":true}}' \
	  > $(HOME_DIR)/state.json

.PHONY: status
status: ## 現在の状態を表示
	@bun run scripts/status.ts

.PHONY: doctor
doctor: ## 健全性チェック
	@bun run scripts/doctor.ts

.PHONY: test
test: ## bun test を実行
	@bun test

.PHONY: uninstall
uninstall: hook-unlink ## settings.json から token-meter hook を除去
	@echo "settings.json から token-meter hook を除去しました"

.PHONY: purge
purge: uninstall ## ~/.claude/token-meter を完全削除
	@rm -rf $(HOME_DIR)
