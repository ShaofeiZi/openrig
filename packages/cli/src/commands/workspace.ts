// PL-007 工作区原语——`rig workspace` CLI 接口。
//
// 动词：
//   - `rig workspace validate`（slice-01）——遍历工作区根目录，
//     解析每个 .md 文件的 YAML frontmatter，输出结构化 gap
//     报告。仅供参考——绝不修改。由 curate-steward 消费。
//   - `rig workspace doctor`（slice-21 FR-5；+1 检查 OPR.0.4.4.23）——对后台服务
//     解析出的工作区（或 --workspace 覆盖）跑 8 项工作区就绪诊断。报告状态 + 修复提示。

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
import * as path from "node:path";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface WorkspaceDeps extends StatusDeps {}

interface ValidationGap {
  filePath: string;
  relativePath: string;
  kind: string;
  field: string | null;
  message: string;
  workspaceKind: string | null;
}

interface ValidationReport {
  root: string;
  workspaceKind: string | null;
  totalFiles: number;
  filesWithFrontmatter: number;
  gapCount: number;
  gaps: ValidationGap[];
}

async function withClient<T>(
  deps: WorkspaceDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    printDaemonNotRunning();
    return undefined;
  }
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

// release-0.3.2 slice 01 BC 修复——--max-files 的严格整数校验器。
// 用三段式 fact/consequence/action 错误拒绝 `12abc`、`abc`、`0`、`-1` 等；
// 输入非法时不调用后台服务。合法用例（`10000`、`12` 等）照常通过。
export function parseMaxFilesStrict(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    const err = new Error(
      `--max-files 必须是正整数（收到 "${raw}"）。`,
    ) as Error & { fact: string; consequence: string; action: string };
    err.fact = `--max-files 必须是正整数（收到 "${raw}"）。`;
    err.consequence = "rig workspace validate 未运行；未联系后台服务。";
    err.action = "请传一个正整数，例如 --max-files 10000。";
    throw err;
  }
  return Number.parseInt(raw, 10);
}

function emit3PartError(json: boolean, fact: string, consequence: string, action: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }, null, 2));
  } else {
    process.stderr.write(`错误：${fact}\n${consequence}\n${action}\n`);
  }
  process.exitCode = 1;
}

export function workspaceCommand(depsOverride?: WorkspaceDeps): Command {
  const cmd = new Command("workspace").description(
    "PL-007 工作区原语——带类型的工具。`validate` 遍历根目录并报告 frontmatter gap；`doctor` 跑 8 项工作区就绪诊断。",
  );

  const getDeps = (): WorkspaceDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("validate [root]")
    .description(
      "遍历工作区根目录，解析每个 .md 文件的 YAML frontmatter，输出结构化 gap 报告。仅供参考——绝不修改文件。默认根目录：当前工作目录。",
    )
    .option("--kind <kind>", "要校验的工作区类型：user | project | knowledge | lab | delivery")
    .option("--no-recursive", "不进入子目录")
    .option("--require-frontmatter", "为每个没有 frontmatter 分隔符的 .md 文件报告 gap")
    .option("--max-files <n>", "遍历 .md 文件的硬上限", "10000")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(
      async (
        rootArg: string | undefined,
        opts: {
          kind?: string;
          recursive?: boolean;
          requireFrontmatter?: boolean;
          maxFiles: string;
          json?: boolean;
        },
      ) => {
        // HG-6——在调用后台服务之前做 CLI 侧校验。用三段式错误拒绝
        // 畸形的 --max-files；绝不静默把 `12abc` 强转为 12。
        let maxFiles: number;
        try {
          maxFiles = parseMaxFilesStrict(opts.maxFiles);
        } catch (err) {
          const e = err as Error & { fact?: string; consequence?: string; action?: string };
          emit3PartError(Boolean(opts.json), e.fact ?? e.message, e.consequence ?? "", e.action ?? "");
          return;
        }
        const root = path.resolve(rootArg ?? process.cwd());
        const deps = getDeps();
        await withClient(deps, async (client) => {
          const res = await client.post<ValidationReport>("/api/workspace/validate", {
            root,
            workspaceKind: opts.kind,
            recursive: opts.recursive !== false,
            requireFrontmatter: opts.requireFrontmatter ?? false,
            maxFiles,
          });
          if (res.status >= 400) {
            console.error(JSON.stringify(res.data, null, 2));
            process.exitCode = 1;
            return;
          }
          const report = res.data;
          if (opts.json) {
            console.log(JSON.stringify(report));
          } else {
            renderHumanReport(report);
          }
          // 发现 gap 时以非零退出——操作人员会串接到卫生修复循环里。
          if (report.gapCount > 0) process.exitCode = 1;
        });
      },
    );

  // Slice-21 FR-5——`zrig workspace doctor`。
  cmd
    .command("doctor")
    .description(
      "对后台服务解析出的工作区跑 8 项工作区就绪诊断。报告工作区根目录、任务目标文件夹、文件白名单、后台服务对齐、后台服务重载、slice 文档、任务目标 NOTES、SDLC 约定章节的状态。只读。",
    )
    .option(
      "--workspace <path>",
      "覆盖被检查的工作区（默认：后台服务解析出的已配置根目录）",
    )
    .option("--json", "供智能体使用的 JSON 输出")
    .option(
      "--strict",
      "warn 或 fail 时以非零退出（默认：仅 fail 时非零）",
    )
    .action(async (opts: { workspace?: string; json?: boolean; strict?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const requestBody: { workspaceRoot?: string; filesAllowlistOverride?: string } = {};
        if (opts.workspace) requestBody.workspaceRoot = path.resolve(opts.workspace);
        // FR-5e A2——files.allowlist 的 CLI 侧环境变量覆盖。后台服务在
        // 自己的进程里跑，用自己的 env；在自己 CLI shell 里设置
        // OPENRIG_FILES_ALLOWLIST 的操作人员希望 doctor 结果反映这个覆盖，
        // 即使后台服务的 env 没变。我们照搬 --workspace 覆盖模式：在请求
        // 时读取 env，作为单请求 overlay 转发；后台服务路由把它应用到
        // check #3，source="env"。
        const cliAllowlistEnv = process.env.OPENRIG_FILES_ALLOWLIST;
        if (typeof cliAllowlistEnv === "string" && cliAllowlistEnv.length > 0) {
          requestBody.filesAllowlistOverride = cliAllowlistEnv;
        }
        const res = await client.post<DoctorReport>("/api/workspace/doctor", requestBody);
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        const report = res.data;
        if (opts.json) {
          console.log(JSON.stringify(report));
        } else {
          renderHumanDoctorReport(report);
        }
        // 退出码语义按 FR-5 IMPL-PRD §74：
        //   默认：仅 fail 时非零
        //   --strict：warn 或 fail 时非零
        const hasFail = report.summary.fail > 0;
        const hasWarn = report.summary.warn > 0;
        if (hasFail || (opts.strict && hasWarn)) process.exitCode = 1;
      });
    });

  return cmd;
}

function renderHumanReport(r: ValidationReport): void {
  console.log(`工作区根目录：${r.root}`);
  console.log(`工作区类型：${r.workspaceKind ?? "（无——与类型无关的结构检查）"}`);
  console.log(`遍历文件：   ${r.totalFiles}`);
  console.log(`含 frontmatter：${r.filesWithFrontmatter}`);
  console.log(`gap 数：     ${r.gapCount}`);
  if (r.gapCount === 0) {
    console.log("\n  无 gap——对照 v0 契约，规范是干净的。");
    return;
  }
  console.log("\n  Gap：");
  for (const g of r.gaps) {
    const fieldStr = g.field ? ` [${g.field}]` : "";
    console.log(`    [${g.kind}] ${g.relativePath}${fieldStr}`);
    console.log(`        ${g.message}`);
  }
}

// --- slice-21 FR-5——`rig workspace doctor` 类型 + 人类格式化器 ---
//
// DoctorReport 形状镜像后台服务 runWorkspaceDoctor 的输出，位于
// packages/daemon/src/domain/workspace/workspace-doctor.ts。类型在这里
// 复制一份（不从 daemon 包导入），因为 CLI 没有直接依赖 daemon 包的边；
// HTTP 边界已经强制了 JSON 形状。

interface DoctorCheckResult {
  check: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fixHint?: string;
  evidence?: Record<string, unknown>;
}

interface DoctorReport {
  workspaceRoot: string;
  checks: DoctorCheckResult[];
  summary: { ok: number; warn: number; fail: number };
  daemonResolvedAt: string;
}

const DOCTOR_CHECK_GROUPS: ReadonlyArray<{ category: string; checks: ReadonlyArray<string> }> = [
  { category: "workspace", checks: ["workspace_root_reachable", "file_allowlist_sane"] },
  { category: "missions", checks: ["missions_folder_present", "optional_slice_docs", "mission_notes_presence", "sdlc_convention_sections"] },
  { category: "daemon", checks: ["daemon_points_at_this_workspace", "daemon_reload_needed"] },
];

function statusIcon(status: DoctorCheckResult["status"]): string {
  switch (status) {
    case "ok": return "OK";
    case "warn": return "WARN";
    case "fail": return "FAIL";
  }
}

export function renderHumanDoctorReport(report: DoctorReport): void {
  console.log(`工作区诊断——${report.workspaceRoot}`);
  console.log(`  汇总：${report.summary.ok} 正常，${report.summary.warn} 警告，${report.summary.fail} 失败`);
  console.log("");

  const byName = new Map(report.checks.map((c) => [c.check, c]));
  const remaining = new Set(report.checks.map((c) => c.check));

  for (const group of DOCTOR_CHECK_GROUPS) {
    console.log(`${group.category}:`);
    for (const checkName of group.checks) {
      const c = byName.get(checkName);
      if (!c) continue;
      remaining.delete(checkName);
      console.log(`  [${statusIcon(c.status)}] ${c.check}: ${c.message}`);
      if (c.fixHint) console.log(`        修复：${c.fixHint}`);
    }
    console.log("");
  }

  // 任何不在文档化分组里的检查也照样渲染，这样以后新增检查时，
  // 在分组映射更新之前不会从人类视图里静默消失。
  if (remaining.size > 0) {
    console.log("其他：");
    for (const checkName of remaining) {
      const c = byName.get(checkName);
      if (!c) continue;
      console.log(`  [${statusIcon(c.status)}] ${c.check}: ${c.message}`);
      if (c.fixHint) console.log(`        修复：${c.fixHint}`);
    }
  }
}
