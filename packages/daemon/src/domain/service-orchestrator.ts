import type { RigRepository } from "./rig-repository.js";
import type { ComposeServicesAdapter } from "../adapters/compose-services-adapter.js";
import type { RigServicesSpec, RigServicesRecord, EnvReceipt } from "./types.js";
import { evaluateWaitTargets, deriveEnvHealth } from "./services-readiness.js";

export type ServiceBootResult =
  | { ok: true; receipt: EnvReceipt; health: "healthy" | "degraded" }
  | { ok: false; code: string; error: string; receipt?: EnvReceipt };

export type ServiceTeardownResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

interface ServiceOrchestratorDeps {
  rigRepo: RigRepository;
  composeAdapter: ComposeServicesAdapter;
}

/**
 * 由现有编排器（bootstrap、teardown、restore）调用的叶服务。
 * 不独立管理启动/拆除时机，由调用方决定何时执行。
 */
export class ServiceOrchestrator {
  private rigRepo: RigRepository;
  private composeAdapter: ComposeServicesAdapter;

  constructor(deps: ServiceOrchestratorDeps) {
    this.rigRepo = deps.rigRepo;
    this.composeAdapter = deps.composeAdapter;
  }

  /**
   * 为工作组启动服务，由 bootstrap 编排器在智能体启动前作为一个阶段调用。
   * 1. 加载持久化服务记录
   * 2. 运行 docker compose up
   * 3. 评估等待目标
   * 4. 持久化回执
   */
  async boot(rigId: string, opts?: { waitTimeoutMs?: number; waitPollIntervalMs?: number }): Promise<ServiceBootResult> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) {
      return { ok: false, code: "no_services", error: "未找到此工作组的服务记录" };
    }

    const spec = this.parseSpec(record);
    if (!spec) {
      return { ok: false, code: "invalid_spec", error: "无法解析已持久化的服务规格" };
    }

    // 1. 启动 compose 服务
    const upResult = await this.composeAdapter.up({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });

    if (!upResult.ok) {
      return { ok: false, code: upResult.code, error: upResult.message };
    }

    // 2. 通过轮询评估等待目标
    const waitTargets = spec.waitFor ?? [];
    if (waitTargets.length > 0) {
      const timeoutMs = opts?.waitTimeoutMs ?? 60_000;
      const pollMs = opts?.waitPollIntervalMs ?? 3_000;
      const start = Date.now();

      while (true) {
        // 获取 condition:healthy 目标的当前 compose 状态
        const statusResult = await this.composeAdapter.status({
          composeFile: record.composeFile,
          projectName: record.projectName,
          profiles: spec.profiles,
        });

        if (!statusResult.ok) {
          const elapsed = Date.now() - start;
          if (elapsed + pollMs > timeoutMs) {
            return {
              ok: false,
              code: "compose_status_failed",
              error: statusResult.error ?? "读取 docker compose 状态失败",
            };
          }

          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }

        const waitResults = await evaluateWaitTargets(
          waitTargets,
          this.composeAdapter,
          statusResult.services,
        );

        const health = deriveEnvHealth(waitResults);
        if (health === "healthy") {
          // 所有目标健康：捕获回执并返回
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
          return { ok: true, receipt, health: "healthy" };
        }

        const elapsed = Date.now() - start;
        if (elapsed + pollMs > timeoutMs) {
          // 超时：如实持久化部分回执
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
          const failedTargets = waitResults.filter((r) => r.status !== "healthy");
          const failedNames = failedTargets.map((r) => r.detail ?? JSON.stringify(r.target)).join("; ");
          return { ok: false, code: "wait_timeout", error: `等待 ${Math.round(timeoutMs / 1000)} 秒后服务目标仍不健康：${failedNames}`, receipt };
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    // 没有等待目标：只捕获回执
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });
    if (!statusResult.ok) {
      return {
        ok: false,
        code: "compose_status_failed",
        error: statusResult.error ?? "读取 docker compose 状态失败",
      };
    }
    const receipt = this.buildReceipt(record, statusResult.services, []);
    this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
    return { ok: true, receipt, health: "healthy" };
  }

  /**
   * 为工作组拆除服务，由 teardown 编排器在工作组 down 期间调用。
   * 遵循持久化 spec 中的 down_policy。
   */
  async teardown(rigId: string, opts?: { policyOverride?: "down" | "down_and_volumes" | "leave_running" }): Promise<ServiceTeardownResult> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) {
      return { ok: true }; // 没有服务，无需拆除
    }

    const spec = this.parseSpec(record);
    const policy = opts?.policyOverride ?? spec?.downPolicy ?? "down";

    const result = await this.composeAdapter.down({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
      policy,
    });

    if (!result.ok) {
      return { ok: false, code: result.code, error: result.message };
    }

    // 更新回执以反映拆除结果
    this.rigRepo.updateServicesReceipt(rigId, null);
    return { ok: true };
  }

  /**
   * 从当前 compose 状态捕获新回执，由快照捕获流程调用。
   */
  async captureReceipt(rigId: string): Promise<EnvReceipt | null> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) return null;

    const spec = this.parseSpec(record);
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
    });
    if (!statusResult.ok) {
      throw new Error(statusResult.error ?? "读取 docker compose 状态失败");
    }

    const waitTargets = spec?.waitFor ?? [];
    const waitResults = waitTargets.length > 0
      ? await evaluateWaitTargets(waitTargets, this.composeAdapter, statusResult.services)
      : [];

    const receipt = this.buildReceipt(record, statusResult.services, waitResults);
    this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
    return receipt;
  }

  // -- 私有辅助函数 --

  private parseSpec(record: RigServicesRecord): RigServicesSpec | null {
    try {
      return JSON.parse(record.specJson) as RigServicesSpec;
    } catch {
      return null;
    }
  }

  private buildReceipt(
    record: RigServicesRecord,
    services: Array<{ name: string; state: string; status: string; health: string | null }>,
    waitResults: Array<{ target: import("./types.js").RigServicesWaitTarget; status: string; detail: string | null }>,
  ): EnvReceipt {
    return {
      kind: "compose",
      composeFile: record.composeFile,
      projectName: record.projectName,
      services: services.map((s) => ({ name: s.name, status: s.state, health: s.health })),
      waitFor: waitResults.map((r) => ({
        target: r.target,
        status: r.status as "healthy" | "unhealthy" | "pending",
        detail: r.detail,
      })),
      capturedAt: new Date().toISOString(),
    };
  }
}
