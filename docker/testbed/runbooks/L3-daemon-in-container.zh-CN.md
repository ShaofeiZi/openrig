# L3——容器内后台服务（使用容器本地 SQLite 启动；通过已发布端口访问 healthz；`zrig up` 使零 token stub 拓扑稳定）

**在主机侧、完成 L2 后运行。** 此步骤用于验证 stub 载荷，也是在这里最终确定 `docker/testbed/stub-assets.list`（L0.2）：由本次 `zrig up` 稳定运行的准确 stub `rig.yaml`、agent fixture 和 `culture.md`，就是清单的统计范围。由于使用 `runtime: stub`，设计上不会消耗 token。

## 已发布后台服务的操作流程（A/B 两端完全相同）

旧版 runbook 启动了只绑定 LOOPBACK 的后台服务，却通过发布端口进行探测。该端口在结构上不可达，因此两个运行时的探测都失败了（操作员 A/B 回执 `Q2-AB-d121568ad-20260807-host/AB-RESULT.md`，sha256 3433e95f427828ce：Docker curl 52 / Apple curl 56）。无法通过的对照端不能用于判断变量端。下面四项相互关联的机制修复了这个问题；它们都有源码依据，并且必须原样应用到两端。

**(a) BIND ADDRESS——必须显式设置，不能使用默认值。** `packages/daemon/src/index.ts:148` 读取 `OPENRIG_HOST`（别名 `RIGGED_HOST`）；设置后，`:163` 会准确绑定该主机；未设置时，`:167` 默认使用 `127.0.0.1`（检测到 tailscale 时还会绑定 tailscale）。通过发布端口访问容器时，必须设置 `OPENRIG_HOST=0.0.0.0`。

**(b) BEARER——后台服务在此绑定上启动所必需，并且必须单独证明。** `assertBindAuthInvariant`（`packages/daemon/src/middleware/auth-bearer-token.ts:240-264`）对 loopback 和 tailscale 绑定直接放行；其他绑定若未提供非空 `OPENRIG_AUTH_BEARER_TOKEN`，则拒绝启动。这种拒绝体现了产品真实性；操作流程必须满足条件，绝不能绕开它。

**已由源码确认的更正（不要为了匹配错误预期去“修复”探测）：** `/healthz` 直接注册在 app 上（`packages/daemon/src/server.ts:574`），**无需认证**。系统没有全局 auth middleware；`:441` 的 `app.use("*")` 只注入 deps，而 `authBearerTokenMiddleware` 只挂载在六个路由模块中（compaction、hosts、mission-control、rig-policy、sessions、transport）。因此健康探测不需要 Authorization header，也绝不能据此给 bearer 验证打分。Bearer 必须在真正受保护的入口上单独证明：`/api/transport/*` 会保护整个 router（`packages/daemon/src/routes/transport.ts:9`）。两个探测分别证明两个事实：绑定路径与认证路径。

**(c) PORT ALLOCATION——使用显式主机端口，绝不使用 `0`。** Apple `container` 1.2.0 会拒绝 Docker 能接受的临时发布形式（`Error: invalid publish host port range: 0`），这是已经捕获的运行时差异。此流程固定一个显式端口，使两端发布方式完全相同；临时分配并非本次 A/B 要测量的变量。

**(d) PROBE——两端使用逐字节相同的探测。** 探测 1（`/healthz`，无认证）证明发布路径能抵达后台服务；探测 2（携带 bearer 访问受保护路由）证明认证路径。两者都必须记录；只记录探测 1 的 runbook 根本没有验证 bearer。

## 设置（两端只有运行时二进制不同）

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l3-${GIT_SHA:0:8}"
HOSTPORT=19433                      # (c) EXPLICIT — never 0 (Apple 1.2.0 rejects ephemeral)
TESTBEARER="l3-testbed-$(date +%s)" # (b) throwaway, container-scoped, never a real credential
RUNTIME=docker                      # the Apple arm substitutes its CLI here; ALL ELSE IDENTICAL
"${RUNTIME}" run -d -t --name "${NAME}" \
  -p "${HOSTPORT}:7433" \
  -e OPENRIG_HOST=0.0.0.0 \
  -e OPENRIG_AUTH_BEARER_TOKEN="${TESTBEARER}" \
  -e OPENRIG_SELF_HOST_ID=testbed-l3 \
  "${IMAGE}"
```

*Apple 端说明（已记录事实，不是变通方案）：在 Apple 1.2.0 上，带 loopback 限定的发布形式（`127.0.0.1:PORT:7433`）会 reset，而不限定地址的 `PORT:7433` 可用。因此，不限定地址的形式是两端共同使用的唯一发布形式——输入完全相同，不是只给 Apple 的特例。*

## L3.1——后台服务使用容器本地 SQLite 启动，且两个探测均有响应

```bash
"${RUNTIME}" exec "${NAME}" bash -lc 'zrig daemon start && sleep 2 && zrig status || true' | tee "${EVID}/L3-start.txt"
# PROBE 1 — the BIND, unauthenticated by design:
curl -fsS "http://127.0.0.1:${HOSTPORT}/healthz" | tee "${EVID}/L3-healthz.txt"; echo
# PROBE 2 — the AUTH path, on a genuinely guarded router:
curl -sS -o "${EVID}/L3-auth-probe.txt" -w '%{http_code}\n' \
  -X POST "http://127.0.0.1:${HOSTPORT}/api/transport/send" \
  -H "Authorization: Bearer ${TESTBEARER}" -H 'Content-Type: application/json' \
  -d '{"session":"nonexistent@testbed","text":"auth-path probe"}' | tee "${EVID}/L3-auth-code.txt"
# NEGATIVE CONTROL — the same call with NO bearer must be refused:
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "http://127.0.0.1:${HOSTPORT}/api/transport/send" \
  -H 'Content-Type: application/json' -d '{"session":"nonexistent@testbed","text":"x"}' \
  | tee "${EVID}/L3-auth-negative.txt"
"${RUNTIME}" exec "${NAME}" bash -lc 'ls -l "${OPENRIG_HOME:-$HOME/.openrig}"/*.sqlite* 2>/dev/null || find "$HOME" -name "*.sqlite*" 2>/dev/null' | tee "${EVID}/L3-db.txt"
```

**PASS：** 探测 1 在已发布端口返回健康 JSON；探测 2 不返回 401（bearer 已接受；unknown-session 等应用级 4xx 仍可证明认证路径）；负向对照返回 401；且容器内存在本地 SQLite。
**FAIL：** 已发布端口上没有 healthz（绑定错误）、探测 2 返回 401（bearer 路径错误）、负向对照不是 401（守卫未生效）、数据库位于容器外，或挂载了真实 HOME（违反约束）。

## L3.2——`zrig up` 使零 token stub 拓扑稳定

将最小 `runtime: stub` 的 `rig.yaml`（连同 agent fixture 和 culture.md）作为暂存 stub 资源发布；将其复制到容器本地工作区，并通过显式 source 执行 `zrig up`。

**STAGED PAYLOAD PATH——路径嵌套是有意设计。** 构建命令暂存每个清单项时保留完整仓库相对路径（`scripts/build-testbed-image.sh:51-52`：`cp "${REPO_ROOT}/${rel}" "${CONTEXT}/stub-assets/${rel}"`），Dockerfile 再整体复制该 context 目录（`docker/testbed/Dockerfile:52`）。因此三个文件在容器内位于 `/opt/openrig-testbed/stub-assets/docker/testbed/stub-assets/`，而不是 stub-assets 根目录。这层嵌套是关键约束，并非意外：manifest 使用相同相对路径生成逐字节可复现的清单回执（`build-testbed-image.sh:101`）；将暂存结构扁平化会改变 r1 已验证的回执字节。RUNBOOK 应适配真实暂存结构，而暂存方式保持不变。（`51-04-STUB-ASSET-TRIO-REVIEW-VERDICT-review-r1.md` 已准确预判此故障并限定在本 runbook 中，sha-16 为 5d4a8bb1d0a1605b，标记为“Honest forward-flag”；只是此前该说明从未进入正文。）

**EXPLICIT SOURCE——绝不能裸跑 `zrig up`。** `zrig up` 要求一个位置参数（`packages/cli/src/commands/up.ts:77`：`.argument("<source>", "Path to a .yaml rig spec or .rigbundle, or a library name…")`）；不带参数会以 `missing required argument 'source'` 退出，这正是操作员遇到的问题。

```bash
"${RUNTIME}" exec "${NAME}" bash -lc '
  set -e
  STAGED=/opt/openrig-testbed/stub-assets/docker/testbed/stub-assets
  # Pre-flight fence: assert the payload where the build actually stages it. A staging change must
  # fail LOUD here naming the path, never as a downstream "missing required argument".
  [ -f "${STAGED}/rig.yaml" ] || { echo "L3.2 FAIL: no rig.yaml at ${STAGED} — staged payload moved; reconcile the runbook against scripts/build-testbed-image.sh"; ls -R /opt/openrig-testbed/stub-assets | head -40; exit 1; }
  mkdir -p ~/work && cp -r "${STAGED}/." ~/work/
  cd ~/work && zrig up rig.yaml && sleep 3 && zrig ps --json' | tee "${EVID}/L3-topology.txt"
```

**PASS：** stub 席位进入 settled/ready 状态（`runtime: stub`，消耗 0 个 LLM token）。**FAIL：** 拓扑始终无法稳定，或调用了非 stub 运行时。

## 拆除与证据

```bash
"${RUNTIME}" exec "${NAME}" bash -lc 'zrig down || true' ; "${RUNTIME}" rm -f "${NAME}" >/dev/null
{ grep -qi 'health' "${EVID}/L3-healthz.txt" \
    && [ "$(cat "${EVID}/L3-auth-code.txt")" != "401" ] \
    && [ "$(cat "${EVID}/L3-auth-negative.txt")" = "401" ] \
    && echo "VERDICT: PASS — published bind reachable, bearer path proven, negative control refused, stub topology settles" \
  || echo "VERDICT: FAIL — see L3-*.txt"; } | tee "${EVID}/L3-verdict.txt"
```

## 验收门禁（不可协商；请求任何 A/B 重跑前执行）

先只在 **DOCKER** 端运行本流程并证明结果为绿色。无法通过的对照端不能称为对照；在 Docker 基线按本文准确通过前，A/B 始终阻塞。只有到那时，Apple 端才替换 CLI 并运行完全相同的流程。

**说明：** 准确的 `zrig ps` 数据结构和 ready 判定，应在执行时针对已发布的 stub adapter 确认；不要断言记忆中的字段名，而要读取真实的 `--json` 输出。
