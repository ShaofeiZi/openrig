// Living Notes Packet 2——composed-review 路由族（OPR.0.4.4.20）。
//
// 端点（单一契约，服务所有消费方——slice Review 标签页、U5 mission-board
// 扩展、For-You 扩展）：
//   GET /api/review/slice/:name        — ComposedSliceReview
//   GET /api/review/mission/:name      — ComposedMissionReview
//   GET /api/review/agents?scope=...   — AgentsBand；scope 是三值参数
//                                        slice:<id> | mission:<id> | rig
//                                        （绝不为每个消费方单独加端点）。
//
// Git 谱系事实在设置 OPENRIG_REVIEW_GIT_REPO 时来自该 repo；
// 否则谱系诚实地降级为 "unknown"（composer 用它手头的东西渲染三个 N1
// 事实——绝不凭记忆下断言）。

import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewGatherer } from "../domain/review/gather.js";
import type { AgentsScope } from "../domain/review/types.js";
import { FileWriteService, sha256Hex } from "../domain/files/file-write-service.js";
import { resolveActorWithDeferral } from "./require-sender-identity.js";
import type { AllowlistRoot } from "../domain/files/path-safety.js";
import { freezeSliceExport, resolveAllowlisted } from "../domain/review/freeze.js";
import { applyBriefSpine } from "../domain/review/brief-spine.js";
import { composeFleet } from "../domain/review/fleet-compose.js";
import { defaultHostRegistryPath, loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { HostRegistryLoadResult } from "../domain/hosts/hosts-registry-reader.js";

function getGatherer(c: { get(key: string): unknown }): ReviewGatherer | null {
  return (c.get("reviewGatherer") as ReviewGatherer | undefined) ?? null;
}

function parseScope(raw: string | undefined): AgentsScope | null {
  if (!raw) return null;
  if (raw === "rig") return raw;
  if (raw.startsWith("slice:") && raw.length > "slice:".length) return raw as AgentsScope;
  if (raw.startsWith("mission:") && raw.length > "mission:".length) return raw as AgentsScope;
  return null;
}

export function reviewRoutes(): Hono {
  const app = new Hono();

  app.get("/agents", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const scope = parseScope(c.req.query("scope"));
    if (!scope) {
      return c.json(
        {
          error: "scope_invalid",
          hint: "scope 必须为以下之一：slice:<id> | mission:<id> | rig",
        },
        400,
      );
    }
    const band = gatherer.composeAgents(scope);
    if (!band) return c.json({ error: "scope_not_found", scope }, 404);
    return c.json(band);
  });

  // OPR.0.4.4.22——rig 范围的独立 altitude 根（FR-1..FR-4）：
  // NEEDS YOU + AGENTS（health 行）+ SETTLED，与 /slice/:name、/mission/:name
  // 同属一个契约族。只读纯投影；面板的常驻开销仅 queue+ps
  // （下钻走已交付的 transcript 路由——按 FR-6，读取面板零新增路由）。
  app.get("/rig", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    return c.json(gatherer.composeRig());
  });

  // OPR.0.4.6.MH5——FLEET 聚合根（arch Q2：与本族并列的兄弟聚合，
  // 绝不是第四个 AgentsScope 值）。扇出每个已注册 host 自己的 composed rig 根，
  // 做并集 + host 维度 + 计数（arch Q1——异常真相绝不在此重算）；本地 host
  // 通过本族使用的同一个 gatherer 进程内加入（D-1）。
  // 只读 + 只展示（FR-5）；bearer 留在服务端（扇出在后台服务侧，
  // 与已交付的 feed 聚合一致）。Registry 访问走与 /api/queue/attention-aggregate
  // 相同的 DI 风格——测试注入 loader/probe；生产回退到共享的 S11 reader。
  app.get("/fleet", async (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const registryLoader = (c.get("hostRegistryLoader" as never) as (() => HostRegistryLoadResult) | undefined) ?? loadHostRegistry;
    const registryProbe = (c.get("hostRegistryExists" as never) as (() => boolean) | undefined) ?? (() => fs.existsSync(defaultHostRegistryPath()));
    const fleet = await composeFleet({
      composeLocalRig: () => gatherer.composeRig(),
      loadRegistry: registryLoader,
      registryExists: registryProbe,
      // 视图时间在边缘进入；并集从不派生 host 时间状态。
      nowIso: new Date().toISOString(),
    });
    return c.json(fleet);
  });

  app.get("/slice/:name", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const composed = gatherer.composeSlice(c.req.param("name"));
    if (!composed) return c.json({ error: "slice_not_found", name: c.req.param("name") }, 404);
    return c.json({ ...composed, sourceObservation: proofSourceObservation(c) });
  });

  app.get("/mission/:name", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const composed = gatherer.composeMission(c.req.param("name"));
    if (!composed) return c.json({ error: "mission_not_found", name: c.req.param("name") }, 404);
    return c.json({ ...composed, sourceObservation: proofSourceObservation(c) });
  });

  // FR-6——唯一的同步 compose-and-freeze 端点（P1/P2 接口单元）。
  // 由 approve 流程在 stamp + audit 行提交之后调用；渲染失败绝不取消批准，
  // 重复调用幂等。无 watcher 循环、无轮询——刻意低频。
  app.post("/freeze", async (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const writeService = (c.get("fileWriteService" as never) as FileWriteService | undefined) ?? null;
    const allowlist = (c.get("filesAllowlist" as never) as AllowlistRoot[] | undefined) ?? [];
    if (!writeService) {
      return c.json(
        {
          error: "file_write_service_unavailable",
          hint: "freeze 写路径受白名单管控；请设置 OPENRIG_FILES_ALLOWLIST=name:/abs/path 并重启后台服务",
        },
        503,
      );
    }
    let body: { scope?: string; name?: string; actor?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body_invalid", hint: 'POST JSON {"scope":"slice","name":"<slice>","actor":"<session>"}' }, 400);
    }
    if (body.scope !== "slice" || !body.name) {
      // 一旦 mission 审批端到端交付（Packet 1 FR-9 mission 语义），mission 级 freeze 走同一路径；
      // slice 是 v1 表面。
      return c.json({ error: "freeze_request_invalid", hint: '必填: {"scope":"slice","name":"<slice>","actor":"<session>"}' }, 400);
    }
    // P21 I5：review freeze 是创始人可见表面——resolveActorWithDeferral，P18 deliver-and-label：
    // 头存在 ⇒ 推导 + transport:v1，线路优先于不匹配的 body（409 已退役，裁决 A）；
    // 头缺失（浏览器 UI）⇒ claimed:v1，不中断。
    const identity = resolveActorWithDeferral(c, { verb: "review 冻结", bodyClaim: body.actor });
    if (!identity.ok) return identity.response;
    const ctx = gatherer.composeSliceWithContext(body.name);
    if (!ctx) return c.json({ error: "slice_not_found", name: body.name }, 404);
    const outcome = freezeSliceExport({
      composed: ctx.composed,
      sliceDir: ctx.sliceDir,
      mediaRefs: ctx.mediaRefs,
      allowlist,
      writeService,
      actor: identity.session,
      identityProvenance: identity.provenance,
    });
    if (!outcome.ok) {
      const status = outcome.error === "stamp_missing" ? 409 : outcome.error === "allowlist_missing" ? 403 : 500;
      return c.json({ error: outcome.error, message: outcome.message, hint: outcome.hint }, status);
    }

    // FR-8：freeze 本就是两个刻意的 brief 写入时刻之一——
    // 把生成的 status spine 折进 MISSION_BRIEF.md，按 section 范围、保持 schema 顺序。
    // 尽力而为：brief 写失败绝不取消 freeze（export + stamp 已成立）；它以 warning 形式显现。
    let briefWrite: string | null = null;
    if (!outcome.alreadyFrozen && ctx.composed.missionId) {
      try {
        const mission = gatherer.composeMission(ctx.composed.missionId);
        const target = gatherer.missionBriefTarget(ctx.composed.missionId);
        if (mission && target) {
          const applied = applyBriefSpine(target.content, mission.briefSpine);
          if (applied === null) {
            briefWrite = "已跳过：MISSION_BRIEF.md 不含被锁定的精确顺序 schema（生成绝不猜测重写格式错误的 brief）";
          } else if (applied !== target.content) {
            const stat = fs.statSync(target.briefPath);
            const mapped = resolveAllowlisted(allowlist, path.dirname(target.briefPath));
            if (!mapped) {
              briefWrite = "已跳过：mission 文件夹不在 OPENRIG_FILES_ALLOWLIST 之下";
            } else {
              writeService.writeAtomic({
                rootName: mapped.root,
                path: path.join(mapped.rel, "MISSION_BRIEF.md"),
                content: applied,
                expectedMtime: stat.mtime.toISOString(),
                expectedContentHash: sha256Hex(target.content),
                actor: identity.session,
                identityProvenance: identity.provenance,
              });
              briefWrite = "spine 已更新";
            }
          } else {
            briefWrite = "spine 无变化";
          }
        }
      } catch (err) {
        briefWrite = `失败（freeze 不受影响）：${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return c.json({ ok: true, path: outcome.path, alreadyFrozen: outcome.alreadyFrozen, briefWrite });
  });

  return app;
}
