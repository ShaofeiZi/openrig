import { resolve } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { followInstance } from "./workflow-follow.js";
import {
  composeAttentionRollup,
  renderInstanceList,
  renderInstanceShow,
  renderGraphRevision,
  renderProjectAction,
  renderStatus,
  renderTraceTree,
} from "./workflow-render.js";
import { describeDaemonRejection, formatThreePart } from "./workflow-errors.js";

/**
 * `zrig workflow`——后台服务原生的工作流运行时（PL-004 Phase D）。
 *
 * 由 `/api/workflow` 支撑。只通过后台服务 HTTP API 操作。
 *
 * 按 PRD § L4 Workflow Runtime：workflow spec 以 markdown/YAML 为权威，
 * 后台服务缓存一份 read-through 副本。Owner-as-author + workflow-as-transactional-scribe：
 * owner 闭包 + next-qitem 投影发生在同一后台服务事务里。设计上不可能丢交接。
 */

export interface WorkflowDeps extends StatusDeps {}

async function withClient<T>(
  deps: WorkflowDeps,
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

function printResult(json: boolean, body: unknown, status: number): void {
  if (json) {
    console.log(JSON.stringify(body));
  } else if (status >= 400) {
    // WF3 FR-5：命名的后台服务拒绝在人类模式下渲染房子的 what/why/fix 三段；
    // 不可识别的 body 保留 raw-JSON 兜底。--json（上面）保持 RAW body 逐字节相同；
    // 下面的退出码不变。
    const rejection = describeDaemonRejection(body);
    if (rejection) {
      for (const line of formatThreePart(rejection)) process.stderr.write(`${line}\n`);
    } else {
      console.log(JSON.stringify(body, null, 2));
    }
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

// release-0.3.2 slice 01 GA 打磨——每个变更性 workflow 命令在人类模式下都以
// 三行 what/state/next 摘要结尾，让操作人员不必从 raw JSON 里 grep 结果。
// JSON 模式逐字保留后台服务响应——智能体消费者解析结构化 body，不看人类摘要。
export interface OutcomeSummary {
  what: string;
  state: string;
  next: string;
}

// release-0.3.2 slice 01 BC 修复——project --exit 枚举的运行时校验。
// TypeScript 类型在运行时不强制；没有这个守卫 `--exit banana` 会转发到
// 后台服务 transactional-scribe 面。匹配这个 slice 其他地方用的三段错误形状。
export const PROJECT_EXIT_KINDS = ["handoff", "waiting", "done", "failed"] as const;
export type ProjectExitKind = (typeof PROJECT_EXIT_KINDS)[number];

export function isProjectExitKind(value: unknown): value is ProjectExitKind {
  return typeof value === "string" && (PROJECT_EXIT_KINDS as readonly string[]).includes(value);
}

function emit3PartError(json: boolean, fact: string, consequence: string, action: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }, null, 2));
  } else {
    process.stderr.write(`错误：${fact}\n${consequence}\n${action}\n`);
  }
  process.exitCode = 1;
}

export function printOutcomeSummary(json: boolean, status: number, summary: OutcomeSummary | null): void {
  if (json || !summary || status >= 400) return;
  console.log("");
  console.log(`  做了什么：${summary.what}`);
  console.log(`  状态：    ${summary.state}`);
  console.log(`  下一步：  ${summary.next}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// OPR.0.4.6.FAC1（arch 裁定 2026-07-07）：实例化时建议
//（目前是 spec-default-target.rig 降级到 unbound 的通知）必须大声。
// 永远写 STDERR——即使在 --json 模式结构化 body 已带 `advisories`，
// 把 stdout 管道给消费者的操作人员仍需要看到警告，所以两种模式下都落在 stderr。
// 非致命：绝不设非零退出码。
export function printWorkflowAdvisories(advisories: string[] | undefined): void {
  if (!advisories || advisories.length === 0) return;
  for (const line of advisories) {
    process.stderr.write(`⚠ workflow 建议：${line}\n`);
  }
}

export function workflowCommand(depsOverride?: WorkflowDeps): Command {
  const cmd = new Command("workflow").description(
    "后台服务原生工作流运行时——声明式 spec + transactional-scribe 步骤投影（PL-004 Phase D）",
  );
  const getDeps = (): WorkflowDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("validate <specPath>")
    .description("校验一个 workflow spec 文件（返回结构化 ok/error 报告）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow validate workflows/conveyor-starter.workflow.md
  $ zrig workflow validate ./my-spec.workflow.md --json | jq .ok
`)
    .action(async (specPath: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/workflow/validate", { specPath });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("compile <missionPath>")
    .description("把 project.yaml → mission.yaml → slice.yaml 编译成可检视的生命周期图（只读）")
    .addHelpText("after", "\n失败前先检视 exceptionReadiness：选中的角色、所属配置字段、当前路由或显式 missing/ambiguous/unavailable 证据。这条建议不要求每个未来角色都在线。修正已有运行的源后，用 workflow revise 再用 workflow show 验证采纳。\n")
    .option("--operation-key <key>", "要包含进编译的不透明重放身份")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (missionPath: string, opts: { operationKey?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/workflow/compile", {
          missionPath: resolve(missionPath),
          operationKey: opts.operationKey,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("revise <instanceId>")
    .description("对比编写的和运行中的生命周期图；刻意采纳兼容改动而不重放已完成工作")
    .option("--apply", "应用检视出的兼容提案（默认只读）")
    .option("--expected-version <number>", "检视返回的实例版本")
    .option("--expected-digest <sha256>", "检视返回的编写 digest")
    .option("--operation-key <key>", "检视出的 apply 命令的稳定修订身份")
    .option("--actor-session <session>", "记录此决定的智能体")
    .option("--reason <text>", "计划为什么变了")
    .option("--json", "完整对比或回执")
    .addHelpText("after", "\n从：zrig workflow revise <instance> 开始\n检视返回确切的 apply 命令和恢复 key。兼容修订保留已完成/活动步骤、必需义务和子监护。恢复一个改过的已完成/活动步骤并修订它未启动的后继；不需要盲目 abort/replay。异常路由改动只对未来发生生效；已有异常义务保留其 owner。普通角色和路由保持受保护。超时后用 zrig workflow operation <key> 或重复同一 apply 命令。\n")
    .action(async (instanceId: string, opts: { apply?: boolean; expectedVersion?: string; expectedDigest?: string; operationKey?: string; actorSession?: string; reason?: string; json?: boolean }) => {
      if (opts.apply && (!opts.operationKey || !opts.expectedDigest || opts.expectedVersion === undefined || !opts.actorSession || !opts.reason)) {
        emit3PartError(opts.json ?? false, "需要检视出的修订身份和决定。", "未发送任何修订。", "跑 zrig workflow revise " + instanceId + " 并用它的 apply 命令。");
        return;
      }
      await withClient(getDeps(), async client => {
        const route = "/api/workflow/" + encodeURIComponent(instanceId) + "/revision";
        const res = opts.apply ? await client.post<unknown>(route, {
          expectedVersion: Number(opts.expectedVersion), expectedDigest: opts.expectedDigest,
          operationKey: opts.operationKey, actorSession: opts.actorSession, reason: opts.reason,
        }) : await client.get<unknown>(route);
        if (opts.json || opts.apply || res.status >= 400) printResult(opts.json ?? false, res.data, res.status);
        else for (const line of renderGraphRevision(res.data as Parameters<typeof renderGraphRevision>[0])) console.log(line);
        if (opts.apply) printOutcomeSummary(opts.json ?? false, res.status, {
          what: "修订效果已在 " + opts.operationKey + " 下记录或恢复",
          state: "已有实例、已完成结果和前沿监护保留",
          next: "zrig workflow operation " + opts.operationKey,
        });
      });
    });

  cmd
    .command("operation <key>")
    .description("按稳定 key 恢复一次生命周期创建或修订效果，即使响应丢失或源被编辑后")
    .option("--json", "完整原始回执和当前实例")
    .action(async (key: string, opts: { json?: boolean }) => {
      await withClient(getDeps(), async client => {
        const res = await client.get<unknown>("/api/workflow/operations/" + encodeURIComponent(key));
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("instantiate-lifecycle <missionPath>")
    .description("编译并实例化一个合格的生命周期；用 workflow operation <key> 恢复丢失的响应")
    .requiredOption("--operation-key <key>", "用于精确重放的不透明稳定身份")
    .requiredOption("--root-objective <text>", "本次运行的根目标")
    .requiredOption("--created-by <session>", "创建实例的会话")
    .option("--entry-owner <session>", "覆盖编译出的 entry owner")
    .option("--rig <name>", "把实例绑定到这个工作组")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (missionPath: string, opts: {
      operationKey: string;
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      rig?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instance?: { instanceId?: string; status?: string };
          entryQitemId?: string;
          replayed?: boolean;
          compilation?: { compiledInputDigest?: string };
          advisories?: string[];
        }>("/api/workflow/instantiate-lifecycle", {
          missionPath: resolve(missionPath),
          operationKey: opts.operationKey,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
          targetRig: opts.rig,
        });
        printResult(opts.json ?? false, res.data, res.status);
        printWorkflowAdvisories(res.data?.advisories);
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `${res.data?.replayed ? "重放" : "实例化"}生命周期 ${opts.operationKey}`,
          state: `实例 ${res.data?.instance?.instanceId ?? "?"}；entry ${res.data?.entryQitemId ?? "?"}；digest ${res.data?.compilation?.compiledInputDigest ?? "?"}`,
          next: `检视：zrig workflow show ${res.data?.instance?.instanceId ?? "<instance>"}`,
        });
      });
    });

  cmd
    .command("instantiate <specPath>")
    .description("从 spec 创建一个 workflow 实例 + entry-step qitem")
    .requiredOption("--root-objective <text>", "本次运行的根目标")
    .requiredOption("--created-by <session>", "创建实例的会话（canonical <member>@<rig>）")
    .option("--entry-owner <session>", "覆盖默认 entry-step owner")
    .option("--rig <name>", "把实例绑定到这个工作组（覆盖 spec 的 target.rig 默认；角色解析到这个工作组上的席位）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow instantiate workflows/conveyor.workflow.md \\
      --root-objective "发布 release-0.3.2" \\
      --created-by orch-lead@openrig-velocity

  $ zrig workflow instantiate ./my-spec.workflow.md \\
      --root-objective "跑 dogfood" \\
      --created-by velocity-driver@openrig-velocity \\
      --entry-owner velocity-qa@openrig-velocity --json
`)
    .action(async (specPath: string, opts: {
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      rig?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instanceId?: string;
          entryStepId?: string;
          entryOwnerSession?: string;
          status?: string;
          instance?: { boundRig?: string | null };
          advisories?: string[];
        }>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
          targetRig: opts.rig,
        });
        printResult(opts.json ?? false, res.data, res.status);
        printWorkflowAdvisories(res.data?.advisories);
        const body = res.data ?? {};
        const instanceId = asString(body.instanceId) ?? "(无实例 id)";
        const entryStepId = asString(body.entryStepId);
        const owner = asString(body.entryOwnerSession) ?? opts.entryOwner ?? "(来自 spec 的默认)";
        const boundRig = asString(body.instance?.boundRig ?? undefined);
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已从 ${specPath} 实例化 workflow（实例 ${instanceId}）`,
          state: `${body.status ?? "active"}${boundRig ? `；绑定到工作组 ${boundRig}` : ""}；entry packet ${entryStepId ?? "pending"} 由 ${owner} 持有`,
          next: entryStepId
            ? `检视：zrig workflow show ${instanceId} | 打开 packet：zrig queue show ${entryStepId}`
            : `检视：zrig workflow show ${instanceId}`,
        });
      });
    });

  cmd
    .command("project")
    .description("关闭当前 packet 并投影下一个 step packet（transactional-scribe；一个后台服务事务）")
    .requiredOption("--instance <id>", "Workflow 实例 id")
    .requiredOption("--current-packet <qitem-id>", "要关闭的 qitem（必须在实例前沿上）")
    .requiredOption("--exit <kind>", "关闭退出种类：handoff | waiting | done | failed")
    .requiredOption("--actor-session <session>", "关闭 packet 的会话（owner-as-author）")
    .option("--result-note <text>", "关闭结果备注（审计上下文）")
    .option("--evidence-ref <ref>", "记录归因的进展证据；改动的引用会重置 intentional-wait 提醒")
    .option("--wait-for-proof <scope>", "waiting 时：观察一个 slice proof scope 的当前 attention revision")
    .option("--blocked-on <ref>", "waiting 退出时：阻塞引用（qitem id、gate 名）")
    .option("--next-owner <session>", "覆盖默认下一步 owner")
    .option("--acceptance-candidate <identity>", "类型化验收候选身份（与 verdict 和 evidence-ref 一起用）")
    .option("--acceptance-verdict <verdict>", "类型化验收结论（与 candidate 和 evidence-ref 一起用）")
    .option("--acceptance-evidence-ref <path>", "类型化验收证据路径（与 candidate 和 verdict 一起用）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  # 交接给 spec 的默认下一步
  $ zrig workflow project \\
      --instance WF01ABC \\
      --current-packet QITEM-123 \\
      --exit handoff \\
      --actor-session velocity-driver@openrig-velocity \\
      --result-note "实现转绿；待 review"

  # 干净地关闭本次运行
  $ zrig workflow project --instance WF01ABC --current-packet QITEM-9 \\
      --exit done --actor-session orch-lead@openrig-velocity

  # 阻塞在外部 gate 上
  $ zrig workflow project --instance WF01ABC --current-packet QITEM-4 \\
      --exit waiting --actor-session velocity-qa@openrig-velocity \\
      --blocked-on "founder-gate-2"

  # 同时等一个 slice 的当前结果（不复制 readiness）
  $ zrig workflow project --instance WF01ABC --current-packet QITEM-4 \\
      --exit waiting --actor-session velocity-qa@openrig-velocity \\
      --blocked-on QITEM-3 --wait-for-proof release-example/slices/01-build
`)
    .action(async (opts: {
      instance: string;
      currentPacket: string;
      exit: string;
      actorSession: string;
      resultNote?: string;
      evidenceRef?: string;
      waitForProof?: string;
      blockedOn?: string;
      nextOwner?: string;
      acceptanceCandidate?: string;
      acceptanceVerdict?: string;
      acceptanceEvidenceRef?: string;
      json?: boolean;
    }) => {
      // HG-6——在后台服务调用前运行时校验 --exit 枚举。
      // TypeScript 类型在运行时被擦除；没有这个守卫 `--exit banana`
      // 会转发到 transactional workflow 面。
      if (!isProjectExitKind(opts.exit)) {
        emit3PartError(
          Boolean(opts.json),
          `--exit 必须是 ${PROJECT_EXIT_KINDS.join(" | ")} 之一（收到 "${opts.exit}"）。`,
          "zrig workflow project 未运行；未联系后台服务。",
          `传一个合法的 exit kind。示例：--exit handoff。`,
        );
        return;
      }
      const exitKind: ProjectExitKind = opts.exit;
      if (opts.waitForProof && exitKind !== "waiting") {
        emit3PartError(Boolean(opts.json), "--wait-for-proof 需要 --exit waiting。", "未改变任何 workflow 状态。", "用 waiting 退出和一个确切的 slice proof scope。");
        return;
      }
      const deps = getDeps();
      await withClient(deps, async (client) => {
        let attention: { scope: string; revision: string } | undefined;
        if (opts.waitForProof) {
          const proof = await client.get<{ attention?: { scope: string; revision: string } }>(`/api/proof?scope=${encodeURIComponent(opts.waitForProof)}`);
          if (proof.status >= 400) { printResult(Boolean(opts.json), proof.data, proof.status); return; }
          attention = proof.data?.attention;
          if (!attention) {
            emit3PartError(Boolean(opts.json), "选中的 proof scope 没有 slice attention revision。", "未改变任何 workflow 状态。", "选 rig proof show 显示的某个 slice。");
            return;
          }
        }
        const res = await client.post<{
          closedPacketId?: string;
          nextPacketId?: string;
          nextOwnerSession?: string;
          instanceStatus?: string;
        }>("/api/workflow/project", {
          instanceId: opts.instance,
          currentPacketId: opts.currentPacket,
          exit: exitKind,
          actorSession: opts.actorSession,
          resultNote: opts.resultNote,
          blockedOn: opts.blockedOn,
          closureEvidence: attention !== undefined || opts.evidenceRef !== undefined || opts.acceptanceCandidate !== undefined || opts.acceptanceVerdict !== undefined || opts.acceptanceEvidenceRef !== undefined
            ? {
                ...(attention ? { attention } : {}),
                ...(opts.evidenceRef !== undefined ? { evidence_ref: opts.evidenceRef } : {}),
                ...(opts.acceptanceCandidate !== undefined || opts.acceptanceVerdict !== undefined || opts.acceptanceEvidenceRef !== undefined ? { acceptance: {
                  candidate: opts.acceptanceCandidate,
                  verdict: opts.acceptanceVerdict,
                  evidence_ref: opts.acceptanceEvidenceRef,
                } } : {}),
              }
            : undefined,
          nextOwnerSession: opts.nextOwner,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const closedId = asString(body.closedPacketId) ?? opts.currentPacket;
        const nextId = asString(body.nextPacketId);
        const nextOwner = asString(body.nextOwnerSession) ?? opts.nextOwner ?? "(来自 spec 的默认)";
        const status = body.instanceStatus ?? (opts.exit === "done" ? "completed" : opts.exit === "failed" ? "failed" : "active");
        const whatTail = nextId ? `，并把 ${nextId} 投影给 ${nextOwner}` : (opts.exit === "done" ? "（实例已完成）" : "");
        const nextAction = nextId
          ? `检视：zrig queue show ${nextId}`
          : (opts.exit === "done" || opts.exit === "failed")
            ? `检视：zrig workflow show ${opts.instance}`
            : `等待上游；zrig workflow show ${opts.instance} 监控`;
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已关闭 ${closedId}（${opts.exit}）${whatTail}`,
          state: `实例 ${opts.instance} = ${status}`,
          next: nextAction,
        });
      });
    });

  cmd
    .command("list")
    .description("列出 workflow 实例；可选按状态过滤")
    .option("--status <s>", "按状态过滤（active | waiting | completed | failed | aborted）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow list
  $ zrig workflow list --status active --json
  $ zrig workflow list --status waiting | jq -r '.instances[].instanceId'
`)
    .action(async (opts: { status?: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/workflow/list${qs ? `?${qs}` : ""}`);
        // WF3 FR-2：人类模式渲染表格；--json 逐字节相同（BR-2）。
        if (opts.json || res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const body = res.data as { instances?: unknown[] } | unknown[];
        const rows = (Array.isArray(body) ? body : body?.instances ?? []) as Parameters<typeof renderInstanceList>[0];
        for (const line of renderInstanceList(rows)) console.log(line);
      });
    });

  // 列出缓存的 workflow_specs（不是 instances）。已有的
  // `zrig workflow list` 列 instances；这是检视注册了哪些 spec 的互补面，
  // 包括后台服务启动时附带的任何内置 starter。
  // 内置行在人类输出显示 `(built-in)` 标记，在 JSON 输出带 `isBuiltIn: true` 字段。
  cmd
    .command("specs")
    .description("列出已注册的 workflow spec；内置 starter 标记 (built-in)")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow specs
  $ zrig workflow specs --json | jq '.specs[] | select(.isBuiltIn==false)'
`)
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<{ specs: Array<{
          name: string; version: string; purpose: string | null;
          targetRig: string | null; coordinationTerminalTurnRule: string;
          sourcePath: string; cachedAt: string; isBuiltIn: boolean;
        }> }>("/api/workflow/specs");
        if (opts.json) {
          printResult(true, res.data, res.status);
          return;
        }
        if (res.status >= 400) {
          printResult(false, res.data, res.status);
          return;
        }
        const rows = res.data.specs ?? [];
        if (rows.length === 0) {
          console.log("未注册任何 workflow spec。");
          return;
        }
        // 紧凑人类表格——name、version、source、标记。
        for (const row of rows) {
          const indicator = row.isBuiltIn ? "（内置）" : "";
          console.log(`${row.name} v${row.version}${indicator}`);
          if (row.purpose) console.log(`  用途：${row.purpose.replace(/\n/g, " ").slice(0, 120)}`);
          console.log(`  来源：${row.sourcePath}`);
        }
      });
    });

  cmd
    .command("guidance <instanceId>")
    .description("读取当前选中的 SDLC 教学、原始意图和编写/绑定的出处")
    .option("--packet <id>", "前沿分叉时选当前 packet 监护")
    .option("--component <id>", "选一个生效的选中组件；绝不推断流程阶段")
    .option("--full", "展开完整相关散文和选择；保留编写的警示")
    .option("--json", "结构化 guidance 和来源身份")
    .action(async (instanceId: string, opts: {packet?: string; component?: string; full?: boolean; json?: boolean}) => {
      await withClient(getDeps(), async client => {
        const query = new URLSearchParams();
        if (opts.packet) query.set("packet", opts.packet);
        if (opts.component) query.set("component", opts.component);
        if (opts.full) query.set("full", "true");
        const res = await client.get<{lines: string[]}>("/api/workflow/" + encodeURIComponent(instanceId) + "/guidance?" + query);
        if (opts.json || res.status >= 400) printResult(opts.json ?? false, res.data, res.status);
        else for (const line of res.data.lines) console.log(line);
      });
    });

  cmd
    .command("show <instanceId>")
    .description("显示当前工作、异常 owner 就绪度和已有异常义务")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow show WF01ABC
  $ zrig workflow show WF01ABC --json | jq '{status, exceptionReadiness, exceptionObligations}'

失败前先读异常所有权。一个定义好的普通角色不是选中的异常 owner：
顺着 exceptionReadiness.selection.source 找到所属字段。
注册人类兜底、无匹配和 unavailable 读数是不同的。源修正后检视 workflow revise；
兼容采纳只改变未来异常路由。已有义务保留其 owner 和证据。
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/workflow/${encodeURIComponent(instanceId)}`);
        // WF3 FR-2：人类摘要以状态行为标题；--json 逐字节相同（BR-2）。
        if (opts.json || res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        for (const line of renderInstanceShow(res.data as Parameters<typeof renderInstanceShow>[0])) console.log(line);
      });
    });

  cmd
    .command("trace <instanceId>")
    .description("显示一个 workflow 实例 + 它的 append-only 步骤轨迹（仅审计结论）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  $ zrig workflow trace WF01ABC
  $ zrig workflow trace WF01ABC --json | jq '.trail[] | {step, actor, exit}'
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<{ instance?: unknown; reconciliation?: unknown; trail?: unknown[]; frontier?: unknown[]; failures?: unknown[]; boundaryObligations?: unknown[]; unknowns?: string[] }>(
          `/api/workflow/${encodeURIComponent(instanceId)}/trace`,
        );
        // WF3 FR-2：人类模式渲染每步树（mini-req 2 的一屏条）；--json 逐字节相同（BR-2）。
        if (opts.json || res.status >= 400 || !res.data?.instance) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const instance = {
          ...(res.data.instance as Parameters<typeof renderTraceTree>[0]),
          reconciliation: res.data.reconciliation,
          frontierPackets: res.data.frontier,
          boundaryObligations: res.data.boundaryObligations,
          failureOccurrences: res.data.failures,
          unknowns: res.data.unknowns,
        } as Parameters<typeof renderTraceTree>[0];
        const trail = (res.data.trail ?? []) as Parameters<typeof renderTraceTree>[1];
        for (const line of renderTraceTree(instance, trail)) console.log(line);
      });
    });

  // OPR.0.4.6.WF1 FR-8（G6）：`continue` 改标为它真实的检视语义。
  // 这个 wire 自 Phase D v1 起就是只读 frontier+trail 检视器，
  // 但标签说"Mechanically advance"，摘要打印 "Advanced instance ..."——
  // 标签对 wire 的谎言死在这里。真正的机械 advance 会在没有 owner 真实退出的情况下
  // 铸造一个闭包，违反 owner-as-author + BR-2（project 是唯一 advance 写路径）——
  // 这是 arch 背书的架构，不只是措辞。
  cmd
    .command("continue <instanceId>")
    .description("检视实例当前前沿 + 步骤轨迹（只读；推进通过 'zrig workflow project' 进行）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
只读：报告实例在哪里以及怎么到这里的，让前沿 owner 能诚实地继续。
要真正推进，由 packet OWNER 通过以下方式关闭它：
  $ zrig workflow project --instance <id> --current-packet <qitem> --exit <exit> --actor-session <你>

示例：
  $ zrig workflow continue WF01ABC
  $ zrig workflow continue WF01ABC --json
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instance?: { status?: string; currentFrontier?: string[]; currentStepId?: string | null };
          trail?: unknown[];
          frontier?: Array<{
            packetId: string;
            stepId: string | null;
            ownerSession: string | null;
            queueState: string | null;
            blockedOn: string | null;
            targetedAction: "project" | "route" | "indeterminate";
            acceptance?: {
              candidate: string;
              verdicts: string[];
              evidence_ref: string;
            } | null;
          }>;
          failures?: Array<{
            occurrenceId: string;
            stepId: string;
            status: "unresolved" | "resolved";
            targetedAction: "resume" | "none";
          }>;
          unknowns?: string[];
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/continue`, {});
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const status = body.instance?.status ?? "(未知)";
        const frontier = body.instance?.currentFrontier ?? [];
        const trailLen = body.trail?.length ?? 0;
        const frontierRows = body.frontier ?? [];
        const unresolved = (body.failures ?? []).filter((failure) => failure.status === "unresolved");
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已检视实例 ${instanceId}（只读；未改变状态）`,
          state: `status = ${status}；${frontierRows.length} 个前沿 packet；${unresolved.length} 个未解决失败；trail 行数 = ${trailLen}`,
          next: frontierRows.length === 1 && frontierRows[0]?.targetedAction !== "indeterminate"
            ? `前沿 owner 推进 packet ${frontierRows[0]!.packetId}：${renderProjectAction(instanceId, frontierRows[0]!)}`
            : frontierRows.length > 1 || unresolved.length > 0
              ? `用 zrig workflow show ${instanceId} 选确切的 packet 或失败发生`
              : frontier.length > 0
                ? `前沿绑定不确定；检视：zrig workflow show ${instanceId}`
                : `终态或空前沿——见：zrig workflow trace ${instanceId}`,
        });
      });
    });

  // OPR.0.4.6.WF3 FR-1——follow 动词。两个动词，一个渲染器（workflow-follow.ts）。
  // BR-1 动词诚实：`run` 实例化并跟随；`watch` 只看——都不推进步骤
  //（project 仍是唯一推进路径）。默认以结论作退出码（kubectl 的选择）：
  // completed=0，workflow-failed=3（与已交付的 1=4xx / 2=5xx 传输码区分），
  // 让 `zrig workflow run … && next-thing` 在脚本里诚实。
  cmd
    .command("run <specPath>")
    .description("实例化一个 workflow 并实时跟随到终态（退出码 0 完成 / 3 失败）")
    .requiredOption("--root-objective <text>", "本次运行的根目标")
    .requiredOption("--created-by <session>", "创建实例的会话（canonical <member>@<rig>）")
    .option("--entry-owner <session>", "覆盖默认 entry-step owner")
    .option("--rig <name>", "把实例绑定到这个工作组（覆盖 spec 的 target.rig 默认；角色解析到这个工作组上的席位）")
    .option("--json", "把事件作为 JSON 行流式输出给智能体")
    .addHelpText("after", `
随事件发生流式输出每一步；workflow 到达终态时退出。
退出码：0 = 完成，3 = workflow 失败，1/2 = 传输错误（4xx/5xx）。
如果事件流断开，命令会重连，然后降级为轮询——会宣告，绝不静默冻结。

示例：
  $ zrig workflow run workflows/conveyor.workflow.md \\
      --root-objective "发布它" --created-by orch-lead@my-rig
  $ zrig workflow run ./spec.yaml --root-objective x --created-by a@b --json
`)
    .action(async (specPath: string, opts: {
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      rig?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instanceId?: string;
          instance?: { instanceId?: string };
          advisories?: string[];
        }>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
          targetRig: opts.rig,
        });
        printWorkflowAdvisories(res.data?.advisories);
        // 后台服务返回嵌套的 InstantiateResult 形状（{instance:{instanceId}}）；
        // 也容忍拍平的 {instanceId}（walk 抓到：只读扁平字段曾让 `run`
        // 打印后退出 0 而从不跟随——与 WF-1 rev1-r2 已有 instantiate
        // 摘要打磨注记同款的拍平混淆）。
        const instanceId =
          asString(res.data?.instance?.instanceId) ?? asString(res.data?.instanceId);
        if (res.status >= 400 || !instanceId) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        if (!opts.json) console.log(`● 实例 ${instanceId} 已创建——跟随中`);
        const code = await followInstance(client, instanceId, { json: opts.json ?? false });
        if (code !== 0) process.exitCode = code;
      });
    });

  cmd
    .command("watch <instanceId>")
    .description("挂到一个进行中的实例上并实时跟随（只读；退出码镜像结论）")
    .option("--json", "把事件作为 JSON 行流式输出给智能体")
    .addHelpText("after", `
只读：渲染实例当前状态（快照），然后流式输出实时事件直到终态。
挂到一个已经快跑的实例是安全的——挂载前已关闭的步骤从快照恰好渲染一次。
退出码：0 = 完成，3 = workflow 失败，1/2 = 传输错误。

示例：
  $ zrig workflow watch WF01ABC
  $ zrig workflow watch WF01ABC --json
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const code = await followInstance(client, instanceId, { json: opts.json ?? false });
        if (code !== 0) process.exitCode = code;
      });
    });

  // OPR.0.4.6.WF3 FR-4——唯一的 WF-3 变更操作。BR-1：`route` 路由；
  // 它绝不推进步骤（hop 计数不动；project 仍是唯一推进路径）。异常通道按用法，不按 gate。
  cmd
    .command("route <instanceId>")
    .description("把当前前沿步骤改路由给新 owner（同一步骤，诚实交接闭包；绝不推进）")
    .requiredOption("--to <session>", "新 owner 会话（canonical <member>@<rig>）")
    .requiredOption("--actor-session <session>", "执行改路由的会话（记为出处）")
    .option("--packet <qitem-id>", "要路由的前沿 packet（多于一个活动时必填）")
    .option("--reason <text>", "为什么要改路由这个步骤（记入审计轨迹）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
当一个步骤的 owner 无响应（席位死了、被 compaction）且工作应在新 owner 下
从同一步骤继续时使用。旧 owner 的陈旧关闭尝试此后在结构上被拒绝
（packet_not_on_frontier）。

示例：
  $ zrig workflow route WF01ABC --to dev2-driver@my-rig \\
      --actor-session orch-lead@my-rig --reason "owner 席位死了"
`)
    .action(async (instanceId: string, opts: {
      to: string;
      actorSession: string;
      packet?: string;
      reason?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          stepId?: string | null;
          closedPacketId?: string;
          newPacketId?: string;
          fromSession?: string;
          toSession?: string;
          instanceStatus?: string;
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/route`, {
          toSession: opts.to,
          packetId: opts.packet,
          actorSession: opts.actorSession,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已把步骤 ${body.stepId ?? "?"} 从 ${body.fromSession ?? "?"} 改路由给 ${body.toSession ?? opts.to}（packet ${body.closedPacketId ?? "?"} → ${body.newPacketId ?? "?"}）`,
          state: `实例 ${instanceId} = ${body.instanceStatus ?? "active"}；同一步骤，新 owner；未推进任何步骤`,
          next: `新 owner 通过以下方式推进：zrig workflow project --instance ${instanceId} --current-packet ${body.newPacketId ?? "<packet>"} --exit <exit> --actor-session ${opts.to}`,
        });
      });
    });

  // OPR.0.4.6.WF5 FR-4——resume：从失败步骤重新驱动一个 FAILED 实例
  //（BR-1 动词诚实：resume 重驱动，它自己绝不推进步骤，也绝不重跑已完成步骤；
  // waiting 实例通过已交付的 project 路径恢复，不走这个动词）。
  cmd
    .command("resume <instanceId>")
    .description("从失败步骤重新驱动一个 FAILED 实例（已完成步骤绝不重跑；一个新的 max_hops 窗口）")
    .requiredOption("--actor-session <session>", "执行 resume 的会话（记为出处）")
    .option("--occurrence <failed-qitem-id>", "要重驱动的失败发生（多于一个未解决时必填）")
    .option("--decision <text>", "给步骤 owner 的持久指令（落在重驱动 packet 里）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
诊断完一个异常项后使用：实例回到 active，
反弹到失败的步骤，带一个路由到该步骤重新解析 owner 的新 packet。
轨迹保留并延长；已解决的异常发生关闭；同一步骤的新失败
诚实抬起一个新发生。

示例：
  $ zrig workflow resume WF01ABC --actor-session orch-lead@my-rig \\
      --decision "flaky fixture 已在 commit abc123 修复——重试"
`)
    .action(async (instanceId: string, opts: {
      actorSession: string;
      occurrence?: string;
      decision?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          stepId?: string;
          newPacketId?: string;
          ownerSession?: string;
          resumeCount?: number;
          exceptionItemsClosed?: number;
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/resume`, {
          actorSession: opts.actorSession,
          occurrenceId: opts.occurrence,
          decision: opts.decision,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已从步骤 ${body.stepId ?? "?"} 重驱动实例 ${instanceId}（重驱动 #${body.resumeCount ?? "?"}；packet ${body.newPacketId ?? "?"} → ${body.ownerSession ?? "?"}；${body.exceptionItemsClosed ?? 0} 个异常项已解决）`,
          state: `实例 ${instanceId} = active，反弹到 ${body.stepId ?? "?"}；已完成步骤不动；新 max_hops 窗口`,
          next: `owner 通过以下方式推进：zrig workflow project --instance ${instanceId} --current-packet ${body.newPacketId ?? "<packet>"} --exit <exit> --actor-session ${body.ownerSession ?? "<owner>"}`,
        });
      });
    });

  cmd
    .command("abort <instanceId>")
    .description("事务性取消每个活动 packet 并中止整个 workflow 实例")
    .requiredOption("--reason <text>", "为什么要中止整个实例")
    .requiredOption("--actor-session <session>", "执行 abort 的会话")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (instanceId: string, opts: { reason: string; actorSession: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{ closedPacketIds?: string[]; status?: string }>(
          `/api/workflow/${encodeURIComponent(instanceId)}/abort`,
          { reason: opts.reason, actorSession: opts.actorSession },
        );
        printResult(opts.json ?? false, res.data, res.status);
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `已中止 workflow ${instanceId}`,
          state: `${res.data?.status ?? "未知"}；关闭了 ${res.data?.closedPacketIds?.length ?? 0} 个活动 packet`,
          next: `检视：zrig workflow trace ${instanceId}`,
        });
      });
    });

  // OPR.0.4.6.WF3 FR-3 part B——needs-attention rollup。按 arch 裁定（Rev-4 rails）
  // 在 CLI 侧组合：消费已交付读面上 API 携带的 instance.deadline 分类 + instance.status；
  // 只计数/分组/渲染——这里绝不计算阈值或分类，绝不加后台服务路由
  //（WF-4 时代的 web UI 在需要时会在自己的授权下加一个后台服务 rollup 端点；
  // 这个动词不是那个组合的永久归宿）。
  cmd
    .command("status")
    .description("哪些实例需要关注：计数 + 每个 failed/stuck/waiting 实例一行，带原因 + 下一步动作（只读）")
    .option("--json", "rollup 作为 JSON 给智能体")
    .addHelpText("after", `
回答"什么需要我"（list 回答"存在什么"）。每个值得关注的实例恰好出现一次，
带它所有分类（failed / stuck / waiting）和可执行的下一步。
干净的机队渲染带计数的"无"陈述——绝不空白。

示例：
  $ zrig workflow status
  $ zrig workflow status --json | jq '.attention[] | {instanceId, classes}'
`)
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/workflow/list");
        if (res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const body = res.data as { instances?: unknown[] } | unknown[];
        const rows = (Array.isArray(body) ? body : body?.instances ?? []) as Parameters<typeof composeAttentionRollup>[0];
        const rollup = composeAttentionRollup(rows);
        if (opts.json) {
          console.log(JSON.stringify(rollup));
          return;
        }
        for (const line of renderStatus(rollup)) console.log(line);
      });
    });

  return cmd;
}
