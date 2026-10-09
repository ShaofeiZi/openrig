#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
DAEMON_DIR="$REPO_ROOT/packages/daemon"
UI_DIR="$REPO_ROOT/packages/ui"
TUI_DIR="$REPO_ROOT/packages/tui"
SUBSTANCE_SURFACE_ROOTS=()

echo "=== OpenRig 打包构建 ==="
echo "仓库根目录：$REPO_ROOT"
echo ""

# 1. 清理上一次的构建产物
echo "[1/6] 清理旧产物..."
rm -rf "$CLI_DIR/daemon" "$CLI_DIR/ui" "$CLI_DIR/tui"

# 2. 构建 daemon
echo "[2/6] 构建 daemon..."
(cd "$DAEMON_DIR" && npm run build)

# 3. 构建 UI
echo "[3/6] 构建 UI..."
(cd "$UI_DIR" && npm run build)

# 4. 构建 TUI
echo "[4/6] 构建 TUI..."
(cd "$TUI_DIR" && npm run build)

# 5. 构建 CLI
echo "[5/6] 构建 CLI..."
(cd "$CLI_DIR" && npm run build)

# 6. 组装：把 daemon + UI + TUI 拷进 CLI 包
echo "[6/6] 组装安装包..."

# OPR.0.4.4.11 FR-6 —— 部署身份戳记。在这里只计算一次（构建时工作区正处于该
# 提交 SHA 上，可得），然后写成编译后的 build-info 模块，分别写进每个包的 dist
# （每包自持的生成模块；仓库里的 src/build-info.ts 仍保持诚实的开发占位）。
# 运行时不做跨包导入。
STAMP_SEMVER="$(node -p "require('$CLI_DIR/package.json').version")"
STAMP_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
# DIRTY 指“构建输入与该提交不一致”，而不是“工作目录里有临时文件”。
# 裸跑 `git status --porcelain` 会把全仓库范围的未跟踪文件都算进来，于是普通临时文件
# （.mcp.json、workspace/、scratch 目录）会让每次在开发机上的构建都被盖成 dirty=true——
# 而脏戳记无法回溯，这就抵消了把运行时钉死到某个提交的意义。未跟踪文件并非被一概忽略
# （packages/*/src 下新出现的 .ts 确实会被编译进来），所以把检查范围限定在构建输入：
# packages/ 或 scripts/ 下的任何改动（无论是否已跟踪）都计入
# （之所以包含 scripts/：build-package.sh 本身就是构建器——它若与提交不一致，产物同样无法从该提交复现）。
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- packages scripts)" ]; then STAMP_DIRTY=true; else STAMP_DIRTY=false; fi
STAMP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "构建身份：${STAMP_SEMVER} (${STAMP_COMMIT}) dirty=${STAMP_DIRTY} at ${STAMP_BUILT_AT}"

write_build_info() {
  cat > "$1" <<EOF
// 由 scripts/build-package.sh 生成 —— 打包时的构建身份戳记。
export const BUILD_INFO = {
  semver: "${STAMP_SEMVER}",
  commit: "${STAMP_COMMIT}",
  dirty: ${STAMP_DIRTY},
  builtAt: "${STAMP_BUILT_AT}",
};
export function stampFields(info = BUILD_INFO) {
  if (!info.commit) return {};
  return { semver: info.semver, commit: info.commit, dirty: info.dirty, builtAt: info.builtAt };
}
EOF
}
write_build_info "$DAEMON_DIR/dist/build-info.js"
write_build_info "$CLI_DIR/dist/build-info.js"

# OPR.0.5.3.7 R2 —— 在打包时生成 canonical skills 的 context-pack 投影
# （写入 $DAEMON_DIR/context-packs；从不提交，每次构建重新生成）。
# 通过 daemon 自带的清单解析器校验——畸形投影在本步就让构建失败，绝不留到服务时才暴露。
# 戳记到构建 semver，使下发的 context-pack 与二进制版本一致。
echo "生成随包 context-pack..."
(cd "$REPO_ROOT" && node scripts/generate-context-packs.mjs --version="$STAMP_SEMVER")

# daemon：dist + assets + specs
mkdir -p "$CLI_DIR/daemon/dist"
cp -r "$DAEMON_DIR/dist/"* "$CLI_DIR/daemon/dist/"

if [ -d "$DAEMON_DIR/assets" ]; then
  cp -r "$DAEMON_DIR/assets" "$CLI_DIR/daemon/assets"
  SUBSTANCE_SURFACE_ROOTS+=("daemon/assets")
fi

if [ -d "$DAEMON_DIR/specs" ]; then
  # OPR.0.5.6.12 LP-7 —— specs 目录整树拷进 npm 产物，因此在拷贝前先扫描真实文件系统输入
  # （含未跟踪的构建输入）。路径安全与清单校验解决其他问题；这里是“拒绝公开内部内容”的底线。
  node "$REPO_ROOT/scripts/check-internal-leak-guard.mjs" \
    --repo "$REPO_ROOT" \
    --rules "$REPO_ROOT/scripts/internal-tokens.generated.json" \
    --mode tree \
    --tree "$DAEMON_DIR/specs"
  cp -r "$DAEMON_DIR/specs" "$CLI_DIR/daemon/specs"
  SUBSTANCE_SURFACE_ROOTS+=("daemon/specs")
fi

# OPR.0.5.3.7 R2 —— 随包的 context-pack 投影（上面刚生成）。daemon 把它注册为一个 `builtin`
# 发现根，相对二进制位置解析（startup.ts: import.meta.dirname/../context-packs -> <cli>/daemon/context-packs），
# 因此 `rig context get` 下发的字节按构造就与 `rig --version` 一致。
if [ -d "$DAEMON_DIR/context-packs" ]; then
  cp -r "$DAEMON_DIR/context-packs" "$CLI_DIR/daemon/context-packs"
  SUBSTANCE_SURFACE_ROOTS+=("daemon/context-packs")
fi

# 指定内容闸门只审查打包器实际暂存的根目录。把这份清单放在产物旁边，而不是在闸门里
# 复制一份源码根列表；npm 自己的 dry-run 文件清单就是完整的扫描面。
node -e '
  const fs = require("fs");
  const [out, ...roots] = process.argv.slice(1);
  if (roots.length === 0) throw new Error("no shippable substance roots were staged");
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, roots: [...new Set(roots)].sort() }, null, 2) + "\n");
' "$CLI_DIR/daemon/substance-surfaces.json" "${SUBSTANCE_SURFACE_ROOTS[@]}"

# 内置策略（OPR.0.4.8.3）：canonical 源码 packages/daemon/policies/builtin/ 随 daemon 一起下发；
# 启动时在 $OPENRIG_HOME/reference/policies/builtin/ 物化只读检查副本
# （与下面参考文档同一条链）。
if [ -d "$DAEMON_DIR/policies" ]; then
  cp -r "$DAEMON_DIR/policies" "$CLI_DIR/daemon/policies"
fi

# 参考文档：把仓库根 docs/reference/ 拷进组装好的包
if [ -d "$REPO_ROOT/docs/reference" ]; then
  mkdir -p "$CLI_DIR/daemon/docs/reference"
  cp -r "$REPO_ROOT/docs/reference/"* "$CLI_DIR/daemon/docs/reference/"
fi

# 更早的构建曾在此放一份未发布的 @openrig/daemon 的打包副本。现在本包直接 import 随包的
# daemon/dist（见下面的重写步骤），因此删除任何残留副本：否则它会遮蔽 packages/cli 下代码的
# 开发工作区链接。
rm -rf "$CLI_DIR/node_modules/@openrig/daemon"

# UI：dist
mkdir -p "$CLI_DIR/ui/dist"
cp -r "$UI_DIR/dist/"* "$CLI_DIR/ui/dist/"

# TUI：dist（CLI 包声明的对外 openrig-tui 命令）
mkdir -p "$CLI_DIR/tui/dist"
cp -r "$TUI_DIR/dist/"* "$CLI_DIR/tui/dist/"

# CLI 与 TUI 以 @openrig/daemon/<subpath> 形式 import daemon 代码。该包并不发布，
# 因此在暂存后的 JS 里把这些说明符重写为上面随包的 daemon/dist 副本（#66）。
# 遇到未映射或未暂存的子路径、以及重写后仍残留的 daemon import 都会让构建失败。
node "$REPO_ROOT/scripts/rewrite-daemon-imports.mjs"

# 汇报
echo ""
echo "=== 安装包组装完成 ==="
echo "CLI dist：        $(find "$CLI_DIR/dist" -name '*.js' | wc -l | tr -d ' ') 个 JS 文件"
echo "Daemon dist：     $(find "$CLI_DIR/daemon/dist" -name '*.js' | wc -l | tr -d ' ') 个 JS 文件"
echo "Daemon assets：   $(find "$CLI_DIR/daemon/assets" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件"
echo "Daemon specs：    $(find "$CLI_DIR/daemon/specs" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件"
echo "Daemon policies： $(find "$CLI_DIR/daemon/policies" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件"
echo "Daemon docs：     $(find "$CLI_DIR/daemon/docs" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件"
echo "UI dist：         $(find "$CLI_DIR/ui/dist" -type f | wc -l | tr -d ' ') 个文件"
echo "TUI dist：        $(find "$CLI_DIR/tui/dist" -type f | wc -l | tr -d ' ') 个文件"
echo ""
echo "可发布：cd packages/cli && npm publish --access public"
