#!/usr/bin/env bash
# trace-stamp.sh <seat-dir>——记录当前已执行一次追踪。
set -euo pipefail
touch "${1:?usage: trace-stamp.sh <seat-dir>}/.last-trace"
echo "已标记：$1/.last-trace ($(date '+%Y-%m-%d %H:%M %Z'))"
