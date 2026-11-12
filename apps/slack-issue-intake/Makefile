# Slack のフォーム（ワークフロー）を作るための入口。中身は bin/slack-issue-intake.ts の form サブコマンドです。
# 手順は README の「フォームを make で作る」を見てください。
NODE ?= node
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CLI := $(NODE) '$(ROOT)bin/slack-issue-intake.ts'

.PHONY: help manifest slack-form

help:
	@echo 'make manifest    フォーム付きの Slack アプリのマニフェストを表示する（make manifest | pbcopy でコピー）'
	@echo 'make slack-form  init のあとに、対象チャンネルへフォームのボタン（ブックマーク）を置く'

manifest:
	@$(CLI) form --manifest

slack-form:
	@$(CLI) form
