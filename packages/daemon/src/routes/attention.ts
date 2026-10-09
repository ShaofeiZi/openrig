import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AttentionRead, AttentionItem } from "../attention-surface.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { isHumanSeatSessionRef } from "../domain/session-name.js";
import type { HealthProjectionService } from "../domain/health-detectors.js";
import type { OperatingPostureService } from "../domain/rig-mode/operating-posture.js";
import { listProjects, insideProject, projectMission, type ProjectRead } from "../domain/workspace/project-read.js";
import { readMissionReadiness } from "../domain/proof/judgments.js";
import { WorkflowInstanceStore } from "../domain/workflow-instance-store.js";
import { WorkflowStepTrailLog } from "../domain/workflow-step-trail-log.js";

export function attentionRoutes(): Hono {
  const app = new Hono();
  app.get("/", c => {
    const wanted = c.req.query("item");
    const result: AttentionRead = { scope: "instance", readAt: new Date().toISOString(), items: [], sources: [], detail: null, detailError: null };
    const add = (item: AttentionItem, lines: () => string[], files: () => Array<{ label: string; path: string }> = () => []) => {
      if (!result.items.some(i => i.id === item.id)) result.items.push(item);
      if (wanted === item.id) result.detail = { item, lines: lines(), files: files() };
    };
    const unavailable = (source: string, error: unknown) => result.sources.push({ source, state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
    let projects: ProjectRead[] = [];
    try {
      projects = listProjects(c).projects;
      result.sources.push({ source: "project catalog", state: "available", detail: "精确的目录身份；未带范围的请求仍属实例级事实。" });
    } catch (e) { unavailable("project catalog", e); }
    const queue = c.get("queueRepo" as never) as QueueRepository | undefined;
    const posture = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
    try {
      if (!queue) throw new Error("队列仓库不可用");
      const rows = queue.listAttention({ limit: 1001 });
      result.sources.push({ source: "queue", state: rows.length >= 1001 ? "partial" : "available", detail: rows.length >= 1001 ? "待关注查询已达 1001 行；最多展示 1000 条。" : "开放的人工请求与明确的人工阻塞；单靠人工门这一层并不够。" });
      const current = rows.slice(0, 1000).filter(q => isHumanSeatSessionRef(q.destinationSession) || q.state === "blocked" && isHumanSeatSessionRef(q.blockedOn ?? ""));
      // 让一个已打开的请求在其来源解决后仍可检视，而不必把它保留在当前「需要处理」 feed 里，
      // 也不臆造一个收件箱。
      const opened = wanted?.startsWith("queue:") ? queue.getById(wanted.slice(6)) : null;
      const detailOnly = opened && !current.some(q => q.qitemId === opened.qitemId) ? opened : null;
      for (const q of [...current, ...(detailOnly ? [detailOnly] : [])]) {
        const tags = [...new Set((q.tags ?? []).filter(t => t.startsWith("project:")).map(t => t.slice(8)))];
        const p = tags.length === 1 ? projects.find(p => p.id === tags[0] && !p.error) : undefined;
        const deps = queue.db.prepare("SELECT summary, qitem_id FROM queue_items WHERE blocked_on = ? AND state IN ('pending','in-progress','blocked') ORDER BY ts_created DESC LIMIT 101").all(q.qitemId) as Array<{ summary: string | null; qitem_id: string }>;
        const unblocks = isHumanSeatSessionRef(q.blockedOn ?? "") ? q.summary || "被阻塞任务（检视该请求）" : deps.length ? deps.slice(0, 100).map(d => d.summary || "未命名的依赖任务").join("; ") + (deps.length > 100 ? "；更多依赖已省略" : "") : "未记录依赖任务；检视该请求以了解其预期结果。";
        const item: AttentionItem = { id: `queue:${q.qitemId}`, kind: "action", recipient: isHumanSeatSessionRef(q.destinationSession) ? q.destinationSession : q.blockedOn, summary: q.summary || q.body.trim().split(/\r?\n/).find(Boolean) || "请求摘要不可用", urgency: q.priority, unblocks, at: q.tsUpdated, scope: p ? `项目 ${p.id}` : "实例 · 项目未知", project: p ? { id: p.id, root: p.root } : null, source: `/api/queue/${encodeURIComponent(q.qitemId)}` };
        add(item, () => {
          const mode = posture?.resolve({ qitemId: q.qitemId });
          return ["请求：", q.body, ...(q.humanDetail ? ["补充细节：", q.humanDetail] : []), `状态：${q.state}`, `发往：${q.destinationSession}`, `来自：${q.sourceSession}`, `阻塞于：${q.blockedOn ?? "无"}`, `姿态：${mode?.posture ?? "未知"} · ${mode?.reason ?? "姿态来源不可用"}`, `证据引用：${q.evidenceRef ?? "未记录"}`, `决策路径：在 Slack 中跟进对应的人工请求。检视：zrig queue show ${q.qitemId} --full`, "队列历史（读/投递不等于批准）：", ...queue.listTransitions(q.qitemId).map(t => JSON.stringify(t))];
        }, () => {
          if (!q.evidenceRef || !path.isAbsolute(q.evidenceRef) && (!p || /^[a-z][a-z\d+.-]*:/i.test(q.evidenceRef))) return [];
          const hash = q.evidenceRef.indexOf("#"), anchor = hash < 0 ? "" : q.evidenceRef.slice(hash);
          let file = hash < 0 ? q.evidenceRef : q.evidenceRef.slice(0, hash);
          file = path.isAbsolute(file) ? file : path.resolve(p!.root, file);
          try { file = fs.realpathSync(file); } catch { /* 文件读取器会上报不可用来源。 */ }
          return [{ label: "请求证据", path: file + anchor }];
        });
        if (q === detailOnly) result.items = result.items.filter(i => i.id !== item.id);
      }
    } catch (e) { unavailable("queue", e); }
    for (const p of projects) {
      const source = `proof: project ${p.id}`;
      try {
        if (p.error) throw new Error(p.error);
        insideProject(p.root, p.missionsRoot);
        const missions = fs.readdirSync(p.missionsRoot, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink());
        result.sources.push({ source, state: missions.length > 200 ? "partial" : "available", detail: "按 mission/slice 的原生结果判定；不从队列状态推断完成。最多 200 个 mission。" });
        for (const entry of missions.slice(0, 200)) {
          try {
            const dir = projectMission(p, entry.name), mission = readMissionReadiness(dir);
            if (mission.issues.length) result.sources.push({ source: `${source}/${entry.name}`, state: "partial", detail: mission.issues.join("; ") });
            for (const slice of mission.slices) {
              const ready = slice.readiness;
              if (ready.issues.length) result.sources.push({ source: `${source}/${entry.name}/${slice.scope}`, state: "partial", detail: ready.issues.join("; ") });
              for (const proof of ready.items) {
                if (!proof.judgment) continue;
                const j = proof.judgment, scope = `${entry.name}/slices/${slice.scope}`;
                const item: AttentionItem = { id: `proof:${p.id}:${scope}:${proof.id}`, kind: "update", summary: `${proof.text} · ${proof.state}`, urgency: "outcome", unblocks: null, at: j.at, scope: `project ${p.id} · ${scope}`, project: { id: p.id, root: p.root }, source: path.resolve(dir, "slices", slice.scope, proof.source.file) };
                add(item, () => [`当前证明状态：${proof.state} · ${proof.reason}`, `slice 就绪：${ready.state}；mission 就绪：${mission.state}。就绪本身并不关闭一个 mission。`, `判定者：${j.actor}，时间 ${j.at}`, `理由：${j.reason}`, `姿态：${posture?.resolve({ projectId: p.id, missionId: entry.name }).posture ?? "未知"}；归属的证明不授予额外权限。`, `证据：${j.evidence.map(e => `${e.ref} (sha256 ${e.sha256})`).join("; ")}`, "判定历史：", ...ready.history.filter(h => h.itemId === proof.id).map(h => `${h.verdict} · ${h.id} · 上一版 ${h.previous ?? "无"} · ${h.ref}`)], () => [{ label: "结果契约", path: item.source }, ...ready.history.filter(h => h.itemId === proof.id).map(h => ({ label: `判定：${h.verdict}`, path: path.resolve(p.root, h.ref) }))]);
              }
            }
          } catch (e) { unavailable(`${source}/${entry.name}`, e); }
        }
      } catch (e) { unavailable(source, e); }
    }
    try {
      if (!queue) throw new Error("工作流仓库不可用");
      const ids = queue.db.prepare("SELECT instance_id FROM workflow_instances WHERE lifecycle_binding_json IS NOT NULL ORDER BY created_at DESC LIMIT 201").all() as Array<{ instance_id: string }>;
      const instances = new WorkflowInstanceStore(queue.db), trails = new WorkflowStepTrailLog(queue.db);
      result.sources.push({ source: "mission outcomes", state: ids.length > 200 ? "partial" : "available", detail: "最多 200 个绑定 manifest 的工作流；带归属的终结回执及当前工作流状态。未绑定的历史工作流被排除。" });
      for (const { instance_id: id } of ids.slice(0, 200)) {
        const instance = instances.getByIdOrThrow(id), binding = instance.lifecycleBinding!;
        const identity = binding.identity as { project?: string; mission?: string } | undefined;
        const p = projects.find(p => p.id === identity?.project && !p.error);
        if (!p || !identity?.mission) continue;
        const sources = binding.sources as Array<{ kind: string; path: string }> | undefined;
        const mission = projectMission(p, identity.mission);
        if (!sources?.some(s => s.kind === "project" && s.path === path.join(p.root, "project.yaml")) || !sources.some(s => s.kind === "mission" && s.path === path.join(mission, "mission.yaml"))) continue;
        const history = trails.listForInstance(id, 201), receipt = history.find(t => t.closureReason === "done" || t.closureReason === "failed");
        if (!receipt) continue;
        const item: AttentionItem = { id: `workflow:${id}`, kind: "update", summary: `${identity.mission}: ${receipt.stepId} ${receipt.closureReason} · workflow ${instance.status}`, urgency: "outcome", unblocks: null, at: receipt.closedAt, scope: `project ${p.id} · mission ${identity.mission}`, project: { id: p.id, root: p.root }, source: `/api/workflow/${encodeURIComponent(id)}/trace` };
        add(item, () => [`当前工作流状态：${instance.status}；单步回执本身并不完成 mission。`, `姿态：${posture?.resolve({ projectId: p.id, missionId: identity.mission }).posture ?? "未知"}`, `执行者：${receipt.actorSession}`, `结果证据：${JSON.stringify(receipt.closureEvidence)}`, `工作流历史${history.length > 200 ? "（部分：仅显示保留的 200 条）" : ""}：`, ...history.slice(0, 200).map(t => JSON.stringify(t))], () => [{ label: "Mission 权威", path: path.join(mission, "mission.yaml") }]);
      }
    } catch (e) { unavailable("mission outcomes", e); }
    try {
      const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
      if (!service) throw new Error("健康状态投影不可用");
      // 规范事件提供状态与观测时间，包括保留的清除。无活跃流、无推断的跃迁、无新的保留存储。
      const records = service.records().filter(r => r.severity !== "info" && (!r.ceremony || r.ceremony.stage === "confirmed" || r.ceremony.stage === "cleared"));
      result.sources.push({ source: "health", state: records.length > 200 ? "partial" : "available", detail: "重要的规范事件（含保留的清除），最多 200 条。以来源保留上限为准；缺失不等于已恢复。" });
      for (const r of records.slice(0, 200)) {
        const projectId = "projectId" in r.scope ? r.scope.projectId : undefined;
        const p = projects.find(p => p.id === projectId && !p.error);
        const item: AttentionItem = { id: `health:${r.id}`, kind: "update", summary: `${r.summary} · ${r.status}`, urgency: r.severity, unblocks: null, at: r.lastObservedAt, scope: `instance health · ${Object.values(r.scope).join(" / ")}`, project: p ? { id: p.id, root: p.root } : null, source: `/api/health/${encodeURIComponent(r.id)}` };
        add(item, () => [`状态：${r.status}；首次观测 ${r.startedAt ?? "未知"}；最近观测 ${r.lastObservedAt ?? "未知"}`, `新鲜度：${r.freshness.state}；${r.indeterminateReason ?? ""}`, `姿态：${r.operatingPosture?.posture ?? "未知"} · ${r.operatingPosture?.reason ?? "来源未提供"}`, r.explanation, r.suggestedInspection, `阈值：${r.threshold}`, "规范来源与有界证据：", JSON.stringify(r, null, 2)]);
      }
    } catch (e) { unavailable("health", e); }
    result.items.sort((a, b) => a.kind.localeCompare(b.kind) || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
    if (wanted && !result.detail) result.detailError = "所选来源不可用或不在当前来源窗口内。返回待关注页刷新；缺失不等于已解决。";
    return c.json(result);
  });
  return app;
}
