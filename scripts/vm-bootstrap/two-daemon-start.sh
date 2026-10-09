#!/usr/bin/env bash
# Slice 22（release-0.3.1）—— VM 预览用双 daemon 引导。
#
# 在同一台 VM 里启动两个 OpenRig daemon，状态完全隔离
# （各自独立的 OPENRIG_HOME 目录、不同端口、不同 SQLite 路径），
# 让操作者可以并排对比“空白首装”UI 与“已使用过”的 UI。
#
# 操作者流程（见 <substrate-shared-docs>/openrig-work/conventions/vm-preview/README.md）：
#   1. 准备一台已装 OpenRig CLI 的 Tart VM。
#   2. 运行本脚本。
#   3. 打开两个浏览器标签：
#        http://<vm-ip>:7433  →  空白首装（默认，全新安装体验）
#        http://<vm-ip>:7434  →  已填充（预置 rig 与 qitems，模拟“用过一阵子”的体验）
#   4. 要重置，见本文件底部的“RESET”一节。
#
# 前置条件（运行前由操作者装好）：
#   - PATH 上有 `rig` CLI
#   - Tailscale daemon 已启动，或通过 OPENRIG_HOST 显式绑定 LAN
#     （绑定规则见 auth-bearer-tailscale-trust slice）
#
# 架构说明（forward-fix #1）：CLI 父进程的模块级常量
# （packages/cli/src/daemon-lifecycle.ts 里的 OPENRIG_DIR / STATE_FILE / LOG_FILE）
# 在 import 时从 OPENRIG_HOME 解析。因此每次调用用 `OPENRIG_HOME=<dir> rig daemon start`，
# 即可把“被拉起的 daemon 状态”和“CLI 自身的生命周期记账”（daemon.json、daemon.log）
# 一并隔离到同一目录。早先尝试加 `--openrig-home` 参数后被弃用，因为它只透传给子进程，
# 父进程 CLI 的状态写入仍落在默认的 ~/.openrig。
#
# 幂等性：每个 daemon 的 $OPENRIG_HOME 都有自己的 daemon.json，因此干净关闭后重跑本脚本会
# 重建状态。若某个 daemon 仍在运行，`rig daemon start`（在对应 OPENRIG_HOME 下）会拒绝重复启动。

set -euo pipefail

BLANK_HOME="${BLANK_HOME:-$HOME/.openrig-blank}"
POPULATED_HOME="${POPULATED_HOME:-$HOME/.openrig-populated}"
BLANK_PORT="${BLANK_PORT:-7433}"
POPULATED_PORT="${POPULATED_PORT:-7434}"
FIXTURE_DIR="${FIXTURE_DIR:-$(dirname "$0")/../../packages/daemon/assets/vm-preview-fixtures}"

print_reset_instructions() {
  cat <<EOF
==> 重置（想从干净状态重来时）：
    OPENRIG_HOME=$BLANK_HOME rig daemon stop
    OPENRIG_HOME=$POPULATED_HOME rig daemon stop
    rm -rf $BLANK_HOME $POPULATED_HOME
EOF
}

start_daemon_or_explain_reset() {
  local label="$1"
  local home="$2"
  local port="$3"

  echo "==> 启动 $label daemon（端口 $port）"
  if ! OPENRIG_HOME="$home" rig daemon start \
    --port "$port" \
    --db "$home/openrig.sqlite"; then
    echo
    echo "错误：$label daemon 未启动。若预览 daemon 已在运行，请先清理再重跑：" >&2
    print_reset_instructions >&2
    exit 1
  fi
}

echo "==> VM 预览双 daemon 引导"
echo "    BLANK_HOME=$BLANK_HOME（端口 $BLANK_PORT）"
echo "    POPULATED_HOME=$POPULATED_HOME（端口 $POPULATED_PORT）"
echo "    FIXTURE_DIR=$FIXTURE_DIR"

mkdir -p "$BLANK_HOME" "$POPULATED_HOME"

# 启动空白首装 daemon——原汁原味的首次启动体验。用 OPENRIG_HOME 环境变量
# （而非 CLI 参数）确保被拉起的 daemon 与 CLI 自身的状态写入（daemon.json、daemon.log）
# 都落在 $BLANK_HOME 下。
start_daemon_or_explain_reset "blank-slate" "$BLANK_HOME" "$BLANK_PORT"

# 启动已填充 daemon——与空白 daemon 并排跑，各自有独立 OPENRIG_HOME，互不可见对方状态。
start_daemon_or_explain_reset "populated" "$POPULATED_HOME" "$POPULATED_PORT"

echo
echo "==> 两个 daemon 已就绪。用样例数据给已填充 daemon 播种："
echo "    OPENRIG_HOME=$POPULATED_HOME OPENRIG_PORT=$POPULATED_PORT \\"
echo "      rig up product-team   # 实例化一个样例 rig"
echo
echo "    把 workflow 夹具拷到操作者工作区 specs 目录："
echo "    cp $FIXTURE_DIR/workflows/*.yaml \\"
echo "      \$OPENRIG_WORKSPACE_SPECS_ROOT/workflows/"
echo "      （slice 11 会在 GET /api/specs/library 时自动发现它们）"
echo
echo "==> 操作者 UI 访问："
echo "    空白首装：  http://127.0.0.1:$BLANK_PORT"
echo "    已填充：    http://127.0.0.1:$POPULATED_PORT"
echo
print_reset_instructions
echo
echo "==> 完整流程与扩展方式见 conventions/vm-preview/README.md。"
