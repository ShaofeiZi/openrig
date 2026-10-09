#!/bin/bash
# batch2 隔离 TUI 启动脚本 — 在真实 Terminal.app 中运行
# 隔离 HOME/OPENRIG_HOME，禁止真实 daemon/付费席位/hooks/trust
set -e

export HOME="/Users/bytedance/openrig/batch2/fake-home"
export OPENRIG_HOME="/Users/bytedance/openrig/batch2/fake-home/.openrig"
export OPENRIG_TUI_SOCKET="/Users/bytedance/openrig/batch2/fake-home/.openrig/run/tui-batch2.sock"

# 确保隔离目录存在
mkdir -p "$OPENRIG_HOME/run"

# 设置终端窗口大小：35 行 x 120 列
printf '\e[8;35;120t'
sleep 0.3

cd /Users/bytedance/openrig

# 运行 TUI demo 模式
exec node /Users/bytedance/openrig/packages/tui/dist/main.js --demo --instance batch2
