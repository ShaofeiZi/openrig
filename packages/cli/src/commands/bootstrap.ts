import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_BOOTSTRAP_TIMEOUT_MS = 120_000;

function logStageDetailErrors(data: Record<string, unknown>) {
  const stages = (data["stages"] as Array<{ stage: string; status: string; detail?: unknown }>) ?? [];
  for (const stage of stages) {
    if (stage.status !== "failed" && stage.status !== "blocked") continue;
    if (!stage.detail || typeof stage.detail !== "object") continue;
    const detail = stage.detail as Record<string, unknown>;
    const nestedErrors = Array.isArray(detail["errors"]) ? detail["errors"] as string[] : [];
    for (const err of nestedErrors) {
      console.error(`  详情：${err}`);
    }
    if (nestedErrors.length === 0 && typeof detail["error"] === "string") {
      console.error(`  详情：${detail["error"]}`);
    }
  }
}

export function bootstrapCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bootstrap").description("根据规格文件引导启动一个工作组");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      printDaemonNotRunning();
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<spec>", "工作组规格 YAML 文件路径")
    .option("--plan", "计划模式——展示经评审的计划但不执行")
    .option("--yes", "自动批准受信任的确定性操作")
    .option("--cwd <path>", "仅本次运行覆盖所有成员的启动工作目录")
    .option("--json", "输出可解析的 JSON")
    .action(async (spec: string, opts: { plan?: boolean; yes?: boolean; cwd?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      // 库名解析：若 spec 看起来像名称（而非路径），则查询库
      let sourceRef = spec;
      const isPath = spec.includes("/") || /\.(ya?ml|rigbundle)$/i.test(spec);
      if (!isPath) {
        try {
          const { resolveLibrarySpec } = await import("./specs.js");
          const entry = await resolveLibrarySpec(client, spec);
          sourceRef = entry.sourcePath;
        } catch (resolveErr) {
          if ((resolveErr as Error).message?.includes("ambiguous")) {
            console.error((resolveErr as Error).message);
            process.exitCode = 1;
            return;
          }
          // 未找到——按原样使用 spec（保持既有行为）
        }
      }

      if (opts.plan) {
        // 计划模式
        const res = await client.post<Record<string, unknown>>("/api/bootstrap/plan", {
          sourceRef,
          cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : undefined,
        });

        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else if (res.status === 200) {
          const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
          console.log("引导启动计划");
          for (const s of stages) {
            console.log(`  ${s.stage}: ${s.status}`);
          }
          const actionKeys = (res.data["actionKeys"] as string[]) ?? [];
          if (actionKeys.length > 0) {
            console.log(`\n  ${actionKeys.length} 个操作等待批准`);
          }
        } else {
          const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
          for (const s of stages) {
            console.log(`  ${s.stage}: ${s.status}`);
          }
          const errors = (res.data["errors"] as string[]) ?? [];
          if (errors.length > 0) {
            for (const e of errors) {
              console.error(`  错误：${e}`);
            }
          } else if (typeof res.data["error"] === "string") {
            console.error(`  错误：${res.data["error"]}`);
          }
          logStageDetailErrors(res.data);
        }
        if (res.status === 409) process.exitCode = 1;
        else if (res.status >= 400) process.exitCode = 2;
        return;
      }

      // 应用模式
      const res = await client.post<Record<string, unknown>>("/api/bootstrap/apply", {
        sourceRef,
        cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : undefined,
        autoApprove: opts.yes ?? false,
      }, { timeoutMs: LONG_RUNNING_BOOTSTRAP_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        const status = res.data["status"] as string;
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        const rigId = res.data["rigId"] as string | undefined;
        if (rigId) console.log(`\n工作组：${rigId}`);
        console.log(`状态：${status}`);

        const errors = (res.data["errors"] as string[]) ?? [];
        if (errors.length > 0) {
          for (const e of errors) {
            console.error(`  错误：${e}`);
          }
        }
        logStageDetailErrors(res.data);
      }

      const resultStatus = (res.data["status"] as string) ?? "";
      if (res.status === 409) {
        process.exitCode = 1; // 被阻止
      } else if (res.status >= 500) {
        process.exitCode = 2; // 失败
      } else if (resultStatus === "partial") {
        process.exitCode = 1; // 部分成功不算干净成功
      }
    });

  return cmd;
}
