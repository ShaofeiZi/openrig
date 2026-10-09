import type {
  RuntimeAdapter,
  InstalledResource,
  NodeBinding,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  ResolvedStartupFile,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";

/**
 * 基础设施节点的终端 runtime adapter。
 * 所有操作均为空操作——shell 会立即进入交互状态。启动操作（send_text）由启动 orchestrator
 * 处理，而非此 adapter。
 */
export class TerminalAdapter implements RuntimeAdapter {
  readonly runtime = "terminal";

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }

  async project(_plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    return { projected: [], skipped: [], failed: [] };
  }

  async deliverStartup(_files: ResolvedStartupFile[], _binding: NodeBinding): Promise<StartupDeliveryResult> {
    return { delivered: 0, failed: [] };
  }

  async launchHarness(
    _binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (opts.forkSource) {
      return {
        ok: false,
        error: "terminal runtime 没有原生 fork 原语；请移除 terminal member 的 session_source",
      };
    }
    return { ok: true };
  }

  async checkReady(_binding: NodeBinding): Promise<ReadinessResult> {
    return { ready: true };
  }
}
