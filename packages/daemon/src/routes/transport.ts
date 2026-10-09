import { Hono } from "hono";
import type { SessionTransport, TargetSpec } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity } from "./require-sender-identity.js";
import type { OutboxHandler } from "../domain/outbox-handler.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";

// S2（OPR.0.5.4.3）——两端诚实的发送方半侧：附加到任何未归属投递的成功响应上，
// 由 CLI renderer 呈现。按 S1 成功响应的诚实门槛：发生了什么、接收方无法知道什么、
// 以及具体修复方式（签名）。
const UNKNOWN_SENDER_NOTICE =
  "以无发送方身份投递：本请求未携带 X-OpenRig-Session 头，接收方无法知道是谁发的。请跟进并签名——从席位 shell 发送（该头会自动盖），或在消息正文中说明你的身份。";

// 未知发送方 From: 标记，从规范 envelope wrapper DERIVED（pane-envelope.ts 的
// SENDER_FALLBACK 未导出，其字面量被 canonicity 守卫在恰好两个孪生位置）——
// 在模块加载时派生，保持单一事实源、无第三处定义。wrapPaneEnvelope 在 sender 缺失时
// 渲染 "From: <marker>" 作为首行。
const UNKNOWN_SENDER_MARKER = wrapPaneEnvelope(undefined, "", "").split("\n")[0]!.replace(/^From: /, "");

export function transportRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();

  const terminalToken = opts?.bearerToken ?? null;
  router.use("*", authBearerTokenMiddleware({ expectedToken: terminalToken }));

  router.post("/send", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      deliveryId?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      submitOnly?: boolean;
      expectedStagedText?: string;
      expectedStagedLineCount?: number;
    }>();

    // submitOnly（mechanics-gate fix d9b3989a）不发送任何文本——对已 staged 内容只按 Enter 的重试；
    // 其他所有 send 仍需 text。
    if (!body.session || (!body.text && !body.submitOnly)) {
      return c.json({ error: "缺少必填字段：session、text" }, 400);
    }
    // OPR.0.4.1.10——danger override 与 wait 模式互斥；在 transport 之前拒绝。
    if (body.dangerouslyInteract && body.waitForIdleMs !== undefined) {
      return c.json({
        ok: false,
        reason: "invalid_dangerously_interact",
        error: "--dangerously-interact 不能与 --wait-for-idle 组合。未发送任何文本。",
      }, 400);
    }
    // override 必须携带 reason 以记入审计。
    if (body.dangerouslyInteract && (!body.reason || body.reason.trim().length === 0)) {
      return c.json({
        ok: false,
        reason: "dangerously_interact_requires_reason",
        error: "--dangerously-interact 需要 --reason 说明为何要驱动 prompt。未发送任何文本。",
      }, 400);
    }
    if (body.waitForIdleMs !== undefined) {
      if (body.force) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle 不能与 force 组合。未发送任何文本。",
        }, 400);
      }
      if (typeof body.waitForIdleMs !== "number" || !Number.isFinite(body.waitForIdleMs) || body.waitForIdleMs <= 0) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs 必须是正数。未发送任何文本。",
        }, 400);
      }
    }

    // P21 I4 + S2（OPR.0.5.4.3）：actor（--dangerously-interact override 的审计 actor）
    // 从 transport 头 DERIVED，绝不来自 body.actorSession。body 中不同的声明只是被取代，
    // 绝不拒绝：wire 决定 actor，body 永不决定（PM 裁定 (A)，2026-08-11——见
    // require-sender-identity.ts:16-22）。头缺失不再拒绝（founder descope，S2）：
    // 欺骗者加个头就能绕过拒绝，401 只会拦住诚实的未计数调用方。改为：send 照常投递，
    // 本就可空的审计 actor 记为 null（投影为 "unknown"），响应携带下面的签名提示。
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;

    // 先检查歧义
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    const result = await transport.send(body.session, body.text ?? "", {
      deliveryId: body.deliveryId,
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // 从 transport 派生，绝不取 body 声明
      // Mechanics-gate fix（d9b3989a）：walk 重试的裸 Enter 模式，
      // 在 transport 中由 expected-staged-text 预检守卫。
      submitOnly: body.submitOnly,
      expectedStagedText: body.expectedStagedText,
      expectedStagedLineCount: body.expectedStagedLineCount,
    });

    if (result.outcome === "retained") return c.json(result);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        typing_guard_enabled: 409,
        guard_target_unknown: 409,
        guard_target_changed: 409,
        delivery_identity_conflict: 409,
        retained_quota_full: 409,
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        mid_work: 409,
        invalid_wait_for_idle: 400,
        invalid_dangerously_interact: 400,
        dangerously_interact_requires_reason: 400,
        wait_for_idle_timeout: 409,
        target_needs_input: 409,
        target_activity_unknown: 409,
        prompt_override_audit_unavailable: 500,
        submit_failed: 502,
        send_failed: 502,
        invalid_submit_only: 400,
        staged_mismatch: 409,
      };
      const status = (statusMap[result.reason ?? ""] ?? 500) as 400 | 404 | 409 | 500 | 502 | 503;
      return c.json(result, status);
    }

    // A3（P22）：把已 dispatch 的 send 自动记入发送方 outbox，使派生 send 不能在审计层
    // accept-and-drop（specimen-5 窗口：无 outbox 行，归属仅靠 provider JSONL 存活）。
    // 严格位于已认证头派生（line 65）的下游：消费已派生的 `derivedActor`，绝不重新派生或修改。
    // 只记录 DERIVED send（`derivedActor` 存在时），带 era 戳 `transport:v1`
    // （此头派生路由产出的唯一模式；跨 host relay 的头就是 origin 三元组，因此记录的
    // sender 是 ORIGIN，绝不是 relay）。null-actor send 没有可归属的派生 sender（不造行）。
    // send 已提交，因此罕见的审计写失败只记日志，绝不变成已投递 send 的假阴性。
    if (derivedActor && !body.submitOnly) { // submitOnly 不输入文本——无需记入 outbox
      const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
      if (outbox) {
        try {
          outbox.record({
            senderSession: derivedActor,
            destinationSession: body.session,
            body: body.text,
            identityProvenance: "transport:v1",
          });
        } catch (err) {
          console.warn(`[transport/send] outbox 自动记录失败（send 已投递）：${(err as Error).message}`);
        }
      }
    }

    // S2（OPR.0.5.4.3）发送方诚实：未归属投递在 CLI renderer 呈现的成功响应上告知发送方，
    // 接收方无法知道是谁发的。与既有 transport warning 叠加；已归属的 send 无变化、无打扰。
    if (!derivedActor) {
      result.warning = result.warning ? `${result.warning} ${UNKNOWN_SENDER_NOTICE}` : UNKNOWN_SENDER_NOTICE;
    }

    return c.json(result);
  });

  router.post("/capture", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      rig?: string;
      pod?: string;
      lines?: number;
    }>();

    // 多目标：rig 或 pod
    if (body.rig || body.pod) {
      const target: TargetSpec = body.pod
        ? { pod: body.pod, rig: body.rig }
        : { rig: body.rig! };

      const resolved = await transport.resolveSessions(target);
      if (!resolved.ok) {
        return c.json({ ok: false, error: resolved.error }, 404);
      }

      const results = [];
      for (const session of resolved.sessions) {
        const result = await transport.capture(session.sessionName, { lines: body.lines });
        results.push(result);
      }
      return c.json({ results });
    }

    // 单目标：session
    if (!body.session) {
      return c.json({ error: "请提供要 capture 的 session、rig 或 pod" }, 400);
    }

    const result = await transport.capture(body.session, { lines: body.lines });
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        capture_failed: 502,
      };
      const status = (statusMap[result.reason ?? ""] ?? 404) as 404 | 409 | 502 | 503;
      return c.json(result, status);
    }
    return c.json(result);
  });

  router.post("/broadcast", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      rig?: string;
      pod?: string;
      // OPR.0.4.3.30——显式多接收方列表（`zrig send --to a,b`）。
      sessions?: string[];
      text: string;
      verify?: boolean;
      force?: boolean;
      // OPR.0.4.3.30——透传使 `zrig send` fan-out 携带与单 send 相同的 guard/wait 语义。
      // 在 broadcast() 循环内按接收方逐个应用（danger 审计每席位触发一次，而非每批一次）。
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      // OPR.0.4.3.30——设置时，fan-out 为每个接收方包裹独立的 From/To envelope。
      // `zrig broadcast` 从不设置它（raw-to-all，不变）。
      envelopeSender?: string | null;
    }>();

    if (!body.text) {
      return c.json({ error: "缺少必填字段：text" }, 400);
    }

    // P21 I4 + S2（OPR.0.5.4.3）：--dangerously-interact override 的审计 actor 从
    // transport 头 DERIVED（见 /send）。头缺失不再拒绝——send 继续，
    // 本就可空的审计 actor 记为 null（投影为 "unknown"）；响应携带下面的签名提示。
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;

    // P21 I4（orch 自 specimen 5 裁定——事件中被采信的假 "From: pm-lead"）：渲染进每个
    // 接收方终端的 From: 行必须从 transport 身份 DERIVED，绝不来自 body 值。
    // body.envelopeSender 存在表示带 envelope 的 fan-out（zrig send）；其值被忽略，
    // From: 即派生 actor。跨 host relay 从其自己的已鉴权 context 重盖 X-OpenRig-Session
    // （不是调用方的 --from 字符串）。S2（OPR.0.5.4.3）：不可归属的带 envelope send 现在以
    // 显式未知发送方标记作为 From: 投递——specimen-5 规则原样保留：body 声明仍绝不渲染；
    // 接收方看到诚实的 "unknown"，绝不是未核实的名字。裸 `zrig broadcast` = 无 envelope。
    let envelopeSender: string | undefined = undefined;
    if (body.envelopeSender !== undefined && body.envelopeSender !== null) {
      envelopeSender = derivedActor ?? UNKNOWN_SENDER_MARKER;
    }

    const target: TargetSpec =
      body.sessions && body.sessions.length > 0
        ? { sessions: body.sessions }
        : body.pod
          ? { pod: body.pod, rig: body.rig }
          : body.rig
            ? { rig: body.rig }
            : { global: true };

    const result = await transport.broadcast(target, body.text, {
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // 从 transport 派生，绝不取 body 声明
      envelopeSender, // From: 是派生身份（绝非 body 值）——orch 裁定 (a)
    });

    // A3b（P22 follow-on，planner 裁定在范围内）：自动记录 fan-out——N 行，每个已解析
    // 接收方一行。schema 是按接收方设计的（destination_session 有类型+索引；每行有
    // delivery_state），因此部分 fan-out 按接收方记录真相，绝不有损聚合。严格位于已认证
    // 派生（上面的 derivedActor）下游：每行的 sender 是已派生 actor；destination = 已解析
    // session，绝不 TargetSpec（那会污染有类型的 session 列）。每行 best-effort：fan-out 已
    // dispatch，罕见的审计写失败只记日志，绝不变成投递假阴性。
    if (derivedActor) {
      const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
      if (outbox) {
        for (const r of result.results) {
          if (!r.sessionName || r.outcome === "retained") continue;
          try {
            const entry = outbox.record({
              senderSession: derivedActor,
              destinationSession: r.sessionName,
              body: body.text,
              identityProvenance: "transport:v1",
            });
            if (r.ok) outbox.markDelivered(entry.outboxId);
            else outbox.markFailed(entry.outboxId);
          } catch (err) {
            console.warn(`[transport/broadcast] outbox 自动记录失败（${r.sessionName}，fan-out 已 dispatch）：${(err as Error).message}`);
          }
        }
      }
    }

    // S2（OPR.0.5.4.3）发送方诚实：未归属 fan-out 的响应携带签名提示，供 CLI renderer
    // 呈现。已归属 fan-out 不变。
    if (!derivedActor) {
      return c.json({ ...result, warning: UNKNOWN_SENDER_NOTICE });
    }
    return c.json(result);
  });

  return router;
}
