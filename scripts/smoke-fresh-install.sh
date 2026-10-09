#!/usr/bin/env bash
# OPR.0.4.1.30 —— 全新安装 / 打包冒烟测试（与静态 packaging-deps-mirror 闸门互为经验性补充）。
# 验证已发布 CLI 的全新安装确实能启动 daemon——也就是说，vendored daemon 所需的每个运行时
# 依赖都能从安装目录解析出来，而不只是靠 monorepo hoisting 偶然可见。正是这个闸门当年拦住了
# 0.4.0 的 @hono/node-ws 事故（全新 `npm install -g` 后 `rig daemon start` 因缺依赖失败）。
#
# 请在干净环境里运行：Tart 虚拟机（vm-e2e fresh-install 泳道）或容器（containerized-e2e）。
# 它会隔离 OPENRIG_HOME、daemon 端口与数据库，绝不触碰主机上的 daemon；但真正干净的机器才是
# 它面向的对象。预期用途：release-durability-close（在任何发布/主机升级之前运行）。
#
# 退出 0 = 全新安装能启动一个健康的 daemon。非 0 = 打包/运行时依赖存在缺口。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
DAEMON_PKG="$REPO_ROOT/packages/daemon/package.json"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openrig-fresh-install.XXXXXX")"
PORT="${OPENRIG_SMOKE_PORT:-17555}"
DAEMON_PID=""

cleanup() {
  # 尽力停止隔离出的 daemon，并删除临时目录。绝不触碰主机 daemon——
  # 这个 daemon 跑在隔离的 OPENRIG_HOME + 数据库 + 端口下。
  if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    "${RIG_BIN:-}" daemon stop >/dev/null 2>&1 || kill "${DAEMON_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK}" "${CLI_DIR}"/*.tgz 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "冒烟失败 —— $*" >&2; exit 1; }

echo "[1/5] 构建并打包可发布 CLI（已内含 daemon）..."
bash "$REPO_ROOT/scripts/build-package.sh" >/dev/null
TARBALL="$(cd "$CLI_DIR" && npm pack 2>/dev/null | tail -1)"
[ -f "$CLI_DIR/$TARBALL" ] || fail "npm pack 没有产出 tarball"

echo "[2/5] 把 tarball 装进干净隔离的前缀目录（无开发/monorepo 的 node_modules）..."
mkdir -p "$WORK/install"
( cd "$WORK/install" && npm init -y >/dev/null 2>&1 && npm install "$CLI_DIR/$TARBALL" --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
CLI_INSTALL="$WORK/install/node_modules/@openrig/cli"
[ -d "$CLI_INSTALL" ] || fail "CLI 没有装进干净前缀目录"

echo "[3/5] 校验 daemon 的每个运行时依赖都能从全新安装中解析出来..."
# vendored daemon 从安装目录的 node_modules 解析依赖，每个都必须存在。
node -e '
  const fs = require("fs");
  const path = require("path");
  const daemonDeps = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies || {});
  const from = process.argv[2];
  const missing = daemonDeps.filter((d) => {
    try { require.resolve(d, { paths: [from] }); return false; } catch { return true; }
  });
  if (missing.length) { console.error("UNRESOLVED runtime deps on fresh install: " + missing.join(", ")); process.exit(1); }
  console.log("    all " + daemonDeps.length + " daemon runtime deps resolve (incl. @hono/node-ws)");
' "$DAEMON_PKG" "$CLI_INSTALL" || fail "全新安装缺少某个 daemon 运行时依赖（打包缺口）"

echo "[4/5] 从全新安装启动 daemon（隔离 home/db/端口 :$PORT）..."
export OPENRIG_HOME="$WORK/home"
export RIG_BIN="$CLI_INSTALL/dist/bin-wrapper.js"
mkdir -p "$OPENRIG_HOME"
node "$RIG_BIN" daemon start --port "$PORT" --db "$WORK/state.db" >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

echo "[5/5] 轮询健康状态（有上限）..."
HEALTHY=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then HEALTHY=1; break; fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then break; fi
  sleep 1
done
[ -n "$HEALTHY" ] || { echo "--- daemon.log ---"; cat "$WORK/daemon.log" >&2 || true; fail "daemon 未进入健康状态（全新安装启动失败）"; }

node "$RIG_BIN" daemon stop >/dev/null 2>&1 || kill "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
echo "冒烟通过 —— 全新安装可启动健康 daemon；所有运行时依赖均可解析。"
