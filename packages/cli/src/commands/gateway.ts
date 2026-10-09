import { Command } from "commander";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
// 人类注册是后台服务拥有的 home-state；本动词在调用时惰性导入窄接口
// @openrig/daemon/gateway-human-registry（C3/crash-cart dep rail——单一来源，
// 不复制双份）。仅类型的 import 让该接口不进入 eager CLI 图。
import type { addHumanFragment as AddHumanFragment } from "@openrig/daemon/gateway-human-registry";

// `rig gateway human add`——人类注册的"仅动词添加"接口（M1 A3）。
// 操作人员绝不手工创建 fragment YAML；该动词拥有它（校验 → 原子写入 →
// 重新投影）。address 派生为 <entityId>@external（注册约定，由 schema 固定）；
// 除非显式传 --replace，否则不覆盖。

// --binding 规格解析（kind:connectorRef:secretsRef:role[:handle=<id>]，带冒号的
// vault 指针 secretsRef，可选 handle= token）位于注册接口的 parseBindingSpec——
// add（此处）与 `set binding.<n>`（S12）共用同一来源，与其余接口一起惰性导入，
// 让 eager CLI 图保持不依赖后台服务。

// ── S12（OPR.0.5.5.12）：remove 守卫的队列行半边，可注入，因此动词测试
// 不需要真实后台服务。ok:false = 来源无法被检查（后台服务不可达）——
// 是"不确定"，绝不能当成看板为空的证据。
export interface HumanRowRef {
  id: string;
  state: string;
  summary?: string;
}
export type HumanRowsLookup = (address: string) => Promise<
  | { ok: true; rows: HumanRowRef[] }
  | { ok: false; error: string }
>;

export interface GatewayCommandDeps {
  queueRows?: HumanRowsLookup;
  humanReadiness?: HumanReadinessLookup;
}

export interface HumanReadinessView {
  state: "ready" | "not-ready" | "indeterminate";
  configured: boolean | null;
  enabled: boolean | null;
  active: boolean | null;
  ready: boolean;
  connector?: { kind: string; ref: string };
  reason: string;
  nextAction: string | null;
  checkedAt?: string;
}

export type HumanReadinessLookup = (entityId: string) => Promise<HumanReadinessView>;

export async function daemonHumanReadiness(entityId: string): Promise<HumanReadinessView> {
  try {
    const { DaemonClient } = await import("../client.js");
    const response = await new DaemonClient().get<{ ok?: boolean; readiness?: HumanReadinessView; error?: unknown; message?: unknown }>(
      `/api/gateway/human/${encodeURIComponent(entityId)}/readiness`,
    );
    if (response.status !== 200) {
      const detail = [response.data?.error, response.data?.message].filter((value) => typeof value === "string").join(": ");
      throw new Error(`HTTP ${response.status}: ${detail || "readiness 请求被拒绝"}`);
    }
    const readiness = response.data?.readiness;
    if (response.data?.ok !== true || !readiness
      || !["ready", "not-ready", "indeterminate"].includes(readiness.state)
      || [readiness.configured, readiness.enabled, readiness.active].some((value) => value !== null && typeof value !== "boolean")
      || readiness.ready !== (readiness.state === "ready")
      || typeof readiness.reason !== "string" || !readiness.reason.trim()
      || (readiness.nextAction !== null && typeof readiness.nextAction !== "string")
      || (readiness.connector !== undefined && (!readiness.connector || typeof readiness.connector.kind !== "string" || typeof readiness.connector.ref !== "string"))
      || (readiness.checkedAt !== undefined && typeof readiness.checkedAt !== "string")) {
      throw new Error("HTTP 200：投递 readiness 响应格式错误");
    }
    return readiness;
  } catch (error) {
    return {
      state: "indeterminate",
      configured: null,
      enabled: null,
      active: null,
      ready: false,
      reason: `无法从后台服务读取投递 readiness：${(error as Error).message}`,
      nextAction: "zrig status",
    };
  }
}

/** 默认的 remove 守卫队列行半边：经后台服务枚举发给该人类的非终态行。
 *  ok:false 携带"看板无法被检查"的原因。 */
export async function daemonQueueRows(address: string): ReturnType<HumanRowsLookup> {
  try {
    const { DaemonClient } = await import("../client.js");
    const client = new DaemonClient();
    // Fix-r1 F2（R2 阻塞）：枚举必须到耗尽为止。一个有界读取若返回满额就疑似
    // 被截断——只有窗口严格大于结果时才能证明完整性。不断放大窗口直到成立；
    // 一个超出所有窗口的看板是诚实的完整性拒绝，绝不悄悄给一份缩短的孤儿清单。
    let limit = 1000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await client.get<Array<{ qitemId?: string; state?: string; summary?: string | null }>>(
        `/api/queue/list?destinationSession=${encodeURIComponent(address)}&state=pending,in-progress,blocked&limit=${limit}&compact=1`,
      );
      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length < limit) {
        return {
          ok: true,
          rows: data.map((r) => ({
            id: String(r.qitemId ?? "（未知 id）"),
            state: String(r.state ?? "（未知状态）"),
            ...(r.summary ? { summary: String(r.summary) } : {}),
          })),
        };
      }
      limit *= 4;
    }
    return { ok: false, error: `对 ${address} 的队列枚举在最大 ${limit / 4} 行窗口下仍被打满——完整性未证明` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function gatewayCommand(deps: GatewayCommandDeps = {}): Command {
  const queueRows: HumanRowsLookup = deps.queueRows ?? daemonQueueRows;
  const humanReadiness: HumanReadinessLookup = deps.humanReadiness ?? daemonHumanReadiness;
  const cmd = new Command("gateway").description("网关：人类注册与连接器接口");
  const human = cmd.command("human").description("管理人类规格（gateway/humans/ 下每人一个 fragment）");

  human
    .command("add <entityId>")
    .description("添加一个人类 fragment（仅动词添加；fragment 是真相，注册只是生成的投影）")
    .requiredOption("--display-name <name>", "人类可读的显示名")
    .requiredOption(
      "--binding <kind:connectorRef:secretsRef:role[:handle=<id>]>",
      "连接器绑定（可重复）；role 为 primary|secondary，必须恰好一个 primary。可选 handle=<平台 id> 让绑定可入站解析（每个 kind 内唯一）；只出站则省略。",
      (v: string, acc: string[] = []) => { acc.push(v); return acc; },
    )
    .requiredOption("--delivery-class <A|B|C|D>", "通知响度分级（通知注册的选择）")
    .option("--away", "设置 AWAY 预设")
    .option("--replace", "显式替换已有人类（不静默覆盖）")
    .option("--reason <reason>", "连接器绑定变更时记录的原因", "登记人类投递")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (entityId: string, opts: { displayName: string; binding: string[]; deliveryClass: string; away?: boolean; replace?: boolean; reason: string; actor?: string }) => {
      // 在调用时惰性导入后台服务窄接口（dep rail 2）。
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const { addHumanFragment, parseBindingSpec } = registry as unknown as {
        addHumanFragment: typeof AddHumanFragment;
        parseBindingSpec: (spec: string) => { ok: true; binding: Record<string, unknown> } | { ok: false; error: string };
      };
      // Fix-r1 F1（R2 阻塞，A1/R5）：add 动词是单人类边界。在任何解析或写入
      // 之前拒绝第二个不同的人类——A1 描述为手工编写的多 fragment 状态，
      // 绝不能由产品自己的接口产生。失败关闭：无法核验的注册也拒绝
      //（绝不在未知状态下添加）。
      const existing = registry.listHumans();
      if (!existing.ok) {
        console.error(`已拒绝：无法核验单人类边界——${existing.error}`);
        process.exitCode = 1;
        return;
      }
      if (existing.humans.length > 0 && !existing.humans.some((h) => h.entityId === entityId)) {
        const ids = existing.humans.map((h) => h.entityId).join(", ");
        console.error(
          `已拒绝：已配置了一个人类（${ids}）——0.5.5 交付的是简单的单人类接口（修正案 A1，founder R5），因此 \`zrig gateway human add\` 只管理一个人类。` +
          `如果确实需要多个，请在 ${registry.humansDir()} 下手工编写 fragment YAML（多个 fragment 会如实展示，并附 advisory）；多人类管理将在 0.5.7 提供。`,
        );
        process.exitCode = 1;
        return;
      }
      const bindings: Record<string, unknown>[] = [];
      for (const spec of opts.binding) {
        const b = parseBindingSpec(spec);
        if (!b.ok) { console.error(`--binding：${b.error}`); process.exitCode = 1; return; }
        bindings.push(b.binding);
      }
      const fragment: Record<string, unknown> = {
        entityId,
        class: "human",
        displayName: opts.displayName,
        address: `${entityId}@external`,
        connectorBindings: bindings,
        prefs: { deliveryClass: opts.deliveryClass, ...(opts.away ? { away: true } : {}) },
      };
      const before = registry.showHuman(entityId);
      try {
        const result = await registry.runChannelOperation({
          actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1", reason: opts.reason,
          action: "binding", subject: `${entityId}@external`,
          before: { digest: registry.channelStateDigest(before.ok ? before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding) : null) },
          run: async () => {
            const res = addHumanFragment(fragment, undefined, { replace: !!opts.replace });
            if (!res.ok) throw new Error(res.error);
            const digest = registry.channelStateDigest(res.fragment.connectorBindings);
            return { value: res, after: { digest }, effect: before.ok && registry.channelStateDigest(before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding)) === digest ? "no-op" : "applied" };
          },
        });
        console.log(JSON.stringify({ ok: true, entityId, path: result.value.path, receipt: result.receipt }));
      } catch (error) { console.error(`已拒绝：${(error as Error).message}`); process.exitCode = 1; }
    });

  // ── S12（OPR.0.5.5.12）：add 之外的 fragment 生命周期。所有动词都通过
  // fragment + 重新投影（注册接口）操作；没有任何动词直接写生成的投影。

  human
    .command("list")
    .description("展示已配置的人类（按 A1/R5 的单人类接口；多个 fragment 会如实渲染并附 0.5.7 advisory）")
    .option("--json", "以 JSON 输出完整记录")
    .action(async (opts: { json?: boolean }) => {
      const { listHumans } = await import("@openrig/daemon/gateway-human-registry");
      const res = listHumans();
      if (!res.ok) { console.error(`已拒绝：${res.error}`); process.exitCode = 1; return; }
      const humans = await Promise.all(res.humans.map(async (record) => ({ ...record, deliveryReadiness: await humanReadiness(record.entityId) })));
      if (opts.json) { console.log(JSON.stringify({ ok: true, humans, ...(res.advisory ? { advisory: res.advisory } : {}) })); return; }
      if (res.humans.length === 0) { console.log("尚未配置人类——登记一个：zrig gateway human add <entityId> --display-name … --binding … --delivery-class …"); return; }
      for (const h of humans) {
        const inbound = h.bindings.inboundResolvable ? "" : "  [仅出站]";
        console.log(`${h.entityId}  "${h.displayName}"  类别=${h.deliveryClass}  ${h.away ? "离开" : "可用"}  绑定数=${h.bindings.count}（主 ${h.bindings.primary.kind}:${h.bindings.primary.connectorRef}）  投递=${h.deliveryReadiness.state}${inbound}`);
        if (!h.deliveryReadiness.ready) console.log(`  投递：${h.deliveryReadiness.reason}${h.deliveryReadiness.nextAction ? `；下一步：${h.deliveryReadiness.nextAction}` : ""}`);
      }
      if (res.advisory) console.log(`提示：${res.advisory}`);
    });

  human
    .command("show <entityId>")
    .description("展示生效记录：fragment 值 + 哪些默认值填了其余部分，并附出处")
    .option("--json", "以 JSON 输出完整记录")
    .action(async (entityId: string, opts: { json?: boolean }) => {
      const { showHuman } = await import("@openrig/daemon/gateway-human-registry");
      const res = showHuman(entityId);
      if (!res.ok) { console.error(`已拒绝：${res.error}`); process.exitCode = 1; return; }
      const r = { ...res.record, deliveryReadiness: await humanReadiness(entityId) };
      if (opts.json) { console.log(JSON.stringify({ ok: true, record: r })); return; }
      console.log(`${r.entityId} (${r.address}) — "${r.displayName}"`);
      console.log(`  fragment：${r.fragmentPath}`);
      console.log(`  投递分级：${r.prefs.deliveryClass.value}（${r.prefs.deliveryClass.source}）`);
      console.log(`  离开：${r.prefs.away.value}（${r.prefs.away.source}）`);
      r.connectorBindings.forEach((b, i) => {
        console.log(`  绑定.${i}：${b.kind}:${b.connectorRef} 角色=${b.role}${b.handle ? ` handle=${b.handle}` : " [仅出站]"}`);
      });
      console.log(`  投递就绪状态：${r.deliveryReadiness.state}（${r.deliveryReadiness.reason}）`);
      if (r.deliveryReadiness.nextAction) console.log(`  下一步：${r.deliveryReadiness.nextAction}`);
    });

  human
    .command("set <entityId> <field> <value>")
    .description("通过动词编辑一个字段（与 add 相同校验；立即重新投影）。字段：display-name、delivery-class、away、binding.<n>")
    .option("--reason <reason>", "连接器绑定变更时记录的原因", "更新人类绑定")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (entityId: string, field: string, value: string, opts: { reason: string; actor?: string }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      if (field.startsWith("binding.")) {
        const before = registry.showHuman(entityId);
        if (!before.ok) { console.error(`已拒绝：${before.error}`); process.exitCode = 1; return; }
        try {
          const prior = registry.channelStateDigest(before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding));
          const result = await registry.runChannelOperation({
            actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1", reason: opts.reason,
            action: "binding", subject: `${entityId}@external`, before: { digest: prior },
            run: async () => {
              const res = registry.setHumanField(entityId, field, value);
              if (!res.ok) throw new Error(res.error);
              const digest = registry.channelStateDigest(res.fragment.connectorBindings);
              return { value: res, after: { digest }, effect: digest === prior ? "no-op" : "applied" };
            },
          });
          console.log(JSON.stringify({ ok: true, entityId, field, path: result.value.path, receipt: result.receipt }));
        } catch (error) { console.error(`已拒绝：${(error as Error).message}`); process.exitCode = 1; }
        return;
      }
      const res = registry.setHumanField(entityId, field, value);
      if (!res.ok) { console.error(`已拒绝：${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, entityId: res.fragment.entityId, field, path: res.path }));
    });

  human
    .command("remove <entityId>")
    .description("移除人类：存在未决会话或非终态队列行时拒绝（--force 会归档并记录被孤儿化的内容；fragment 只归档不删除）")
    .option("--force", "即使有已知在途项也归档（每一项都会记录为孤儿化）")
    .action(async (entityId: string, opts: { force?: boolean }) => {
      const { removeHumanFragment, pendingConversationsFor, ADDRESS_DOMAIN } =
        await import("@openrig/daemon/gateway-human-registry");
      const address = `${entityId}@${ADDRESS_DOMAIN}`;
      // 守卫输入 1（文件系统）：未 Ack 的出站决策 = 未决会话。
      const conversations = pendingConversationsFor(entityId);
      // 守卫输入 2（后台服务）：发给该人类的非终态队列行。无法连接的
      // 看板是"不确定"——remove 拒绝而不是编造一个不存在的假象，
      // --force 不适用（它覆盖的是已知在途工作，不是对它的无知）。
      const rowsRes = await queueRows(address);
      if (!rowsRes.ok) {
        console.error(
          `已拒绝：无法检查队列中发给 ${address} 的非终态行（${rowsRes.error}）——` +
          `remove 需要一个可连接的后台服务来证明没有内容会被孤儿化；--force 不覆盖未检查的看板。`,
        );
        process.exitCode = 1;
        return;
      }
      const inflight = [
        ...conversations,
        ...rowsRes.rows.map((r) => ({
          kind: "queue-row" as const,
          id: r.id,
          detail: `${r.state} row ${r.id}${r.summary ? ` — ${r.summary}` : ""}`,
        })),
      ];
      const res = removeHumanFragment(entityId, { force: !!opts.force, inflight });
      if (!res.ok) { console.error(`已拒绝：${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, removed: res.removed, archivedPath: res.archivedPath, ...(res.orphanRecordPath ? { orphanRecordPath: res.orphanRecordPath } : {}) }));
    });

  return cmd;
}
