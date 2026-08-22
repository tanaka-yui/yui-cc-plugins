#!/usr/bin/env bash
# config-lib.sh の単体テスト。
#
# 守っている不変条件:
#   CL1. DISPATCH_CONFIG_HOME の既定値と env による上書き
#   CL2. RUNNERS_CONFIG_PATH が runners.json だけを個別に上書きする
#   CL3. runner 名の検証 (空 / 前後空白 / シェルメタ文字 / 制御文字を拒否)
#   CL4. model 値の検証 (同じ拒否条件。内部空白は許容)
#   CL5. effort の小文字正規化 ("xHigh" -> "xhigh")
#   CL6. effort の engine 別 allowlist (codex に max は無い)
#   CL7. ロール名は 4 つ固定
#   CL8. 組込み既定値の表
#   CL9. model 省略可否の matrix

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-lib.sh"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
[[ -f "$LIB" ]] || { echo "FAIL: config-lib.sh が無い: $LIB"; exit 2; }

# shellcheck source=/dev/null
HOME_BAK="${HOME}"
unset DISPATCH_CONFIG_HOME RUNNERS_CONFIG_PATH
source "$LIB"

# CL1: 既定値
if [[ "$(dispatch_config_home)" == "$HOME_BAK/.claude/config/cmux-team-dispatch-task" ]]; then
  ok 'CL1a: DISPATCH_CONFIG_HOME の既定値'
else
  bad "CL1a: 既定値が違う ($(dispatch_config_home))"
fi
if [[ "$(dispatch_config_file)" == "$(dispatch_config_home)/config.json" ]]; then
  ok 'CL1b: config.json のパス'
else
  bad 'CL1b: config.json のパス'
fi
if [[ "$(dispatch_project_config_file /tmp/repo)" == '/tmp/repo/.dispatch/config.json' ]]; then
  ok 'CL1c: project config のパス'
else
  bad 'CL1c: project config のパス'
fi

# CL1d: env による上書き
( export DISPATCH_CONFIG_HOME=/tmp/cfghome
  source "$LIB"
  [[ "$(dispatch_config_file)" == '/tmp/cfghome/config.json' \
  && "$(dispatch_runners_file)" == '/tmp/cfghome/runners.json' ]] ) \
  && ok 'CL1d: DISPATCH_CONFIG_HOME が両ファイルへ効く' \
  || bad 'CL1d: DISPATCH_CONFIG_HOME が効かない'

# CL2: RUNNERS_CONFIG_PATH は runners.json だけを上書きする
( export DISPATCH_CONFIG_HOME=/tmp/cfghome RUNNERS_CONFIG_PATH=/tmp/other/runners.json
  source "$LIB"
  [[ "$(dispatch_runners_file)" == '/tmp/other/runners.json' \
  && "$(dispatch_config_file)" == '/tmp/cfghome/config.json' ]] ) \
  && ok 'CL2: RUNNERS_CONFIG_PATH は runners.json だけを上書きする' \
  || bad 'CL2: RUNNERS_CONFIG_PATH の作用範囲'

# CL3 / CL4: runner 名と model の拒否条件
reject_cases=( '' ' lead' 'trail ' "quo'te" 'dou"ble' 'back`tick' 'dol$lar' 'back\slash' 'bang!' )
for v in "${reject_cases[@]}"; do
  dispatch_valid_runner_name "$v" && bad "CL3: runner 名 '$v' を受理した"
  dispatch_valid_model "$v" && bad "CL4: model '$v' を受理した"
done
printf -v ctrl 'a\tb'
dispatch_valid_runner_name "$ctrl" && bad 'CL3: 制御文字を含む runner 名を受理した'
dispatch_valid_model "$ctrl" && bad 'CL4: 制御文字を含む model を受理した'
dispatch_valid_runner_name 'ccf' && ok 'CL3: 正常な runner 名を受理する' || bad 'CL3: 正常値を拒否した'
dispatch_valid_model 'opus[1m]' && ok 'CL4a: opus[1m] を受理する' || bad 'CL4a'
dispatch_valid_model 'gpt 5 sol' && ok 'CL4b: 内部空白は許容する' || bad 'CL4b: 内部空白を拒否した'

# CL5: effort の正規化
[[ "$(dispatch_normalize_effort xHigh)" == 'xhigh' ]] && ok 'CL5a: xHigh -> xhigh' || bad 'CL5a'
[[ "$(dispatch_normalize_effort MAX)" == 'max' ]] && ok 'CL5b: MAX -> max' || bad 'CL5b'

# CL6: engine 別 allowlist
dispatch_valid_effort xhigh claude && ok 'CL6a: claude xhigh' || bad 'CL6a'
dispatch_valid_effort max claude && ok 'CL6b: claude max' || bad 'CL6b'
dispatch_valid_effort max codex && bad 'CL6c: codex に max は無いのに受理した' || ok 'CL6c: codex max を拒否する'
dispatch_valid_effort minimal codex && ok 'CL6d: codex minimal' || bad 'CL6d'
dispatch_valid_effort minimal claude && bad 'CL6e: claude に minimal は無いのに受理した' || ok 'CL6e: claude minimal を拒否する'

# CL7: ロール名
if [[ "$(dispatch_role_names | tr '\n' ' ')" == 'design design_review exec exec_review ' ]]; then
  ok 'CL7: ロール名 4 つ'
else
  bad "CL7: ロール名が違う ($(dispatch_role_names | tr '\n' ' '))"
fi

# CL8: 既定値
[[ "$(dispatch_default_model design claude)" == 'opus[1m]' ]] && ok 'CL8a' || bad 'CL8a'
[[ "$(dispatch_default_model exec claude)" == 'sonnet' ]] && ok 'CL8b' || bad 'CL8b'
[[ "$(dispatch_default_model exec_review claude)" == 'opus[1m]' ]] && ok 'CL8c' || bad 'CL8c'
[[ -z "$(dispatch_default_model design codex)" ]] && ok 'CL8d: codex に既定 model は無い' || bad 'CL8d'
[[ "$(dispatch_default_effort design)" == 'xhigh' ]] && ok 'CL8e' || bad 'CL8e'
[[ "$(dispatch_default_effort exec)" == 'high' ]] && ok 'CL8f' || bad 'CL8f'
[[ "$(dispatch_default_effort exec_review)" == 'xhigh' ]] && ok 'CL8g' || bad 'CL8g'

# CL9: model 省略可否
dispatch_model_required design_review codex && ok 'CL9a: codex review は model 必須' || bad 'CL9a'
dispatch_model_required exec_review codex && ok 'CL9b: codex exec_review は model 必須' || bad 'CL9b'
dispatch_model_required design codex && bad 'CL9c: codex design は省略可のはず' || ok 'CL9c: codex design は省略可'
dispatch_model_required exec codex && bad 'CL9d: codex exec は省略可のはず' || ok 'CL9d: codex exec は省略可'

exit $fail
