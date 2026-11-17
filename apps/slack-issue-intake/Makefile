# セットアップとフォームの入口。中身は bin/slack-issue-intake.ts の setup / form サブコマンドです。
# 手順は README の「セットアップ」を見てください。
NODE ?= node
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CLI := $(NODE) '$(ROOT)bin/slack-issue-intake.ts'
# NAME はコマンドラインだけで受け付ける（:= は環境変数の NAME に勝つ）
NAME :=
NAME_ARG = $(if $(NAME), --name '$(NAME)')

.PHONY: help setup manifest slack-form

help:
	@echo 'make setup       質問に答えて、Slack アプリの作成から automation の有効化までを進める（ターミナルで実行）'
	@echo 'make manifest    フォーム付きの Slack アプリのマニフェストを表示する（make manifest | pbcopy でコピー）'
	@echo 'make slack-form  init のあとに、対象チャンネルへフォームのボタン（ブックマーク）を置く'
	@echo 'NAME=<名前>      ワークスペースごとのホーム（~/.slack-issue-intake-<名前>）を使う。setup・manifest・slack-form に付ける（例: make setup NAME=ws2）'

setup:
	@$(CLI)$(NAME_ARG) setup

manifest:
	@$(CLI)$(NAME_ARG) form --manifest

slack-form:
	@$(CLI)$(NAME_ARG) form
