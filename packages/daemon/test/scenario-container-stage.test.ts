import { describe, it, expect, vi } from "vitest";
import {
  makeContainerStageTopology,
  ContainerStageError,
  type StagingDocker,
} from "./helpers/scenario-container-stage.js";
import { CONTAINER_STAGE_ROOT } from "./helpers/testbed-published-daemon.js";

// L6 STEP-0——容器模式拓扑暂存驱动器。它通过注入的 docker 接缝执行共享模块计划
//（mkdir → 通过 tar stdin 解压 → fence），返回容器内拓扑路径，绝不返回主机绝对路径。
// fence 以文件为目标（expectFile），因此无法表示“什么也没交付”的情况——例如 tar 失败被掩盖，
// 只留下可读写的空暂存区。测试使用伪 StagingDocker 保持封闭；真实 docker 环节位于主机侧。

const CONTAINER = "c0ffeeb0ba";
const HOST_TOPO = "/host/fixtures/scenarios/topo-stub-baton.yaml";
const STAGE = `${CONTAINER_STAGE_ROOT}/topologies`;

  /** 扩展 docker 接缝（携带 stdin）的记录型替身。`fail(label)` 为指定步骤返回非零退出码，
   *  包括 tar 失败但 docker 成功的情况；真实调用器会检查两者退出码，因此将其暴露为非零 extract，
   *  而 shell 会掩盖该错误。 */
function fakeStagingDocker(fail?: (label: string) => number) {
  const calls: Array<{ args: string[]; stdinFrom?: string[] }> = [];
  const label = (args: string[], stdinFrom?: string[]) =>
    args.includes("mkdir") ? "mkdir" : stdinFrom ? "extract" : "fence";
  const docker: StagingDocker = vi.fn(async (args, stdinFrom) => {
    calls.push({ args, stdinFrom });
    const l = label(args, stdinFrom);
    const code = fail?.(l) ?? 0;
    return { stdout: "", stderr: code ? `boom-${l}` : "", code };
  });
  return { docker, calls };
}

describe("makeContainerStageTopology——将拓扑目录暂存到容器内", () => {
  it("依次执行 mkdir → extract（tar stdin）→ fence，并返回容器内路径", async () => {
    const { docker, calls } = fakeStagingDocker();
    const containerPath = await makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO);

    expect(containerPath).toBe(`${STAGE}/topo-stub-baton.yaml`); // in-container, never the host absolute
    expect(calls.map((c) => (c.args.includes("mkdir") ? "mkdir" : c.stdinFrom ? "extract" : "fence")))
      .toEqual(["mkdir", "extract", "fence"]); // ordering is the contract
    expect(calls[0]!.args).toEqual(["exec", CONTAINER, "mkdir", "-p", STAGE]);
    // extract 通过 stdin 携带 tar 侧 argv——打包主机目录（同级 culture.md、agents/ 一同进入）。
    expect(calls[1]!.args).toEqual(["exec", "-i", CONTAINER, "tar", "-C", STAGE, "-xf", "-"]);
    expect(calls[1]!.stdinFrom).toEqual(["-C", "/host/fixtures/scenarios", "-cf", "-", "."]);
    // fence 断言文件已到达（expectFile），而不只检查 mkdir 创建的目录。
    expect(calls[2]!.args.join(" ")).toContain(`test -r '${STAGE}/topo-stub-baton.yaml'`);
  });

  it("被掩盖的 tar 失败（extract 非零）会具名响亮失败，而非静默留下空暂存区", async () => {
    const { docker } = fakeStagingDocker((l) => (l === "extract" ? 2 : 0));
    await expect(makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO))
      .rejects.toThrow(/stage step 'extract' failed \(exit 2\).*boom-extract/s);
  });

  it("fence 失败（内容未到达）会在 fence 处具名响亮失败，而不是三步之后才失败", async () => {
    const { docker } = fakeStagingDocker((l) => (l === "fence" ? 1 : 0));
    const p = makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO);
    await expect(p).rejects.toThrow(ContainerStageError);
    await expect(p).rejects.toThrow(/stage step 'fence' failed \(exit 1\)/);
  });
});
