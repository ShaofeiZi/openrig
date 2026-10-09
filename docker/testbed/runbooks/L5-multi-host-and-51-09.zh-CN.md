# L5——多主机拓扑（一个网络上的 N 个具名 self-host）及 51-09 live-leg 附加验证

**在主机侧、完成 L4 后运行。** 证明计划 §3：N 个容器分别模拟 N 个**具名主机**，通过已发布的 **HTTP host registry** 组合；registry 行指向容器 DNS 名称。每个容器各有一个后台服务和容器本地 DB/HOME，不挂载真实 HOME。唯一共享入口是 Docker 网络。

**51-09 live-leg 附加验证（orch，合并台）：** 同一套双主机环境也是已发布 51-09 冲突/对齐 runbook 的执行环境。拓扑稳定后，在**同一个主机侧会话**中执行 51-09 的两个步骤并返回两套证据。Fixture 与步骤位于 `packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md`：**LEG A** 验证跨主机三段来源戳往返——跨主机发送会把源主机写入发送者身份，`↩ Reply:` 提示又会原样路由回源主机；**LEG B** 验证 founder collision——两台主机上都有同名工作组，收到的签名必须指出来源，回复必须落回源端，而不是本地同名对象。

## L5.1——在同一网络中启动两个具名 self-host

**身份必须读取，绝不能预测（PM 裁定——对身份采用 capture-not-compose）。** self-host ID 由后台服务生成，并保存为永不重写的 singleton。Runbook 从每个容器自己的入口捕获 ID：读取 `/healthz` 中由 `packages/daemon/src/server.ts:589` 输出的 `selfHostId`，随后逐字使用捕获值。绝不预测、硬编码或派生 ID。（`OPENRIG_SELF_HOST_ID` 并不是控制项：`docker/testbed/entrypoint.sh:8` 只会把它输出到 `docker logs`，后台服务根本不读取它。不要重新引入该行为。）

**BIND + BEARER，完全沿用 L3。** L5 要求跨容器 HTTP，因此每个后台服务都必须能从非 loopback 地址访问。使用 L3 已证明的同一组三个耦合部分与同一条不可弱化的守卫规则：显式设置 `OPENRIG_HOST=0.0.0.0`；设置 `OPENRIG_AUTH_BEARER_TOKEN`（`packages/daemon/src/middleware/auth-bearer-token.ts:240-264` 的守卫会拒绝缺少它的非 loopback 绑定）；主机侧探测时使用显式发布端口。Registry 行携带 bearer 指针，即 `--bearer-env` 后的环境变量名称，绝不携带 token 值。

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NET="orig-net-${GIT_SHA:0:8}"; docker network create "${NET}" >/dev/null
TESTBEARER="l5-testbed-$(date +%s)"   # throwaway, container-scoped, never a real credential

for h in H_A H_B; do
  docker run -d -t --name "$h" --hostname "$h" --network "${NET}" \
    -e OPENRIG_HOST=0.0.0.0 \
    -e OPENRIG_AUTH_BEARER_TOKEN="${TESTBEARER}" \
    -e OPENRIG_TESTBED_BEARER_ENV=OPENRIG_AUTH_BEARER_TOKEN \
    "${IMAGE}"
done
for h in H_A H_B; do docker exec "$h" bash -lc 'zrig daemon start && sleep 2 && zrig status || true'; done | tee "${EVID}/L5-start.txt"

# CAPTURE each minted id from its own daemon (adopt-by-read; ids are random per boot).
ID_A="$(docker exec H_A bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
ID_B="$(docker exec H_B bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
printf 'H_A selfHostId=%s\nH_B selfHostId=%s\n' "${ID_A}" "${ID_B}" | tee "${EVID}/L5-selfids.txt"
[ -n "${ID_A}" ] && [ -n "${ID_B}" ] && [ "${ID_A}" != "${ID_B}" ] || { echo "L5.1 FAIL: missing or identical self-host ids"; exit 1; }
```

**PASS：** 两个容器各自在自己的 `/healthz` 上报告非空且不同的 `selfHostId`，且各 ID 在该容器的后台服务重启后保持稳定（51-09 incr 1——singleton 从不重新生成 key）。**FAIL：** 任一 ID 为空、两个 ID 相同，或重启后 ID 变化。

*回读说明（已捕获的产品观察，此处不绕过）：`zrig whoami` 报告席位身份；裸主机容器没有席位，因此无法回答“我是哪台主机”。上面的后台服务入口读取是已发布的替代方式。“声明身份 + 主机回读”的缺口已汇总到 PM 的 identity 系列；本 runbook 使用当前已发布能力。*

## L5.2——通过 HTTP host registry 组合

在 `H_A` 的 host registry 中注册 `H_B`，指向可通过 `${NET}` 访问的容器 DNS 名称 `H_B`：

```bash
# CURRENT grammar (packages/cli/src/commands/host.ts:427-433): --id and --transport are REQUIRED;
# http transport takes --url; the bearer rides as a POINTER (env var NAME), never a value.
# The id is the CAPTURED ${ID_B} — adopt-by-read, never an authored name.
docker exec H_A bash -lc "zrig host add --id '${ID_B}' --transport http --url http://H_B:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && zrig host ls --json" | tee "${EVID}/L5-registry.txt"
```

**PASS：** `H_A` 的 registry 在容器 DNS URL 上列出捕获到的 `${ID_B}`，且探测只能通过该网络抵达 `H_B` 的后台服务。**FAIL：** 无法访问，或解析到网络之外。（执行时应根据已发布 CLI 确认 `zrig host` 的准确 flag 形式；读取 `--json`，不要断言记忆中的字段。）

## L5.3——在本会话执行 51-09 live legs

使用 `H_A`/`H_B` 作为两台主机，端到端遵循已发布 runbook，并将证据保存到此处：

```bash
# Source of truth for the exact seats/fixtures/steps + PASS predicates:
sed -n '1,200p' packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md
# LEG A: cross-host send orch@rig-a -> dev@rig-b --host B; expect From: orch@rig-a@A + verbatim reply lands on H_A.
# LEG B: same-named rig 'shared' on both; expect From: lead@shared@A + reply lands on H_A's lead@shared.
# Capture each received pane + the stored source_session; write to L5-leg-a.txt / L5-leg-b.txt.
```

**PASS：** LEG A 的签名包含 `A`，保存的 `source_session == orch@rig-a@A`，且原样回复落在 `H_A`；LEG B 的签名标出源 `A`，回复落在 `H_A` 的同名对象，而不是 `H_B` 的同名对象。还要包含 51-09 fail-open 对照：停止 `H_A` 的后台服务后，`From:` 降级为两段格式且不崩溃。

## 拆除与证据

```bash
docker rm -f H_A H_B >/dev/null; docker network rm "${NET}" >/dev/null
{ echo "topology: 2 named hosts A/B on ${NET}, registry-composed"; echo "51-09 rider: LEG A + LEG B executed against the testbed containers"; \
  echo "VERDICT: PASS|FAIL — per L5-selfids/registry/leg-a/leg-b captures (verdict on bytes, not memory)"; } | tee "${EVID}/L5-verdict.txt"
```

**约束：** 不挂载真实 HOME；Docker 网络是唯一共享入口；场景字节保持不变。
**Docker 缺口观察（计划 §3）：** 如果事实证明每容器网络身份不足以支撑设计所需的拓扑，这就是裁定要求的具体具名缺口；在重新考虑 Apple 技术栈前，应带证据提交给 PM，绝不要自行安装。
