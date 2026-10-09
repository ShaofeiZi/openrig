// L6 STEP-0——container-mode TOPOLOGY STAGING adapter（pipeline 侧边界）。
//
// 它修复的问题：loader 把 scenario 的 `topology` 解析为主机绝对路径，buildRealDeps 又把它原样
// 转发给容器内后台服务（`zrig up <hostPath>`）。后者在容器内读取该路径并报告难以理解的
// "Source not found"；这与 /root staging 阻塞及可读但不可写阻塞背后使用了同一种
// host-vs-container 路径假设。
//
// METHOD 位于共享模块 testbed-published-daemon.ts（stageTopologyPlan + argv helper，与 runbook
// 共用一个真源）。本文件只负责 pipeline integration，通过注入的 docker seam 驱动 plan step。
// 它暂存 topology 所在目录（fixture 以相对路径引用 culture.md + agents/，所以必须一并带入），
// 并返回 topology 文件的容器内路径，绝不返回主机绝对路径。containerStagePath 会拒绝绝对路径
// 和 '..'，因此主机路径无法泄漏。

import { basename, dirname } from "node:path";
import { stageTopologyPlan } from "./testbed-published-daemon.js";
import type { DockerResult } from "./scenario-container.js";

/**
 * 注入的 docker seam 扩展为可携带 step stdin。带 `stdinFrom`（tar 侧 argv）的 step 运行
 * `tar <stdinFrom>` 并 pipe 到 `docker <argv>`；不带时运行普通 `docker <argv>`。invoker 必须
 * 同时检查 tar exit 和 docker exit，任一失败都返回非零 code。shell pipeline 只报告最后一条命令
 * 的状态，否则 tar 失败而 `docker exec` 成功会掩盖空 stage，形成 false-green。真实主机侧
 * invoker 实现双进程 pipe + 双 exit 检查；VM fake 同时模拟两者，包括 tar 失败/docker 成功。
 */
export type StagingDocker = (args: string[], stdinFrom?: string[]) => Promise<DockerResult>;

/** 明确且带类型的失败。静默 stage/fence 失败正是持续消除的 false-green：空或不可写 stage
 *  表面正常，直到下游三步后的 `zrig up` 报 EACCES。 */
export class ContainerStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerStageError";
  }
}

/**
 * Container-mode `stageTopology`：把主机 topology 文件所在目录暂存到容器 exec-user stage，
 * 再返回 topology 文件的容器内路径。Host-mode 不接此路径，因为主机后台服务直接读取主机路径。
 * 按顺序驱动 plan step（mkdir → extract → fence）；fence 在提取后、路径被消费前执行，因为空
 * stage 会通过简单 read check，否则首个症状会成为下游 EACCES，而不是这里的具名失败。任何
 * 非零 step（包括 fence）都会抛错并传播该 step 的诊断。
 */
export function makeContainerStageTopology(
  container: string,
  docker: StagingDocker,
): (hostTopologyPath: string) => Promise<string> {
  return async (hostTopologyPath: string): Promise<string> => {
    const hostDir = dirname(hostTopologyPath);
    // expectFile = topology basename：fence 断言文件确实到达，而不只是 mkdir 建出的目录；
    // 因此无法表示“什么也没交付”（被掩盖的 tar failure）。
    const plan = stageTopologyPlan({ container, hostDir, name: "topologies", expectFile: basename(hostTopologyPath) });
    for (const step of plan.steps) {
      const res = await docker(step.argv, step.stdinFrom);
      if (res.code !== 0) {
        throw new ContainerStageError(
          `container stage step '${step.label}' failed (exit ${res.code}) in ${container}: ` +
            `${res.stderr || res.stdout || "(no output)"}`,
        );
      }
    }
    // 容器内 topology 路径 = staged dir + topology basename。绝不能是主机绝对路径；
    // plan.stagePath 来自 containerStagePath，它会拒绝 absolute/'..'。
    return `${plan.stagePath}/${basename(hostTopologyPath)}`;
  };
}
