# 51-09 实机验证操作手册与夹具（增量 5——随构建产物发布，在 QA 阶段执行）

本文档为 51-09 的两项实机验证提供可由 QA 执行的操作手册。构建产物会包含这些
夹具和步骤；请由 QA 席位在一个确实未对外暴露的席位上，于实机阶段执行它们
（构建期间不要从构建通道执行，也不要针对实际使用中的席位执行）。

单元级验证已经在增量 1–4b 中完成：持久的 self-id、自身解析 + E1、
注册表对齐、始终添加后缀的 envelope twin + relay guard、写入时与转发时写入
sender triple，以及针对 destination-host 的指导性拒绝。下面这些步骤用于证明相同的行为
能够跨两个真实后台服务端到端成立。

---

## 准备环境（随这些验证步骤一同发布——`topologies/`）

这些验证步骤需要三个真实工作组。相关文件已与本操作手册一同提交（在 2026-08-07
之前并不存在；此前的步骤只引用了未提供的工作组，因此在裸容器中都止步于环境准备阶段）：

| 文件 | 工作组 | 规范席位（`<pod>-<member>@<rig>`） | 主机 |
|---|---|---|---|
| `topologies/rig-a.yaml` | `rig-a` | `orch-main@rig-a` | H_A |
| `topologies/rig-b.yaml` | `rig-b` | `dev-main@rig-b` | H_B |
| `topologies/shared.yaml` | `shared` | `lead-main@shared` | **两台主机** |

**席位名称必须使用派生后的名称。** 会话名称始终为
`deriveCanonicalSessionName(pod, member, rig)` = `<pod>-<member>@<rig>`。像
`orch@rig-a` 这样的单 token 形式（这些步骤最初采用的写法）无法派生，因此下文使用真实的
派生名称。

**字节完全一致是产生冲突的前提——必须断言，绝不能假定。** `shared.yaml` 是复制到两台
主机的同一个文件；本操作手册会在执行验证步骤前通过 hash 校验其一致性。

**请把文件放在产品自身用户可读取的位置。** 镜像通过 `USER openrig`
（`docker/testbed/Dockerfile:61`）声明用户，并通过 `WORKDIR /home/openrig`（`:62`）
声明工作目录，因此默认 `docker exec` 会以 `openrig` 身份运行，而该用户无法穿越 root 的
home 目录。所以必须把夹具放在 openrig 用户自己的 home 目录下；这个 STAGE 与 L3.2 已用 `~/work`
副本证明的运行姿态相同。我们不会为了访问这些文件而以 root 身份执行：后台服务以 `openrig`
身份运行，用 root 执行的探测会测试产品从不使用的用户，还会掩盖本测试环境本应用来暴露的
权限缺陷。

```bash
STAGE=/home/openrig/topologies   # 从结构上保证 openrig 可读取（位于其自己的 home）

# 以产品自身用户的身份投递。`docker cp` 会保留 ROOT 所有权，导致暂存目录可由 `openrig`
# 读取但不可写，而 `zrig up` 的启动前投递会写入暂存目录（AGENTS.md）；因此，由 root
# 拥有的暂存目录会在任何席位存在之前因 EACCES 失败。通过管道把 tar 输入默认
# `docker exec`，文件会以 `openrig` 身份解压，从结构上保证所有权正确；整个过程不需要
# chown，也不在任何位置以 root 身份执行（与探测遵循同一原则：产品以哪个用户运行，
# 就由哪个用户执行工作）。
SRC=packages/daemon/test/fixtures/self-host-live-legs/topologies
for h in H_A H_B; do
  docker exec "$h" mkdir -p "${STAGE}"
  tar -C "${SRC}" -cf - . | docker exec -i "$h" tar -C "${STAGE}" -xf -
done

# 预检围栏——在任何步骤依赖它之前，以执行用户身份验证完整的产品契约。暂存目录不只是被
# 读取：`zrig up` 的启动前投递会写入其中，因此只读暂存目录能够通过读取围栏，却会稍后因
# EACCES 失败。请通过实际执行（真实 touch/rm）探测读写两部分，不要只读取 mode bit——
# 在所有权、ACL 或只读挂载条件下，mode bit 可能产生误导。
for h in H_A H_B; do
  AS="$(docker exec "$h" id -un)"
  docker exec "$h" test -r "${STAGE}/shared.yaml" || {
    echo "ABORT: ${STAGE}/shared.yaml not READABLE as ${AS} on ${h} — image declares USER openrig (Dockerfile:61); stage where that user can read, never exec as root";
    docker exec "$h" ls -la "${STAGE}" 2>&1 | head -20; exit 1; }
  docker exec "$h" sh -c "touch '${STAGE}/.fence-write' && rm -f '${STAGE}/.fence-write'" || {
    echo "ABORT: ${STAGE} not WRITABLE as ${AS} on ${h} — zrig up delivers AGENTS.md into the stage, so a root-owned (docker cp) stage fails EACCES at instantiate; deliver as the exec user (tar-pipe), never chown mid-proof";
    docker exec "$h" ls -lad "${STAGE}" 2>&1; docker exec "$h" ls -la "${STAGE}" 2>&1 | head -20; exit 1; }
done

# 在运行任何验证步骤之前，断言两台主机上的冲突 spec 字节完全一致
SA="$(docker exec H_A sha256sum "${STAGE}/shared.yaml" | cut -d" " -f1)"
SB="$(docker exec H_B sha256sum "${STAGE}/shared.yaml" | cut -d" " -f1)"
[ "$SA" = "$SB" ] || { echo "ABORT: shared.yaml differs across hosts ($SA vs $SB) — the collision premise is void"; exit 1; }

docker exec H_A bash -lc "cd '${STAGE}' && zrig up rig-a.yaml && zrig up shared.yaml"
docker exec H_B bash -lc "cd '${STAGE}' && zrig up rig-b.yaml && zrig up shared.yaml"
```

## SELF-HOST ID——读取后采用（唯一的共享流程）

采用与 L3/L5 相同的身份解析方式：从后台服务自身的接口捕获，绝不预测，也绝不使用
`zrig whoami`（该命令报告席位身份；主机没有席位身份，因此无法回答“我是哪台主机”）：

```bash
ID_A="$(docker exec H_A bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
ID_B="$(docker exec H_B bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
```

下文中的每个 `A`/`B` 都表示已捕获的 `${ID_A}`/`${ID_B}`；这些 id 每次启动时随机生成。

## 注册必须双向进行（两个验证步骤都要跨连接回复）

L5.2 在 H_A 上注册 H_B，使出站发送能够解析。随后，两个验证步骤都要求逐字回复从 H_B
返回 H_A，这需要 H_B 能够解析 H_A。请使用相同的读取后采用流程，以相反方向完成注册；
只进行单向注册会让验证步骤在回复阶段失败，而不是在发送阶段失败。

```bash
# 正向（H_A 知道 H_B）——与 L5.2 一致：
docker exec H_A bash -lc "zrig host add --id '${ID_B}' --transport http --url http://H_B:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && zrig host ls --json"
# 反向（H_B 知道 H_A）——两个验证步骤的回复环节都需要：
docker exec H_B bash -lc "zrig host add --id '${ID_A}' --transport http --url http://H_A:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && zrig host ls --json"
```

## 验证 A——跨主机写入 sender triple：两个 surface、两个 verb

**为什么要拆分此验证步骤（依据 delivery-lock 原文）。** 锁定的 proof contract 第 3 项写道：
*“ALWAYS: send, broadcast, and queue sender surfaces all render the sender triple
member@rig@host unconditionally — local sends included — with the host token in one fixed
deterministic position.”* 它明确点名了三个 surface，因此该属性并非“某处存在一个 identity”，
而是同一个 triple 必须分别出现在每个 surface 上。早期的单步骤版本先执行 `zrig send`
（transport），再断言转发 qitem 中存储的 `source_session`（queue）；它们是由两个不同 verb
访问的两个不同 store。`zrig send` 不会创建 queue 行，因此该断言只能读到零行。
**操作必须与断言匹配：绝不能从渲染后的 terminal envelope 推断 queue record。** 下文分别用
真正写入对应 surface 的 verb 来验证它们。

**夹具：** 来源 `H_A`（`${ID_A}`）、目的地 `H_B`（`${ID_B}`）；`H_A` 上的席位为
`orch-main@rig-a`，`H_B` 上的席位为 `dev-main@rig-b`；两台主机已按上文“注册必须双向进行”
完成双向注册，因为回复环节需要反向记录。

### 验证 A1——TRANSPORT SURFACE（`zrig send`）：渲染后的 envelope + 逐字回复

1. Self-id 来自上文“读取后采用”步骤捕获的 `${ID_A}`/`${ID_B}`，而非 `zrig whoami`
   （后者回答席位身份；主机没有席位身份）。
2. 从 `H_A` 上的 `orch-main@rig-a` 执行：`zrig send dev-main@rig-b "ping" --host B`。
3. 在 `H_B` 上捕获 `dev-main@rig-b` 的 pane。预期看到
   `From: orch-main@rig-a@${ID_A}`——必须是来源主机，绝不能是 `@${ID_B}`。
4. 逐字复制提示 `↩ Reply: zrig send orch-main@rig-a@${ID_A} "..."` 并在 `H_B` 上执行。
   预期它会路由到 `H_A` 并投递给 `orch-main@rig-a`，而不是本地同名对象。

**A1 通过条件：** 渲染后的签名包含 `${ID_A}`；逐字回复落在 `H_A` 上。
**A1 不对 queue 作任何断言**——`zrig send` 不会创建 qitem；声称它创建了 qitem 等同于
从渲染结果推断 store。
**失败开放对照：** 停止 `H_A` 的后台服务，重复步骤 2 → `From:` 降级为两段式，且不崩溃
（C1，增量 3）。

### 验证 A2——QUEUE SURFACE（`zrig queue create --host`）：持久存储的 provenance

锁定项单独点名了 queue sender surface，而只有 queue verb 才会写入 queue 行。请驱动真实的
跨主机 queue 写入，并直接断言该行：

```bash
# 从 H_A 在 H_B 上创建带唯一 body 的 qitem（该 body 是判别项）
export BODY="lega2-$(date +%s)"   # 必须 export：下方 Python 断言从环境中读取该值
docker exec H_A bash -lc "zrig queue create --source orch-main@rig-a --destination dev-main@rig-b --host '${ID_B}' --summary 'leg-a2 provenance' --body '${BODY}'"
# 断言 H_B 上的持久行——检查存储的 identity，而非渲染行
docker exec H_B bash -lc "zrig queue list -A --json" | python3 -c "
import json,sys,os
rows=[q for q in json.load(sys.stdin) if os.environ['BODY'] in (q.get('body') or '')]
assert len(rows)==1, f'expected exactly 1 row for the discriminator, got {len(rows)}'
r=rows[0]; print('sourceSession:', r.get('sourceSession'), '| tags:', r.get('tags'))
"
```

**A2 通过条件：** 恰好一个行匹配该唯一 body；其持久化 `sourceSession` 是包含来源主机的
host-qualified triple（`orch-main@rig-a@${ID_A}`，转发时写入，增量 4a）；已发布的
`from-host:` tag 存在且保持不变（锁定项 6）。
**A2 不对 pane 作任何断言**——envelope 属于 A1 的 surface。

### 验证 A3——BROADCAST SURFACE（`zrig broadcast --host`）：第 3 项点名的第三个 surface

**为何这是实机验证步骤，而不能声称“测试已覆盖”（PM 裁定，经依据核查后反转）。** 先前认为
测试足够，是因为 send 与 broadcast 的渲染似乎通过同一个组合 choke point；但关键路径并非如此：
broadcast 的 `envelopeSender` 由客户端根据原始 env 创作，并会失败开放为字面量
`<unknown sender>`（`packages/cli/src/commands/broadcast.ts:123-124`），其 provenance 路径在类型上
不同于 send。因此，一次实机 send 捕获不能证明 broadcast；也没有 hermetic 测试断言 broadcast
sender triple（检索结果：`pane-envelope.test.ts` / `send-header.test.ts` 中的 broadcast 用例只断言
`To:` scope 行；triple 套件 `self-host-envelope-triple.test.ts` / `-sweep.test.ts` 直接驱动共享
root，未点名 broadcast 用例）。

```bash
# (i) 验证写入路径，而非回退路径：显式设置 sender env。否则容器 exec 可能不携带
# OPENRIG_SESSION_NAME，捕获结果会渲染为 "<unknown sender>"——这测到的是失败开放，
# 而非目标属性，相当于把夹具缺陷伪装成产品缺陷。
export BBODY="lega3-$(date +%s)"
docker exec -e OPENRIG_SESSION_NAME=orch-main@rig-a H_A bash -lc \
  "zrig broadcast --rig rig-b --host '${ID_B}' 'broadcast triple probe ${BBODY}'" | tee "${EVID}/L5-leg-a3-send.txt"

# 捕获 H_B 上 RECIPIENT 的 pane，并断言完整 triple，host token 位于固定位置
docker exec H_B bash -lc "zrig capture dev-main@rig-b" | tee "${EVID}/L5-leg-a3-recv.txt"
grep -q "From: orch-main@rig-a@${ID_A}" "${EVID}/L5-leg-a3-recv.txt" || {
  echo "LEG A3 FAIL: recipient envelope does not carry the ORIGIN triple orch-main@rig-a@${ID_A}"; exit 1; }
grep -q "<unknown sender>" "${EVID}/L5-leg-a3-recv.txt" && {
  echo "LEG A3 FAIL: rendered the FALL-OPEN sender — the capture tested the fallback, not the stamp path (set OPENRIG_SESSION_NAME on the exec)"; exit 1; }
```

**A3 通过条件（逐字引用锁定项 3 作为判定条件）：** 接收方渲染的 envelope 携带 sender triple
`member@rig@host`——即 `orch-main@rig-a@${ID_A}`——*“unconditionally … with the host token in
one fixed deterministic position”*；其中命名的是来源主机，绝不能是 `${ID_B}`，也绝不能是
失败开放字面量。

*P21 CENSUS 观察（仅记录，不作为验证步骤 gate）：broadcast 的 `envelopeSender` 由客户端从
原始 env 创作，并以 `<unknown sender>` 失败开放——这是 body-identity 类中的 census site #14。
本验证步骤固定 env，以测试写入路径；provenance 问题本身属于 P21 的汇总 sweep，不影响本步骤
的 verdict。*


---

## 验证 B——创始人所述冲突（proof item 5，E2 类缺陷的终结验证）

**主张：** 两台主机上存在同名工作组时，收到的签名会命名来源主机，回复也会落到来源主机，
而非本地同名对象。

**夹具：** `H_A`（self-id `A`）与 `H_B`（self-id `B`）上都有一个名为 `shared` 的工作组；
两者各有席位 `lead-main@shared`；`H_A` 已把 `H_B` 注册为 `B`。

**步骤：**
1. 从 `H_A` 上的 `lead-main@shared` 执行：
   `zrig send lead-main@shared "collision test" --host B`。
2. 在 `H_B` 上捕获 `lead-main@shared`。预期看到
   `From: lead-main@shared@${ID_A}`——来源主机能够消除两个同名工作组之间的歧义
   （这正是创始人描述的冲突，现在可以被如实观测）。
3. 在 `H_B` 上逐字执行 `↩ Reply: zrig send lead-main@shared@${ID_A} "..."`。预期它会
   落到 `H_A` 的 `lead-main@shared`（successor/reply 跟随 triple 所命名的主机），而不是
   `H_B` 上同名的 `lead-main@shared`。
4. 反例（D10 诚实范围）：从 `H_B` 执行 `zrig send lead-main@shared "x"`（裸地址，无
   `--host`）→ 在 `H_B` 的 `shared` 中本地生成。这是预期行为，本 slice 不修复它——两段式
   同名歧义只能通过 `--host` / sender 侧 triple 消除；后台服务的指导性拒绝只针对三段式
   `lead-main@shared@X` 触发（`unknown_destination_rig` + "use --host"）。必须在 proof 中
   明确说明：**51-09 让三段式地址诚实可辨并提供指导，但不会神奇地消灭两段式地址的静默生成。**

**通过条件：** 跨主机签名命名来源主机；逐字回复往返到来源主机；D10 反例得到明确记录，
而不是被宣称已经消除。

---

## C5 诚实范围（继承自裁定 c9964404）

origin-host-in-sender-identity slice 使三段式地址无法再静默写入 host-blind addressing
（始终添加后缀的 From: + 回复往返 + 指导性拒绝）。两段式同名静默生成（D10）由
`--host` envelope + sender 侧剥离（增量 3）封闭，而非由字符串内的后台服务解释器封闭。
以上 proof 已明确说明这一点（验证 B 步骤 4）。
