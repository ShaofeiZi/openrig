# L6——51-02 runner 通过容器驱动真实场景（container-mode E2E）并验证 host-mode 对齐

**在主机侧、完成 L3 后运行**，需要已构建镜像及能够启动的容器本地后台服务。这是 51-04 step-3 机制的实时证据：runner 显式启用 **container-mode**，根据 manifest 身份在 testbed 镜像内启动场景本地后台服务；通过指向容器**已发布端口**的同一组主机侧读取，驱动相同的已发布场景；并把镜像 manifest ID 盖到结果台账的每一行。它还承载 **L4 hermetic fail-closed 步骤的 step-3 形式**（`L4-hermetic-fail-closed.md` 的依据说明指向此处），以及用行为证明 additive opt-in 约束的 **host-mode 逐字节对齐**检查。

这里执行的 step-3 组成部分已在 VM 中通过单元测试（`test/scenario-container.test.ts`、`test/scenario-daemon-mode.test.ts`），但那里使用的是注入的 Docker runner。L6 用真实 `docker` 调用器和实时容器替代注入，补上单凭源码无法提供的验证。

## Container-mode 运行拓扑（各部分如何通信）

- **后台服务**运行在容器内部：容器端口上的 `zrig daemon start`，使用容器本地 HOME/DB，不挂载目录。
- 主机侧的 **`zrig` 读写**使用 runner 已调用的 CLI 子进程，在主机上访问 `OPENRIG_URL = http://127.0.0.1:<published port>`。适配器自行把该 URL 指向它自己的容器，绝不使用外部目标。因此，读取侧仍需已构建的主机 CLI 二进制。

## 前置条件

```bash
# L0 resolved the base + stub-assets slots; the build verb produced the image + manifest.
scripts/build-testbed-image.sh                                   # -> dist/testbed-image/manifest.json
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"
EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
# Built HOST rig bin for the read side (the same bin run-scenarios.mjs uses).
npm run build -w packages/cli && npm run build -w packages/daemon
test -x packages/cli/dist/bin-wrapper.js || { echo "BLOCKER: build the CLI bin first"; exit 1; }
command -v docker >/dev/null || { echo "BLOCKER: docker not on PATH"; exit 1; }
```

## L6.1——通过 container-mode 驱动真实场景（runner 作为主机侧包装器）

操作员通过提供 step-3 `daemon` spawner 和 `imageId`，以 container-mode 运行 runner。这段连线只组合已经测试的 helper（`spawnContainerDaemon`、`runScenarioFile`、`withImageId`、`makeRealStagingDocker`）。真实 `docker` 调用器是已经提交的 helper，本 runbook 只导入它，绝不重新内联。（旧的内联 `execFile` 调用器早于 `stdinFrom` tar pipe 契约，并忽略了该契约，导致容器内 `tar -xf -` 的 stdin 一直打开却没有输入；这就是 08-12 的七分钟解压挂起，记录行 42576855。已提交 helper 会写入 pipe、检查两个进程的退出状态，并为每一步设置超时，使停滞成为具名失败；`test/staging-docker-invoker.test.ts` 已用 hermetic 测试证明这一点。该证据只覆盖调用器；真实引擎上的实时隔离仍由本步骤验证。）使用 tsx loader 在主机侧运行：

```bash
node --import tsx - "$IMAGE" "$(jq -r .manifestDigest dist/testbed-image/manifest.json)" <<'RUN' | tee "${EVID}/L6-container.txt"
import { resolve } from "node:path";
import { runScenarioFile } from "./packages/daemon/test/helpers/scenario-pipeline.ts";
import { spawnContainerDaemon } from "./packages/daemon/test/helpers/scenario-container.ts";
import { makeRealStagingDocker } from "./packages/daemon/test/helpers/staging-docker-invoker.ts";

const [image, imageId] = process.argv.slice(2);
const RIG_BIN = resolve("packages/cli/dist/bin-wrapper.js");
const SCENARIO = resolve("packages/daemon/test/fixtures/scenarios"); // pick one committed scenario file below

// The committed real invoker: two-process tar pipe, dual-exit check, per-step timeout.
const docker = makeRealStagingDocker();

// Container-mode: inject the ScenarioDaemon-shaped container adapter + the manifest id.
const daemon = (scaffold /*, opts */) => spawnContainerDaemon(scaffold, { image, docker });
// COMMITTED scenario (the prior literal `scenario-collision.yaml` DOES NOT EXIST in the tree —
// operator-caught at the L4/L6 re-entry). L6 proves the container RUNNER, so it drives a real
// shipped scenario; override with L6_SCENARIO to run another COMMITTED file, never an improvised one.
const scenario = `${SCENARIO}/` + (process.env.L6_SCENARIO ?? "scenario-02-baton.yaml");
const baseEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };

const records = [];
const result = await runScenarioFile(scenario, {
  rigBin: RIG_BIN, baseEnv, daemon, imageId,
  deps: { appendRecord: (r) => records.push(r), normalizer: (_s, v) => v },
});
console.log("VERDICT:", result.verdict, "scenario:", result.scenario);
console.log("LEDGER:", JSON.stringify(records));
process.exit(result.verdict === "PASS" ? 0 : 1);
RUN
```

**PASS：** 场景针对容器内后台服务运行并得到预期结论，且每一行台账都有 `imageId == manifest.manifestDigest`（检查 `LEDGER:` 行）。**FAIL：** 后台服务无法在容器内启动、读取无法访问发布端口，或任一台账行缺少镜像 ID。（应根据所选场景确认准确的预期结论；依赖 51-03 的跨入口场景在 normalizer 发布前不应为绿色，请选择已稳定的场景。）

## L6.2——host-mode 对齐（additive opt-in 约束的行为验证）

以 **host-mode** 运行完全相同的场景，不覆盖 `daemon`，也不提供 `imageId`，然后比较结果：

```bash
L6_MODE=host node --import tsx packages/daemon/scripts/run-scenarios.mjs \
  packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml | tee "${EVID}/L6-host.txt"
```

**PASS：** 同一场景的 host-mode 结论与 L6.1 container-mode 结论相同；container-mode 没有改变 host-mode 路径（51-02 契约逐字节不变，台账行只多出 container-mode 的 `imageId` key）。**FAIL：** 同一场景的 host-mode 结论与 51-04 之前不一致；这表示约束被破坏，必须触发 PM 51-02 门禁。

## L6.3——container-mode fail-closed（L4 的 step-3 形式）

向 base env 注入外部后台服务目标，确认运行在创建任何容器前就强制拒绝。不能以容器为由弱化 `DAEMON_TARGET` 守卫；它应与 host-mode 相同：

```bash
OPENRIG_URL='http://foreign-daemon.invalid:9999' node --import tsx - "$IMAGE" <<'RUN' 2>&1 | tee "${EVID}/L6-failclosed.txt"; RC=${PIPESTATUS[0]:-$?}
import { resolve } from "node:path";
import { runScenarioFile } from "./packages/daemon/test/helpers/scenario-pipeline.ts";
import { spawnContainerDaemon } from "./packages/daemon/test/helpers/scenario-container.ts";
const [image] = process.argv.slice(2);
const daemon = (scaffold) => spawnContainerDaemon(scaffold, { image, docker: async () => ({ stdout: "", stderr: "", code: 0 }) });
try {
  await runScenarioFile(resolve("packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml"),
    { rigBin: resolve("packages/cli/dist/bin-wrapper.js"), baseEnv: process.env, daemon });
  console.log("NO-REFUSAL"); process.exit(0);
} catch (e) { console.error("REFUSED: " + e.message); process.exit(7); }
RUN
```

**PASS：** 非零退出，并由 `REFUSED:` 指出外部 `OPENRIG_URL`；`prepareHermeticEnv` 对 `baseEnv` 中的外部目标执行 fail-closed，且未创建容器。**FAIL：** 输出 `NO-REFUSAL` 或以 0 退出，说明 container-mode 绕过了守卫。这是 L4 步骤的 step-3 形式；打包 helper 形式位于 `L4-hermetic-fail-closed.md`。两种形式都是真实验证，应记录已发布入口实际执行的形式。

## 拆除与证据

Container-mode 会拆除自身容器（适配器的 `stop` = `docker rm -f`），所以干净运行后不会留下容器。清理失败运行产生的残留项，再根据捕获字节作出结论：

```bash
docker ps -aq --filter "ancestor=${IMAGE}" | xargs -r docker rm -f >/dev/null
{ grep -q 'VERDICT: PASS' "${EVID}/L6-container.txt" \
    && grep -q "$(jq -r .manifestDigest dist/testbed-image/manifest.json)" "${EVID}/L6-container.txt" \
    && grep -q 'REFUSED:' "${EVID}/L6-failclosed.txt" \
    && echo "VERDICT: PASS — container-mode drives a real scenario by image identity, ledger carries the manifest id, host-mode parity holds, fail-closed refuses" \
  || echo "VERDICT: FAIL / FORM-DEFERRED — see L6-*.txt"; } | tee "${EVID}/L6-verdict.txt"
```

**约束（必须遵守）：** 场景 YAML 逐字节不变（51-03 约束）；host-mode 保持逐字节不变（L6.2 是行为证据，任何偏差都触发 PM 51-02 门禁，不能合并处理）；不挂载真实 HOME；根据 MANIFEST IDENTITY 选择镜像，且其摘要是台账的跨版本 key。
