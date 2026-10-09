#!/usr/bin/env bash
# trunk-diff.sh <root-dir> <state-file> [--name FILE ...]
# 治理拉取循环：渲染子树，与上一次渲染对比，然后更新状态。阅读差异即可更新对变化中拓扑的
# 心智模型，无需读完所有内容，也无需等待别人告知。
set -euo pipefail
ROOT="${1:?usage: trunk-diff.sh <root-dir> <state-file> [--name FILE ...]}"
STATE="${2:?state-file required}"; shift 2
NAMES=("$@"); [[ ${#NAMES[@]} -eq 0 ]] && NAMES=(--name CULTURE.md --name SOP.md --name LEARNED.md --name SPEC.md --name PLAYBOOK.md --name INTENT.md)
HERE="$(cd "$(dirname "$0")" && pwd)"
NEW="$(mktemp)"
python3 "$HERE/compose.py" down "$ROOT" "${NAMES[@]}" | grep -v '^<!-- GENERATED' > "$NEW"
if [[ -f "$STATE" ]]; then
  if diff -u "$STATE" "$NEW"; then echo "── 自上次渲染后无变化 ──"; fi
else
  echo "── 首次渲染（无先前状态）；以完整内容为基线 ──"
fi
mv "$NEW" "$STATE"
