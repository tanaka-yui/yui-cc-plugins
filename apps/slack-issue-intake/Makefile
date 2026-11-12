# セットアップとフォームの入口。中身は bin/slack-issue-intake.ts の setup / form サブコマンドです。
# 手順は README の「セットアップ」を見てください。
NODE ?= node
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CLI := $(NODE) '$(ROOT)bin/slack-issue-intake.ts'

.PHONY: help setup manifest slack-form

help:
	@echo 'make setup       質問に答えて、Slack アプリの作成から automation の有効化までを進める（ターミナルで実行）'
	@echo 'make manifest    フォーム付きの Slack アプリのマニフェストを表示する（make manifest | pbcopy でコピー）'
	@echo 'make slack-form  init のあとに、対象チャンネルへフォームのボタン（ブックマーク）を置く'

setup:
	@$(CLI) setup

manifest:
	@$(CLI) form --manifest

slack-form:
	@$(CLI) form
