#!/usr/bin/env bash
# 51-04 testbed 镜像构建命令（计划 §1）。在宿主机执行——它需要 docker，而 loci 裁决把容器运行时
# 放在宿主机侧（VM 席位里没有）。基于 digest 锁定的基础镜像，用源码树构建 openrig-testbed:<git-sha>
# （走 npm pack，绝不碰 npm registry；0.5.1 尚未发布），然后经已测试的 node 编排器输出可复现清单
# 与 stub-assets 清点收据。它绝不推送。这里的栅栏由 scripts/build-testbed-image.test.mjs 守护。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTBED_DIR="${REPO_ROOT}/docker/testbed"
BASE_IMAGE_FILE="${TESTBED_DIR}/base-image"
STUB_ASSETS_LIST="${TESTBED_DIR}/stub-assets.list"
OUT_DIR="${1:-${REPO_ROOT}/dist/testbed-image}"

command -v docker >/dev/null 2>&1 || {
  echo "[testbed] 未找到 docker —— 本构建须在宿主机侧运行（loci 裁决），不要在 VM 席位里跑" >&2
  exit 3
}

# --- 从源码树取身份：镜像就构建于这个 git sha，故 gitSha == openrigSha ---
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
IMAGE_TAG="openrig-testbed:${GIT_SHA}"

# --- digest 锁定的基础镜像 —— readBaseImage 会拒绝浮动 tag / 未解析的槽位（即栅栏）---
BASE_IMAGE="$(cd "${REPO_ROOT}" && node -e \
  'import("./scripts/testbed-build-inputs.mjs").then(m => process.stdout.write(m.readBaseImage(process.argv[1]).ref))' \
  "${BASE_IMAGE_FILE}")"

# --- 锁定的 node 版本 —— 唯一来源：Dockerfile 的 ARG 默认值 ---
NODE_VERSION="$(sed -n 's/^ARG NODE_VERSION=\([0-9][0-9.]*\).*/\1/p' "${TESTBED_DIR}/Dockerfile" | head -n1)"

# --- 组装干净的构建上下文：Dockerfile + entrypoint + openrig 包 + 暂存的 stub 资产 ---
CONTEXT="$(mktemp -d)"
trap 'rm -rf "${CONTEXT}"' EXIT
cp "${TESTBED_DIR}/Dockerfile" "${TESTBED_DIR}/entrypoint.sh" "${CONTEXT}/"

# 来自源码树的 OpenRig CLI（绝不来自 npm registry）。先组装可发布的 @openrig/cli
# （build-package.sh 会把 daemon/ui/tui 与 `rig` bin 打进 packages/cli），再打包它。
# 直接打包私有 monorepo 根会得到没有 `bin` 的 openrig@0.5.0——Docker 会“安装成功”，
# 但 `rig --version` 随即以 127 失败（而这个镜像的全部意义就是一个可运行的 rig）。
bash "${REPO_ROOT}/scripts/build-package.sh" >&2
TARBALL_NAME="$(cd "${REPO_ROOT}/packages/cli" && npm pack --silent | tail -n1)"
mv "${REPO_ROOT}/packages/cli/${TARBALL_NAME}" "${CONTEXT}/openrig.tgz"

# 按清点列表里点名的精确 stub 资产集暂存（容忍注释/空行）；同一份列表就是清单做哈希时的清点范围
# （census-scope-match-code-path——不递归重复计数）。
mkdir -p "${CONTEXT}/stub-assets"
while IFS= read -r line; do
  rel="${line%%#*}"; rel="$(echo "${rel}" | tr -d '[:space:]')"
  [ -z "${rel}" ] && continue
  mkdir -p "${CONTEXT}/stub-assets/$(dirname "${rel}")"
  cp "${REPO_ROOT}/${rel}" "${CONTEXT}/stub-assets/${rel}"
done < "${STUB_ASSETS_LIST}"

# 以 JSON 形式给出 stub 资产清单（同样容忍注释的解析），供清单清点使用。
STUB_FILES_JSON="$(node -e \
  'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").split("\n").map(s=>s.replace(/#.*/,"").trim()).filter(Boolean);process.stdout.write(JSON.stringify(l))' \
  "${STUB_ASSETS_LIST}")"

# --- 在宿主机侧解析目标架构并显式传入（对构建器无依赖：在从不自动填 TARGETARCH 构建参数的
# 旧构建器上、以及 BuildKit 上都正确）。遇到未知架构就失败关闭，而不是让 Dockerfile 悄悄默认 amd64——
# 那会把 x64 Node 装进 arm64 镜像，因 Rosetta/ELF 错误而死（退出码 133）。
case "$(uname -m)" in
  x86_64|amd64) TARGETARCH=amd64 ;;
  arm64|aarch64) TARGETARCH=arm64 ;;
  *) echo "[testbed] 无法从 'uname -m'=$(uname -m) 解析出受支持的 TARGETARCH；拒绝构建（静默默认 amd64 会装错架构 Node = 退出 133）" >&2; exit 4 ;;
esac

# --- 构建（宿主机侧）---
docker build \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg NODE_VERSION="${NODE_VERSION}" \
  --build-arg OPENRIG_TARBALL=openrig.tgz \
  --build-arg TARGETARCH="${TARGETARCH}" \
  -t "${IMAGE_TAG}" \
  -f "${CONTEXT}/Dockerfile" \
  "${CONTEXT}"

# --- 效果证明（PM rider——验证“效果”而非“命令”本身；堵住 break #4 那一类：闸门绿了但安装是坏的）。
# 这是 Q2 裁决里“干净目标安装并真正加载 daemon”的效果证明，落成常驻。它必须是容器内加载，而非宿主机
# 干净目录安装：宿主机有 python/make/g++，宿主机装 better-sqlite3 会成功，因而抓不住 break #4——
# 只有无工具链的镜像能抓到。要断言 daemon 确实加载了（better-sqlite3 已绑定），而不只是 `rig` 存在
# （单跑 rig --version 从不打开数据库）。复用已验证的 L3-daemon-in-container 加载序列
# （docker/testbed/runbooks/L3）。坏掉的原生安装会让 `rig daemon start` 在此失败 → set -e → 非 0
# → 构建命令在 A/B 锁定之前就失败。它不是逐 fold 闸门（每个 fold 跑一次 docker build 负担不起）——
# 它搭在 pre-pin 构建命令上；A/B 锁定包要求它必须绿。 ---
echo "[testbed] 效果证明：在容器内加载 daemon（better-sqlite3 必须已构建成功）" >&2
# 经操作者校正的加载序列（照抄自宿主机 RED/GREEN 运行）：不带 kernel 启动，直接打 /healthz 确认就绪
# （确定性——不写死 sleep），再 daemon status；EXIT trap 会停止 daemon，使断言失败时也能清理。
# 坏掉的原生安装会让 `rig daemon start` 在此失败 → set -e → 非 0 → 构建命令在 A/B 锁定之前失败。
docker run --rm "${IMAGE_TAG}" bash -lc 'set -euo pipefail; trap "rig daemon stop >/dev/null 2>&1 || true" EXIT; rig --version; rig daemon start --no-kernel; curl -fsS http://127.0.0.1:7433/healthz; rig daemon status'

# --- 经已测试的 node 编排器输出可复现清单 + 清点收据 ---
INPUTS="$(mktemp)"
node -e \
  'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({gitSha:process.argv[2],openrigSha:process.argv[2],nodeVersion:process.argv[3],baseImagePath:process.argv[4],stubAssetsRoot:process.argv[5],stubAssetFiles:JSON.parse(process.argv[6])}))' \
  "${INPUTS}" "${GIT_SHA}" "${NODE_VERSION}" "${BASE_IMAGE_FILE}" "${CONTEXT}/stub-assets" "${STUB_FILES_JSON}"
node "${REPO_ROOT}/scripts/testbed-emit-manifest.mjs" "${INPUTS}" "${OUT_DIR}"
rm -f "${INPUTS}"

echo "[testbed] 已构建 ${IMAGE_TAG}；清单与清点收据位于 ${OUT_DIR}" >&2
