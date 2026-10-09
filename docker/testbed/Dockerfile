# 51-04 testbed 镜像（openrig-testbed）——见 IMPL-PLAN §1。由
# scripts/build-testbed-image.sh 在主机侧构建：解析并记录基础镜像摘要、固定 Node 版本、暂存
# stub 资源，再 COPY 本地 openrig pack tarball。其契约要求逐字节可复现：基础镜像固定摘要
#（构建命令拒绝使用浮动 tag）、Node 版本固定，且 openrig 来自当前源码树，绝不从
# npm registry 获取（0.5.1 尚未发布）。镜像层按稳定 -> 易变排序。

# --- 基础层：由构建命令提供、固定摘要的 LTS-slim Linux（docker/testbed/base-image
#     拒绝非 @sha256 引用）。本文件不固化任何浮动 tag。---
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# --- 第 1 层：用户空间 + tmux + git + PTY/进程必需组件 + 原生构建工具链（最稳定）---
# python3/make/g++ 是必需项而非可选项：已锁定的 Q2 打包裁定要求在目标上重新构建
# better-sqlite3（绝不使用预构建/嵌套二进制，否则可能装入错误架构的原生模块）。其安装命令为
# `prebuild-install || node-gyp rebuild`；使用自包含 tarball 时 npm 会执行到这一步，
# prebuild-install 不存在，node-gyp 需要 python3+make+g++ 从源码编译。若缺少这些工具，第 3 层
# 会失败（'prebuild-install: not found' → 'Could not find any Python installation'）。这仅属于
# testbed-image 范围（无需多阶段额外优化——该镜像是一次性测试目标）。
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git tmux tini procps \
      python3 make g++; \
    rm -rf /var/lib/apt/lists/*

# --- 第 2 层：固定 Node 版本（满足 engines 范围——见 scripts/check-engines）---
ARG NODE_VERSION=22.22.1
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      "") echo "TARGETARCH 为空——旧版（非 BuildKit）构建器不会填充它。请显式传入 --build-arg TARGETARCH（build-testbed-image.sh 已这样做），或启用 BuildKit。拒绝默认使用 amd64，以免安装错误架构的 Node。" >&2; exit 1 ;; \
      *) echo "不支持 TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/node.tar.xz; \
    node --version; npm --version

# --- 第 3 层：从本地 pack tarball 安装 OpenRig 包，绝不使用 npm registry ---
ARG OPENRIG_TARBALL
COPY ${OPENRIG_TARBALL} /tmp/openrig.tgz
RUN set -eux; \
    npm install -g /tmp/openrig.tgz; \
    rm -f /tmp/openrig.tgz; \
    rig --version

# --- 第 4 层：stub 运行时资源（设计上零 token；构建命令将其以 ./stub-assets/ 暂存到
#     构建上下文，并通过 deriveStubAssetsHash 将摘要写入 manifest）---
COPY stub-assets/ /opt/openrig-testbed/stub-assets/

# --- 第 5 层：非 root 的 openrig 用户 + 通过 tini 进入适合 tmux server 的 init ---
RUN set -eux; \
    useradd --create-home --shell /bin/bash openrig; \
    mkdir -p /opt/openrig-testbed; \
    chown -R openrig:openrig /opt/openrig-testbed
COPY entrypoint.sh /opt/openrig-testbed/entrypoint.sh
RUN chmod 0755 /opt/openrig-testbed/entrypoint.sh
USER openrig
WORKDIR /home/openrig
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/openrig-testbed/entrypoint.sh"]
CMD ["sleep", "infinity"]
