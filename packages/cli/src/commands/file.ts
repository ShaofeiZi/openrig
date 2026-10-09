// OPR.0.4.4.18 — `zrig file`（v0：只提供一个显式动词 copy）。
//
// 每次传输都必须显式写出源、目标与策略：<hostId>:<path> 表示远程
// （解析注册表中的 ssh 条目），纯路径表示本地，绝不从 cwd/环境变量/会话
// 推断任何信息（FR-2）。已存在的目标文件会被覆盖——这是 v0 的复制语义，
// 明确声明（arch R18-2）；--dry-run 是安全护栏。安全校验在
// lib/file-transfer.ts 中实现。

import { Command } from "commander";
import {
  planFileCopy,
  buildRsyncArgv,
  runFileCopy,
  type CopyPlan,
  type PlanDeps,
} from "../lib/file-transfer.js";

export interface FileCommandDeps extends PlanDeps {
  run?: typeof runFileCopy;
}

function operandLabel(side: CopyPlan["src"]): string {
  return side.kind === "remote" ? `${side.host!.id}:${side.path}` : side.path;
}

export function fileCommand(deps: FileCommandDeps = {}): Command {
  const file = new Command("file").description(
    "通过 ssh/rsync 在主机间传输文件（v0：只提供一个显式动词 copy）",
  );

  file
    .command("copy <src> <dst>")
    .description(
      "复制单个文件。<hostId>:<绝对路径> = 远程（ssh 注册表条目）；纯路径 = 本地；含冒号的本地路径需加 ./ 前缀。支持的形式：本地→远程、远程→本地、本地→本地。已存在的目标会被覆盖——请先用 --dry-run 预览。",
    )
    .option("--dry-run", "打印计划中的完整传输信息（源、目标、主机、文件数/字节数），不实际传输")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (src: string, dst: string, opts: { dryRun?: boolean; json?: boolean }) => {
      const planned = planFileCopy(src, dst, { dryRun: opts.dryRun, registryLoader: deps.registryLoader });
      if (!planned.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, code: planned.code, error: planned.error }));
        } else {
          console.error(planned.error);
        }
        process.exitCode = 1;
        return;
      }
      const plan = planned.plan;
      const srcLabel = operandLabel(plan.src);
      const dstLabel = operandLabel(plan.dst);
      const run = deps.run ?? runFileCopy;
      const result = await run(plan);

      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: result.ok,
            dryRun: plan.dryRun,
            src: srcLabel,
            dst: dstLabel,
            failedStep: result.failedStep,
            bytesTransferred: result.bytesTransferred ?? null,
            filesTransferred: result.filesTransferred ?? null,
            exitCode: result.exitCode,
            error: result.ok ? null : result.stderr.trim() || `rsync 失败（${result.failedStep}）`,
            hint: result.hint ?? null,
            rsyncArgv: buildRsyncArgv(plan), // 供智能体核对；参数构造逻辑不对外展开
          }),
        );
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (result.ok) {
        if (plan.dryRun) {
          console.log(`试运行——未传输任何内容。计划传输：`);
          console.log(`  ${srcLabel} → ${dstLabel}`);
          if (result.filesTransferred !== undefined) console.log(`  文件数：${result.filesTransferred}${result.bytesTransferred !== undefined ? `，字节数：${result.bytesTransferred}` : ""}`);
          const itemized = result.stdout.split("\n").filter((l) => /^[<>ch.*][fdLDS]/.test(l));
          for (const line of itemized) console.log(`  ${line}`);
        } else {
          console.log(`已复制 ${srcLabel} → ${dstLabel}${result.bytesTransferred !== undefined ? `（${result.bytesTransferred} 字节）` : ""}`);
        }
        return;
      }
      console.error(`文件复制失败 [${result.failedStep}]：${result.stderr.trim() || `退出码 ${result.exitCode}`}`);
      if (result.hint) console.error(`提示：${result.hint}`);
      process.exitCode = 1;
    });

  return file;
}
