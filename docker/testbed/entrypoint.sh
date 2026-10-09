#!/usr/bin/env bash
# 51-04 testbed 入口——在 tini 下运行（第 5 层，由 PID 1 回收进程）。让容器 init
# 适合 tmux server（tini 会回收 tmux server 的子进程）；当操作员提供标识时，写入每个容器的
# self-host 身份（计划 §3——51-09 OPENRIG_SELF_HOST_ID 接管路径；N 个容器会作为 N 个
# 名称不同的主机启动）。最后 exec 容器命令。
set -euo pipefail

if [ -n "${OPENRIG_SELF_HOST_ID:-}" ]; then
  # 输出接管的 self-host id，让 `docker logs` 能显示当前模拟的是哪台主机。
  echo "[testbed] self-host-id=${OPENRIG_SELF_HOST_ID}" >&2
fi

exec "$@"
