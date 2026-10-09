import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { EventBus } from "../domain/event-bus.js";
import { JudgmentError, evidenceAt, readSliceReadiness, readMissionReadiness, readProjectReadiness, recordJudgment, resolveProofScope, type JudgeInput } from "../domain/proof/judgments.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

export function proofRoutes(): Hono {
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof JudgmentError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    return c.json({ error: "proof_unavailable", message: e.message }, 503);
  });
  const indexer = (c: { get: (key: never) => unknown }): SliceIndexer => {
    const value = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!value?.isReady()) throw new JudgmentError("workspace_unavailable", "在读取或记录判定前，请先配置后台服务工作区", 503);
    return value;
  };
  app.get("/", c => {
    const root = indexer(c).slicesRoot, scope = c.req.query("scope");
    if (!scope) return c.json({ ...readProjectReadiness(root), sourceObservation: proofSourceObservation(c) });
    const dir = resolveProofScope(root, scope);
    if (path.basename(path.dirname(dir)) !== "slices") return c.json({ ...readMissionReadiness(dir), sourceObservation: proofSourceObservation(c) });
    const refs = c.req.queries("evidence") ?? [];
    return c.json({ ...readSliceReadiness(dir), sourceObservation: proofSourceObservation(c), ...(refs.length ? { preparedEvidence: refs.map(ref => evidenceAt(path.dirname(root), dir, ref)) } : {}) });
  });
  app.post("/judge", async c => {
    const body = await c.req.json<JudgeInput & { actorSession?: string }>().catch(() => null);
    if (!body || typeof body.scope !== "string" || typeof body.item !== "string" || typeof body.expectedRevision !== "string" || !(body.expectedPrevious === null || typeof body.expectedPrevious === "string") || (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some(e => typeof e !== "string")))) throw new JudgmentError("judgment_invalid", "请提供 scope、item、预期 revision/前置项与证据引用；zrig proof judge 在常规路径中解析这些");
    if ((body.actorSession !== undefined && typeof body.actorSession !== "string") || typeof body.reason !== "string" || (body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim())) || (body.subject !== undefined && (!body.subject || typeof body.subject !== "object" || typeof body.subject.kind !== "string" || typeof body.subject.ref !== "string")) || (body.replace !== undefined && typeof body.replace !== "boolean")) throw new JudgmentError("judgment_invalid", "reason、操作身份与 subject 必须符合其声明的类型");
    if (body.expectedEvidence !== undefined && (!Array.isArray(body.expectedEvidence) || body.expectedEvidence.some(e => !e || typeof e.ref !== "string" || typeof e.sha256 !== "string"))) throw new JudgmentError("judgment_invalid", "预期证据必须是预备好的引用/摘要对");
    if (body.subject?.comparison !== undefined && typeof body.subject.comparison !== "string") throw new JudgmentError("judgment_invalid", "comparison 必须是一个证据引用");
    const identity = requireSenderIdentity(c, { verb: "证明判定", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    const owner = indexer(c);
    const result = recordJudgment(owner.slicesRoot, body, identity.session, resolveRecordedProvenance(c, identity));
    owner.invalidate();
    // 回执已是持久的。丢失一次通知绝不能把一次已提交的写变成号称的回滚。
    let notification = "unchanged";
    if (!result.replayed) {
      try {
        const bus = c.get("eventBus" as never) as EventBus | undefined;
        if (!bus) notification = "不可用；直接读取即为最新，静默刷新可修复视图";
        else { bus.emit({ type: "proof.judged", scope: body.scope, revision: result.readiness.revision }); notification = "emitted"; }
      } catch { notification = "不可用；静默刷新可修复视图"; }
    }
    return c.json({ ...result, notification }, result.replayed ? 200 : 201);
  });
  return app;
}
