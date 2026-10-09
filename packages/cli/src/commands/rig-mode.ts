// Slice 09（OPR.0.3.2.9）——`rig mode` CLI（从 `rig policy` 改名，0.5.2 B7——干净改名，零采用；
// `rig policy` 现在是权限策略动词）：操作人员上下文模式接口。与后台服务的类型化原语存储配对。
//
// 子命令：
//   zrig mode set <mode> [--scope ...] [--qualifier ...] [--<field> ...]
//                         [--evidence ...] [--confirm]
//                         → 复述并确认；仅在 --confirm 时 PUT
//   rig mode show       → 列出所有绑定（管道时默认 JSON）
//   rig mode effective  → 解析读上下文的有效模式
//   rig mode cite       → 按 convention §Component 5 输出引用行
//   zrig mode unset <scope> [qualifier]
//                         → DELETE 一条绑定（仅操作人员）
//   rig mode defaults   → 推荐的 8×7 + 每模式范围 + 陈旧规则
//
// HG-4 / HG-7 锚定在这里：
//   - `set` 绝不静默应用。没有 `--confirm` 时它回显提议的绑定
//    （模式 + 范围 + 关键设置）并以 `exit 2` 退出，脚本无法意外应用。
//     `--confirm` 是显式的操作人员动作。
//   - 模式调用：裸词或 `mode:<mode>` 前缀；两者都通过
//     disambiguateModeInvocation() 归一化。
//   - 引用格式：按 convention §Component 5 + §Citation Rules 的短散文。

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import type { OperatingPosture } from "@openrig/daemon/health-projection";

export interface RigModeDeps extends StatusDeps {}

// 镜像后台服务枚举 + 结构。我们内联保留这些，避免 CLI 在构建期依赖
// daemon 包；后台服务边界的校验器是事实来源，CLI 原样把记录传过去。
const MODES = ["sleep", "desk", "mobile", "away", "focus", "debug", "human-led", "delegated"] as const;
type Mode = (typeof MODES)[number];

const SCOPES = ["global_host", "rig", "project", "mission", "workstream", "qitem"] as const;
type Scope = (typeof SCOPES)[number];

// Convention §Component 4——裸词消歧。一个裸的保留模式词，或 `mode:<word>`，
// 成为一次调用；嵌在句子里的不算（后者在这里是 CLI 输入错误，因为 CLI
// 只接受一个位置参数 <mode>）。
function disambiguateModeInvocation(raw: string): Mode | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.startsWith("mode:") ? trimmed.slice("mode:".length).trim() : trimmed;
  if (stripped.split(/\s+/).length !== 1) return null;
  return (MODES as readonly string[]).includes(stripped) ? (stripped as Mode) : null;
}

interface RecommendedDefaultsResponse {
  recommendedModeDefaults: Record<Mode, {
    autonomy_scope: string;
    heartbeat_cadence: string;
    inspection_depth: string;
    update_detail: string;
    escalation_threshold: string;
    concurrency_limit: string;
    permission_prompt_posture: string;
  }>;
  recommendedDefaultScope: Record<Mode, Scope>;
  defaultStaleRule: string;
}

interface BindingResponse {
  binding: {
    id: string;
    mode: Mode;
    record: Record<string, string>;
    qualifier: string | null;
    setAt: string;
    setBy: string;
  };
}

interface ListResponse {
  bindings: Array<BindingResponse["binding"]>;
}

interface EffectiveResponse {
  operatingPosture?: OperatingPosture;
  effective: { binding: BindingResponse["binding"]; resolvedScope: Scope } | null;
  posture: "known" | "unknown_posture";
  hint?: string;
}

async function withClient<T>(
  deps: RigModeDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

function emitRecord(label: string, record: Record<string, string>): void {
  console.log(label);
  for (const [k, v] of Object.entries(record)) {
    console.log(`  ${k}: ${v}`);
  }
}

function emitOperatingPosture(value: OperatingPosture | undefined): void {
  if (!value) {
    console.log("运行姿态：未知（本后台服务未报告）。");
    return;
  }
  console.log(`运行姿态：${value.posture}（来源：${value.source}${value.binding ? "，" + value.binding.id : ""}）`);
  if (value.context) {
    const { phase, sources: _sources, ...scope } = value.context;
    console.log(`  范围：${JSON.stringify(scope)}`);
    console.log(`  阶段：${phase.value ?? "未知"}（来源：${phase.source ?? "不可用"}）`);
  }
  console.log(`  ${value.reason} 记录的偏好不授予任何执行权限。`);
}

/**
 * CLI 侧镜像后台服务路由 parseScopeAndQualifier 的语义。
 * CLI 是操作人员的创作面；convention 的范围规则在调用时生效，
 * 而不只在原始 HTTP URL 解析时。
 *
 * 拒绝：
 *   - global_host 带显式 qualifier（guard qitem-20260518044650 的阻塞性
 *     复核结论）：输入 `--scope global_host --qualifier <id>` 的操作人员
 *     会收到错误，绝不联系后台服务。CLI 不静默丢弃 qualifier。
 *   - 任何非 global 范围缺 qualifier。
 */
type NormalizedScope = { ok: true; qualifier: string | null } | { ok: false; message: string };
function normalizeScopeQualifier(scope: Scope, explicitQualifier: string | undefined): NormalizedScope {
  if (scope === "global_host") {
    if (explicitQualifier !== undefined && explicitQualifier !== "") {
      return {
        ok: false,
        message: `global_host 绑定不能带 qualifier（收到 "${explicitQualifier}"）。要么去掉 --qualifier，要么把 --scope 改成 rig / workstream / qitem。`,
      };
    }
    return { ok: true, qualifier: null };
  }
  if (explicitQualifier === undefined || explicitQualifier === "") {
    return {
      ok: false,
      message: `范围 ${scope} 需要 qualifier（rigId / workstreamId / qitemId）。请传 --qualifier <id>。`,
    };
  }
  return { ok: true, qualifier: explicitQualifier };
}

function formatCitation(b: BindingResponse["binding"]): string {
  const qualifierPart = b.qualifier ? `:${b.qualifier}` : "";
  const scope = b.record.scope as Scope;
  return `按操作人员在 \`${scope}${qualifierPart}\` 以 \`${b.mode}\` 模式运行（set_at ${b.setAt}）`;
}

export function rigModeCommand(depsOverride?: RigModeDeps): Command {
  const cmd = new Command("mode").description(
    "查看并显式设置带范围的运行姿态（human-led/delegated）与操作人员上下文模式。",
  );

  const getDeps = (): RigModeDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  // -- set ---------------------------------------------------------------
  cmd
    .command("set <mode>")
    .description(
      "提议一条模式绑定。没有 --confirm 时，复述提议的绑定并以 2 退出（不写后台服务）。带 --confirm 时才设置。",
    )
    .option("--scope <scope>", `范围：${SCOPES.join(" | ")}（默认：按模式推荐）`)
    .option("--qualifier <id>", "rig/project/qitem ID；mission：project/mission；workstream：project/mission/slice-id；global_host 省略")
    .option("--autonomy-scope <v>")
    .option("--heartbeat-cadence <v>")
    .option("--inspection-depth <v>")
    .option("--update-detail <v>")
    .option("--escalation-threshold <v>")
    .option("--concurrency-limit <v>")
    .option("--permission-prompt-posture <v>", "取值之一：normal | batch_for_human | do_not_prompt_unless_blocked（按 convention 禁止 auto_accept）。")
    .option("--expiry-or-stale-rule <v>")
    .option("--evidence <citation>", "自由文本引用（操作人员消息 id、文件指针、chatroom 话题等）。")
    .option("--confirm", "确认提议的绑定并应用。不带此标志时，set 只复述。")
    .option("--bearer <token>", "操作人员 bearer token（或设置 OPENRIG_AUTH_BEARER_TOKEN 环境变量）。")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (
      modeArg: string,
      opts: {
        scope?: string;
        qualifier?: string;
        autonomyScope?: string;
        heartbeatCadence?: string;
        inspectionDepth?: string;
        updateDetail?: string;
        escalationThreshold?: string;
        concurrencyLimit?: string;
        permissionPromptPosture?: string;
        expiryOrStaleRule?: string;
        evidence?: string;
        confirm?: boolean;
        bearer?: string;
        json?: boolean;
      },
    ) => {
      const mode = disambiguateModeInvocation(modeArg);
      if (!mode) {
        console.error(`未知模式 '${modeArg}'。允许：${MODES.join(", ")}（或 'mode:<name>' 前缀）。`);
        process.exitCode = 1;
        return;
      }

      // 阻塞性 re-verify-2（qitem-20260518045300）：当 --scope 显式给出时，
      // 在碰后台服务之前本地校验 scope + qualifier。否则一个非法的操作人员
      // 调用（例如 `--scope global_host --qualifier X`）会在后台服务宕机时
      // 表面化为 "Daemon not running"，而不是正确的本地输入错误。
      // Convention 的范围规则在操作人员调用时生效，不在后台服务 HTTP 解析时。
      let explicitScope: Scope | null = null;
      if (opts.scope !== undefined) {
        if (!(SCOPES as readonly string[]).includes(opts.scope)) {
          console.error(`未知范围 '${opts.scope}'。允许：${SCOPES.join(", ")}。`);
          process.exitCode = 1;
          return;
        }
        explicitScope = opts.scope as Scope;
        const preflight = normalizeScopeQualifier(explicitScope, opts.qualifier);
        if (!preflight.ok) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: "qualifier_invalid", hint: preflight.message }, null, 2));
          } else {
            console.error(preflight.message);
          }
          process.exitCode = 1;
          return;
        }
      }

      const deps = getDeps();
      await withClient(deps, async (client) => {
        const defaultsRes = await client.get<RecommendedDefaultsResponse>("/api/rig-mode/defaults");
        if (defaultsRes.status >= 400) {
          console.error(JSON.stringify(defaultsRes.data, null, 2));
          process.exitCode = 1;
          return;
        }
        const defaults = defaultsRes.data;
        const scope = explicitScope ?? defaults.recommendedDefaultScope[mode];
        // 防御——defaults 映射来自后台服务，其 scope 值可信；保持断言形状精简。
        if (!(SCOPES as readonly string[]).includes(scope)) {
          console.error(`未知范围 '${scope}'。允许：${SCOPES.join(", ")}。`);
          process.exitCode = 1;
          return;
        }
        // 对隐式默认 scope 情况再跑一次归一化。
        //（显式 scope 已在上面预检过；这个分支对显式 scope 输入是 no-op，
        // 但当默认 scope 是 `qitem`/`workstream` 而操作人员忘了 --qualifier 时需要。）
        const normalized = normalizeScopeQualifier(scope, opts.qualifier);
        if (!normalized.ok) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: "qualifier_invalid", hint: normalized.message }, null, 2));
          } else {
            console.error(normalized.message);
          }
          process.exitCode = 1;
          return;
        }
        const qualifier = normalized.qualifier;
        const perMode = defaults.recommendedModeDefaults[mode];
        // Component 3——恰好这 10 个设置字段。`mode` 是绑定的身份
        //（Component 2），位于 PUT body 顶层，不在 record 内。
        const record = {
          autonomy_scope: opts.autonomyScope ?? perMode.autonomy_scope,
          heartbeat_cadence: opts.heartbeatCadence ?? perMode.heartbeat_cadence,
          inspection_depth: opts.inspectionDepth ?? perMode.inspection_depth,
          update_detail: opts.updateDetail ?? perMode.update_detail,
          escalation_threshold: opts.escalationThreshold ?? perMode.escalation_threshold,
          concurrency_limit: opts.concurrencyLimit ?? perMode.concurrency_limit,
          permission_prompt_posture: opts.permissionPromptPosture ?? perMode.permission_prompt_posture,
          scope,
          expiry_or_stale_rule: opts.expiryOrStaleRule ?? defaults.defaultStaleRule,
          evidence_citation: opts.evidence ?? `operator confirmed ${mode}`,
        };

        if (!opts.confirm) {
          // 复述并确认（HG-7）。不写后台服务。
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, proposed: { mode, scope, qualifier, record }, confirm_required: true }, null, 2));
          } else {
            console.log(`提议的绑定（复述并确认——未应用）：`);
            console.log(`  模式：    ${mode}`);
            console.log(`  范围：    ${scope}${qualifier ? `（${qualifier}）` : ""}`);
            emitRecord(`  record:`, record);
            console.log(`\n带 --confirm 重跑以应用。`);
          }
          process.exitCode = 2;
          return;
        }

        const headers: Record<string, string> = {};
        const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const qualifierPath = qualifier ? `/${encodeURIComponent(qualifier)}` : "";
        const res = await client.put<BindingResponse | { error: string; errors?: string[] }>(
          `/api/rig-mode/bindings/${scope}${qualifierPath}`,
          { mode, record },
          { headers },
        );
        if (res.status === 401) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: "unauthorized", hint: "后台服务要求操作人员 bearer。请传 --bearer <token> 或设置 OPENRIG_AUTH_BEARER_TOKEN。" }, null, 2));
          } else {
            console.error("未授权。后台服务要求操作人员 bearer token。");
            console.error("请传 --bearer <token>，或在重跑前 export OPENRIG_AUTH_BEARER_TOKEN。");
          }
          process.exitCode = 1;
          return;
        }
        if (res.status >= 400) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, ...(res.data as object) }, null, 2));
          } else {
            console.error(`设置绑定出错（HTTP ${res.status}）：`);
            console.error(JSON.stringify(res.data, null, 2));
          }
          process.exitCode = 1;
          return;
        }
        const body = res.data as BindingResponse;
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, binding: body.binding }, null, 2));
        } else {
          console.log(`已设置：${body.binding.id}`);
          console.log(`  模式：    ${body.binding.mode}`);
          emitRecord(`  record:`, body.binding.record);
          console.log(`  设置者：  ${body.binding.setBy}`);
          console.log(`  设置时间：${body.binding.setAt}`);
          console.log(`\n${formatCitation(body.binding)}`);
        }
      });
    });

  // -- show --------------------------------------------------------------
  cmd
    .command("show")
    .description("列出所有操作人员上下文模式绑定。")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<ListResponse>("/api/rig-mode/bindings");
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (res.data.bindings.length === 0) {
          console.log("未设置任何操作人员上下文模式绑定。");
          return;
        }
        for (const b of res.data.bindings) {
          console.log(`${b.id}  [${b.mode}]  设置于=${b.setAt}`);
        }
      });
    });

  // -- effective ---------------------------------------------------------
  cmd
    .command("effective")
    .description("查看有效运行姿态、范围、阶段与来源。未设置范围解析为默认 human-led；不可读或有歧义的身份保持未知。")
    .option("--rig <id>")
    .option("--project <id>")
    .option("--mission <id>")
    .option("--workstream <id>")
    .option("--qitem <id>")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { rig?: string; project?: string; mission?: string; workstream?: string; qitem?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qs = new URLSearchParams();
        if (opts.rig) qs.set("rig", opts.rig);
        if (opts.project) qs.set("project", opts.project);
        if (opts.mission) qs.set("mission", opts.mission);
        if (opts.workstream) qs.set("workstream", opts.workstream);
        if (opts.qitem) qs.set("qitem", opts.qitem);
        const path = qs.toString() ? `/api/rig-mode/effective?${qs.toString()}` : "/api/rig-mode/effective";
        const res = await client.get<EffectiveResponse>(path);
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        emitOperatingPosture(res.data.operatingPosture);
        if (res.data.posture === "unknown_posture" || !res.data.effective) {
          console.log("操作人员上下文模式：未设置（legacy unknown_posture）。");
          return;
        }
        const b = res.data.effective.binding;
        console.log(`有效模式：${b.mode}（解析范围：${res.data.effective.resolvedScope}）`);
        emitRecord(`  record:`, b.record);
        console.log(`  设置者：  ${b.setBy}`);
        console.log(`  设置时间：${b.setAt}`);
      });
    });

  // -- cite --------------------------------------------------------------
  cmd
    .command("cite")
    .description("为读上下文处的有效模式输出一行引用。按 convention §Citation Rules。")
    .option("--rig <id>")
    .option("--project <id>")
    .option("--mission <id>")
    .option("--workstream <id>")
    .option("--qitem <id>")
    .action(async (opts: { rig?: string; project?: string; mission?: string; workstream?: string; qitem?: string }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qs = new URLSearchParams();
        if (opts.rig) qs.set("rig", opts.rig);
        if (opts.project) qs.set("project", opts.project);
        if (opts.mission) qs.set("mission", opts.mission);
        if (opts.workstream) qs.set("workstream", opts.workstream);
        if (opts.qitem) qs.set("qitem", opts.qitem);
        const path = qs.toString() ? `/api/rig-mode/effective?${qs.toString()}` : "/api/rig-mode/effective";
        const res = await client.get<EffectiveResponse>(path);
        emitOperatingPosture(res.data.operatingPosture);
        if (res.status >= 400 || !res.data.effective) {
          console.log("在没有显式操作人员上下文模式绑定的情况下运行（unknown_posture）。");
          return;
        }
        console.log(formatCitation(res.data.effective.binding));
      });
    });

  // -- unset -------------------------------------------------------------
  cmd
    .command("unset <scope> [qualifier]")
    .description("删除一条绑定（仅操作人员）。范围：global_host | rig | project | mission | workstream | qitem。")
    .option("--bearer <token>")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (
      scopeArg: string,
      qualifierArg: string | undefined,
      opts: { bearer?: string; json?: boolean },
    ) => {
      if (!(SCOPES as readonly string[]).includes(scopeArg)) {
        console.error(`未知范围 '${scopeArg}'。允许：${SCOPES.join(", ")}。`);
        process.exitCode = 1;
        return;
      }
      const scope = scopeArg as Scope;
      // 阻塞性 re-verify（qitem-20260518044650）：unset 时绝不静默丢弃
      // 操作人员在 global_host 上显式给的 qualifier。
      // 与 set 同一类风险，共用同一个 helper。
      const normalized = normalizeScopeQualifier(scope, qualifierArg);
      if (!normalized.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: "qualifier_invalid", hint: normalized.message }, null, 2));
        } else {
          console.error(normalized.message);
        }
        process.exitCode = 1;
        return;
      }
      const qualifier = normalized.qualifier;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qualifierPath = qualifier ? `/${encodeURIComponent(qualifier)}` : "";
        const headers: Record<string, string> = {};
        const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const res = await client.delete<{ removed: boolean }>(`/api/rig-mode/bindings/${scope}${qualifierPath}`, { headers });
        if (res.status >= 400) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, ...(res.data as object) }, null, 2));
          } else {
            console.error(JSON.stringify(res.data, null, 2));
          }
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, removed: res.data.removed }, null, 2));
        } else {
          console.log(res.data.removed ? `已移除 ${scope}${qualifier ? `:${qualifier}` : ""}` : "无可移除。");
        }
      });
    });

  // -- defaults ----------------------------------------------------------
  cmd
    .command("defaults")
    .description("打印推荐的每模式 8×7 + 默认范围 + 陈旧规则。")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<RecommendedDefaultsResponse>("/api/rig-mode/defaults");
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        for (const mode of MODES) {
          console.log(`${mode}（默认范围：${res.data.recommendedDefaultScope[mode]}）`);
          emitRecord("  ", res.data.recommendedModeDefaults[mode] as unknown as Record<string, string>);
        }
        console.log(`\n默认陈旧规则：${res.data.defaultStaleRule}`);
      });
    });

  return cmd;
}

// 为纯 helper 的可单测性而重导出。
export const __test__ = { disambiguateModeInvocation, formatCitation, normalizeScopeQualifier };
