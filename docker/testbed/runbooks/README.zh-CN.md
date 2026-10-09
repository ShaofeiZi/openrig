# openrig-testbed 验证 runbook（51-04 step-2，计划 §2）

这些 runbook **在主机侧执行，并由证据定义结果**，沿用 51-09 live-leg 模式。VM 席位没有容器运行时（位置裁定 (a)：主机侧），因此后台服务/操作员通道应在主机侧针对 `scripts/build-testbed-image.sh` 生成的镜像运行它们，并按清单回执纪律返回证据。每个步骤都是脚本化检查，绝不凭记忆断言（正是这条规则发现了 Apple `container` 的错误前提）：执行检查、捕获真实字节，再根据结果判定。

## 步骤

| 步骤 | 证明内容 | Runbook |
|---|---|---|
| L0 | 固定摘要的基础镜像和 stub-assets 清单已解析（构建前置条件） | `L0-resolve-inputs.md` |
| L1 | PTY 分配：`docker run -t` + tmux capture-pane 返回真实字节，resize 能够传递 | `L1-pty-allocation.md` |
| L2 | tmux server 生命周期：脱离后存活、多窗格、send-keys + capture 往返 | `L2-tmux-server-lifecycle.md` |
| L3 | 容器内后台服务：使用容器本地 SQLite 启动，通过已发布端口访问 healthz，`zrig up` 使零 token stub 拓扑稳定 | `L3-daemon-in-container.md` |
| L4 | 51-02 hermetic 契约：env helper 在容器内仍拒绝外部 `OPENRIG_URL`，fail-closed 不因“反正已经在容器中”而弱化 | `L4-hermetic-fail-closed.md` |
| L5 | 多主机：一个 Docker 网络中的 N 个容器充当 N 个不同的具名 self-host，通过已发布的 HTTP host registry 组合（计划 §3）；同时执行 51-09 live-leg | `L5-multi-host-and-51-09.md` |
| L6 | 51-02 runner 的 **container-mode**（step-3）根据 manifest 身份通过容器驱动真实场景，并验证 host-mode 字节不变及 L4 fail-closed step-3 形式；台账记录镜像 manifest ID | `L6-container-runner-e2e.md` |

执行顺序：**L0 → 构建 → L1 → L2 → L3 → L4 → L5**；**L6 在 L3 之后**，因为它只需要已构建镜像、容器内后台服务及供读取侧使用的主机 CLI 二进制。L3 负责实际运行 stub 载荷，并最终确定 `docker/testbed/stub-assets.list`。L4 依赖 51-02 hermetic env helper 存在于打包镜像中（它随 Dockerfile 安装的 openrig 包发布）；若未打包，则通过 L6.3 的 **step-3 形式**验证其 fail-closed 路径。

**51-09 live-leg 附加步骤（orch，合并台）。** Testbed 镜像首次进行多主机运行时，也同时充当 51-09 live-leg 执行器：L5 将容器作为两个具名主机 `H_A`/`H_B` 启动，然后在**同一个主机侧会话**中执行已发布的 51-09 冲突/对齐 runbook：`packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md`（LEG A：跨主机、带三段来源戳的往返；LEG B：同名工作组冲突）。两组都要执行，并返回两套证据。

## 共享约定

**镜像身份。** 所有步骤都根据 manifest 身份，针对构建命令打 tag 的镜像运行：

```bash
GIT_SHA="$(git rev-parse HEAD)"
IMAGE="openrig-testbed:${GIT_SHA}"          # == manifest.image
```

信任某一步骤的结果前，先将运行镜像与生成的 manifest 交叉核对：

```bash
test "$(docker image inspect "${IMAGE}" --format '{{.Id}}')" # exists
cat dist/testbed-image/manifest.json        # the census identity this run is comparable under
```

**证据目录（按清单回执纪律计算哈希）。** 每个步骤把捕获结果和一行 `VERDICT` 写入本次运行的证据目录；然后由操作员对目录计算哈希，使证据可检测篡改，并可跨镜像版本比较：

```bash
EVID="dist/testbed-image/evidence/${GIT_SHA}"
mkdir -p "${EVID}"
# ... leg writes L1-capture.txt, L1-resize.txt, etc. ...
( cd "${EVID}" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "${EVID}.sha256"
```

每个步骤的证据应记录准确命令、捕获字节，以及一行根据观察字节得出的 `VERDICT: PASS|FAIL — <one line>`，绝不能来自记忆。

**约束（对所有步骤均有约束力）。** 不挂载真实 HOME 或真实工作区卷（全新容器 = 全新 HOME 是 hermeticity 底线）；场景字节不变；多主机容器之间唯一共享的入口是 Docker 网络。若某一步骤无法执行检查，应明确报告阻塞项及准确命令和缺失能力，绝不能凭记忆判为绿色。
