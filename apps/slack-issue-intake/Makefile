# セットアップとフォームの入口。中身は bin/slack-issue-intake.ts の setup / form サブコマンドです。
# 手順は README の「セットアップ」を見てください。
NODE ?= node
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CLI := $(NODE) '$(ROOT)bin/slack-issue-intake.ts'
# 名前は 2 語目で受け取る（make setup ws2）。名前は make の目標ではないので何もしない規則を足す。
# 環境変数の NAME は拾わない（:= は環境変数に勝つ）。コマンドラインの NAME=<名前> は今までどおり効く
NAME_TARGETS := setup manifest slack-form knowledge
GOAL_NAME := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
NAME :=
ifneq ($(and $(GOAL_NAME),$(filter $(firstword $(MAKECMDGOALS)),$(NAME_TARGETS))),)
ifneq ($(words $(GOAL_NAME)),1)
$(error 名前は 1 つだけ書いてください（例: make setup ws2）)
endif
ifneq ($(filter $(GOAL_NAME),help $(NAME_TARGETS)),)
$(error $(GOAL_NAME) は make の目標と同じなので名前に使えません)
endif
NAME := $(GOAL_NAME)
$(eval $(GOAL_NAME):;@:)
endif
NAME_ARG = $(if $(NAME), --name '$(NAME)', --ask-name=$@)

.PHONY: help setup manifest slack-form knowledge

help:
	@echo 'make setup       質問に答えて、Slack アプリの作成から automation の有効化までを進める（ターミナルで実行）'
	@echo 'make manifest    フォーム付きの Slack アプリのマニフェストを表示する（make manifest | pbcopy でコピー）'
	@echo 'make slack-form  init のあとに、対象チャンネルへフォームのボタン（ブックマーク）を置く。始めに仕様の索引も作り直す'
	@echo 'make knowledge   「質問する」に答えるための仕様の索引（リポジトリのドキュメントの写しと AI のまとめ）だけを作り直す'
	@echo '<名前>           ワークスペースの名前（ホームは ~/.slack-issue-intake-<名前>）。setup・manifest・slack-form・knowledge の後ろに書く。無ければ端末で聞く（例: make setup ws2）'

setup:
	@$(CLI)$(NAME_ARG) setup

manifest:
	@$(CLI)$(NAME_ARG) form --manifest

slack-form:
	@$(CLI)$(NAME_ARG) form

knowledge:
	@$(CLI)$(NAME_ARG) knowledge
