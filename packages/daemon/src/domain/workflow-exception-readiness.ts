import type Database from "better-sqlite3";
import type { WorkflowSpec } from "./workflow-types.js";
import type { LifecycleGraphSource } from "./project-lifecycle-compiler.js";
import { exceptionPolicy, resolveExceptionRoute, type ExceptionRouteInput } from "./workflow-exception-router.js";
import { WorkflowHumanDestinationError } from "./workflow-human-destination.js";
import { rigMemberExists, roleResolutionContext, tryResolveRoleByCapability } from "./workflow-role-context.js";

/** 返回配置的权威来源，而不是生成的缓存 spec 或每个来源镜像。 */
export function exceptionConfigurationSource(sourcePath: string, graph?: LifecycleGraphSource): string {
  if (graph?.mode === "project-profile" || graph?.mode === "mission-extend")
    return `${graph.profileSource}.workflow.exception_routing`;
  if (graph?.mode === "legacy-slices") return `${sourcePath}#lifecycle.workflow.exception_routing`;
  return `${graph?.missionSource ?? `${sourcePath}#workflow`}.exception_routing`;
}

export interface ExceptionReadiness {
  scope: "future-occurrences";
  posture: "advisory";
  selection: { state: "missing" | "selected" | "undeclared"; role: string | null; source: string; entryRole: string | null };
  routes: Array<{
    exceptionClass: string; state: string; roleResolution: string; destinationSession: string | null;
    position: string | null; resolvedVia: string | null; identity: string; message: string;
  }>;
  nextAction: string;
}

/** 读取与检测逻辑相同的惰性解析器。读取失败时保持 unavailable；
 * 检查过程从不写入、不路由工作，也不施加入场门禁。 */
export function inspectExceptionReadiness(input: {
  db: Database.Database; spec: WorkflowSpec; source: string; boundRig?: string | null;
  hostDefault: () => ExceptionRouteInput["hostDialDefault"];
  humanFallbackSeat?: ExceptionRouteInput["humanFallbackSeat"];
  instanceId?: string;
}): ExceptionReadiness {
  const { spec } = input;
  const role = spec.exception_routing?.orchestrator_role ?? null;
  const selected = role === null ? "missing" : Object.hasOwn(spec.roles, role) ? "selected" : "undeclared";
  const selection = { state: selected, role, source: input.source + ".orchestrator_role", entryRole: spec.entry?.role ?? null } as ExceptionReadiness["selection"];
  const ctx = roleResolutionContext(input.db, input.boundRig ?? spec.target?.rig);
  const routes: ExceptionReadiness["routes"] = [];
  // 这里只接纳两种异常类别。人工门禁已经携带明确的决策义务，不再生成另一项异常。
  for (const exceptionClass of ["unmapped_failed", "stuck_overdue"] as const) {
    let roleResolution = "not-needed";
    let position: string | null = null, resolvedVia: string | null = null;
    let destinationSession: string | null = null;
    try {
      const hostDialDefault = input.hostDefault();
      ({ position, resolvedVia } = exceptionPolicy({ spec, exceptionClass, hostDialDefault }));
      if (position === "orchestrator" && selected !== "selected") roleResolution = selected + "-selection";
      const route = resolveExceptionRoute({ spec, exceptionClass, hostDialDefault, humanFallbackSeat: input.humanFallbackSeat,
        resolveRoleTarget: name => {
          const preferred = spec.roles[name]?.preferred_targets?.[0];
          if (preferred) { roleResolution = "preferred-target"; return preferred; }
          roleResolution = "unavailable";
          const target = tryResolveRoleByCapability(ctx, name);
          roleResolution = target ? "capability-match" : ctx ? "no-match" : "unbound";
          return target;
        },
      });
      position = route.position;
      destinationSession = route.destinationSession;
      // 作者声明的 preferred target 就是现有路由策略。单独验证其声明身份，
      // 绝不能把建议性读取转化成 fallback。
      let identity = route.humanRouted ? "registered-human" : "declared-agent";
      if (roleResolution === "preferred-target") {
        const rig = destinationSession.split("@")[1];
        identity = rig && rigMemberExists(input.db, rig, destinationSession) ? "declared-member" : "unregistered";
      }
      routes.push({ exceptionClass, state: identity === "unregistered" ? "unregistered" : "ready", roleResolution,
        destinationSession, position, resolvedVia, identity,
        message: identity === "unregistered" ? "作者指定的目标不是已声明的工作组成员。请运行 zrig ps --nodes --json，并修正所选角色的 preferred_targets。"
          : route.position === "fallback" ? `已注册人工席位回退；智能体解析结果：${roleResolution}。`
          : "当前证据可解析此路由；接纳异常实例时会重新读取。" });
    } catch (error) {
      const state = error instanceof WorkflowHumanDestinationError ? error.details.state : "unavailable";
      routes.push({ exceptionClass, state, roleResolution, destinationSession, position, resolvedVia, identity: "unverified",
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  const correction = routes.every(route => route.position === "human_only")
    ? `所选策略直接路由到已注册人工席位，无需选择编排者。请检查 ${input.source}。`
    : selected === "missing"
    ? `已定义的入口/普通角色不等于选择了异常所有者。请在 ${selection.source} 选择预期的已声明角色。`
    : selected === "undeclared" ? `请声明预期角色，或修正 ${selection.source}；${role} 尚未声明。`
      : `请检查 ${input.source} 中所选的路由契约。`;
  return { scope: "future-occurrences", posture: "advisory", selection, routes,
    nextAction: correction + (input.instanceId
      ? ` 修正来源后，请检查 zrig workflow revise ${input.instanceId}，并有意应用其中兼容的提案。编辑文件不会改变正在运行的所有者；现有异常义务仍归原所有者。`
      : " 修正后请重新编译。这是故障前建议；检测时若必需的解析读取失败，只阻塞该异常实例，普通工作不受本检查门控。") };
}
