#!/usr/bin/env bash
# trace-due.sh <seat-dir> [work-dir ...]
# 对齐追踪的确定性到期检查。到期时以退出码 0 并附原因返回；未到期时以退出码 1 静默返回。
# 空操作路径正是设计重点：调度器可按节奏触发此脚本，但实际操作仍由证据门控；固定节奏追踪
# 已被实证推翻，见 SKILL.md §4。
set -euo pipefail
SEAT_DIR="${1:?usage: trace-due.sh <seat-dir> [work-dir ...]}"; shift || true
STAMP="$SEAT_DIR/.last-trace"
MIN_HOURS="${TRACE_MIN_HOURS:-6}"      # 触发频率绝不高于此值。
FORCE_HOURS="${TRACE_FORCE_HOURS:-72}" # 超过此值后，无论活动情况都到期。
now=$(date +%s)
if [[ ! -f "$STAMP" ]]; then
  # 从未追踪：只有席位出现任何活动时才到期。
  if [[ -n "$(find "$SEAT_DIR" "$@" -type f -newermt '-7 days' -print -quit 2>/dev/null)" ]]; then
    echo "已到期：没有追踪记录，且存在近期活动"; exit 0
  fi
  exit 1
fi
last=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP")  # BSD then GNU; date -r means different things on the two OSes
age_h=$(( (now - last) / 3600 ))
(( age_h < MIN_HOURS )) && exit 1
if (( age_h >= FORCE_HOURS )); then
  echo "已到期：距上次追踪 ${age_h} 小时（强制阈值 ${FORCE_HOURS} 小时）"; exit 0
fi
# 只有标记后累积了有意义的工作才到期。
for d in "$SEAT_DIR" "$@"; do
  if [[ -n "$(find "$d" -type f -newer "$STAMP" ! -name '.last-trace' -print -quit 2>/dev/null)" ]]; then
    echo "已到期：距上次追踪 ${age_h} 小时，且 $d 下有新活动"; exit 0
  fi
done
exit 1
