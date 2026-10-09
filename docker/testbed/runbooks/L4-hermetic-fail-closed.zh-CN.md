# L4——51-02 hermetic 契约在容器内仍然成立（保持 fail-closed，不得弱化）

**在主机侧、完成 L3 后运行。** Hermeticity 的底线是通过构造保证“全新容器 = 全新 HOME”——不挂载真实 HOME 或工作区（L1–L3 中通过不使用 `-v` 的约束验证）。本步骤证明其*主动*部分：即使在容器内，51-02 env helper 仍会**拒绝注入的外部 `OPENRIG_URL`**。不能以“反正已经在容器里”为由削弱 fail-closed 守卫；泄漏进来的后台服务目标必须像主机侧一样被强制拒绝（`DAEMON_TARGET_ENV_VARS` 守卫类别）。

## 断言

当环境中存在外部 `OPENRIG_URL`（不是 helper 自己设置的后台服务目标）时，51-02 hermetic env 准备逻辑必须**强制拒绝**：以非零状态退出，并在拒绝信息中指出外部目标；不能因为位于容器内就静默采用它。主机侧也是相同要求。

## 依据说明（执行时确认，绝不要凭记忆断言）

Helper 的运行位置取决于 51-02 hermetic-env 模块是否包含在镜像安装的 openrig tarball 中。该模块当前位于 `packages/daemon/test/helpers/hermetic-env.ts`，属于测试 helper，可能不在打包集合中：

- **若已打包且可在容器内解析：** 直接在容器内调用断言（L4.1）。
- **若未打包：** 通过 **runner 的容器执行模式（step-3）**验证此步骤。参见 **L6.3**（`L6-container-runner-e2e.md`）：它在 base env 中注入外部目标，驱动一次运行，并由主机侧 hermetic 准备逻辑在创建任何容器前拒绝。将它记录为 L4 的验证形式。

无论选择哪一种，验证都必须真实执行；选择已发布入口实际支持的形式，并明确说明所用形式。

## L4.1——容器内断言（helper 可解析时）

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l4-${GIT_SHA:0:8}"; docker run -d -t --name "${NAME}" "${IMAGE}"

# Inject a foreign daemon target and drive the hermetic prep; expect a LOUD non-zero refusal.
docker exec -e OPENRIG_URL='http://foreign-daemon.invalid:9999' "${NAME}" bash -lc '
  node --input-type=module -e "
    import { prepareHermeticEnv } from \"@openrig/daemon/test/helpers/hermetic-env.js\";
    try { prepareHermeticEnv({ baseEnv: process.env }); console.log(\"NO-REFUSAL\"); process.exit(0); }
    catch (e) { console.error(\"REFUSED: \" + e.message); process.exit(7); }
  "' 2>&1 | tee "${EVID}/L4-refusal.txt"; RC=${PIPESTATUS[0]:-$?}
docker rm -f "${NAME}" >/dev/null
```

**PASS：** 非零退出，并由 `REFUSED:` 指出外部 `OPENRIG_URL`。**FAIL：** 输出 `NO-REFUSAL` 或以 0 退出，说明容器内守卫被削弱。请把 import specifier 调整为 helper 实际发布路径；如果无法解析，切换到 step-3 形式（见依据说明），绝不要凭记忆判为绿色。

## 证据

```bash
{ grep -q 'REFUSED:' "${EVID}/L4-refusal.txt" && echo "VERDICT: PASS — foreign OPENRIG_URL hard-refused inside the container" \
  || echo "VERDICT: FAIL / FORM-DEFERRED — see L4-refusal.txt + the grounding note"; } | tee "${EVID}/L4-verdict.txt"
```
