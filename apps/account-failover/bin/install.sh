#!/usr/bin/env bash
# account-failover を Orca にインストール（インストール済みなら更新）する。
# コードを動かすプラグインなので、Orca は初回と権限が増えたときに承認（--approve）を求める。
# 承認は端末で確認を取ってからだけ行い、無言では承認しない。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_KEY="local.account-failover"

if ! command -v orca >/dev/null 2>&1; then
  echo "orca CLI が見つかりません。Orca をインストールしてから再実行してください。" >&2
  exit 1
fi

if orca plugin list --json 2>/dev/null | grep -q "\"${PLUGIN_KEY}\""; then
  action=(update "${PLUGIN_KEY}")
else
  action=(install "${PLUGIN_DIR}")
fi

run() {
  local out code=0
  out="$(orca plugin "${action[@]}" "$@" --json 2>&1)" || code=$?
  printf '%s' "${out}"
  return "${code}"
}

code=0
output="$(run)" || code=$?

if [[ ${code} -eq 0 ]]; then
  echo "account-failover を ${action[0]} しました (${PLUGIN_KEY})"
  exit 0
fi

if [[ ${code} -ne 3 ]]; then
  echo "${output}" >&2
  echo "account-failover の ${action[0]} に失敗しました (exit ${code})" >&2
  exit "${code}"
fi

fingerprint="$(grep -oE -- '--approve ap1-[A-Za-z0-9]+' <<<"${output}" | head -1 | awk '{print $2}')"
if [[ -z "${fingerprint}" ]]; then
  echo "${output}" >&2
  echo "承認が必要ですが fingerprint を読み取れませんでした。上の出力の指示に従ってください。" >&2
  exit 1
fi

echo "account-failover は承認が必要です。与える権限:"
echo "  - trusted-worker: あなたのユーザー権限で Node.js の worker を常駐させる（ps / lsof / orca CLI を実行する）"
echo "  - agent:read / terminal:send / notifications:show"
echo "再実行コマンド: orca plugin ${action[*]} --approve ${fingerprint}"

if [[ ! -t 0 ]]; then
  echo "端末ではないため承認しません。上のコマンドを手で実行してください。" >&2
  exit 1
fi

read -r -p "承認してインストールしますか？ [y/N] " answer
if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
  echo "中止しました。"
  exit 1
fi

code=0
output="$(run --approve "${fingerprint}")" || code=$?
if [[ ${code} -ne 0 ]]; then
  echo "${output}" >&2
  echo "account-failover の ${action[0]} に失敗しました (exit ${code})" >&2
  exit "${code}"
fi
echo "account-failover を ${action[0]} しました (${PLUGIN_KEY})"
