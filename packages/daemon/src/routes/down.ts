import { DeliveryGuardError } from "../domain/seat-delivery-guard.js";
import { Hono } from "hono";
import type { RigTeardownOrchestrator } from "../domain/rig-teardown.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { RigNotFoundError } from "../domain/errors.js";

export const downRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    teardownOrchestrator: c.get("teardownOrchestrator" as never) as RigTeardownOrchestrator,
  };
}

/**
 * POST /api/down —— 拆除一个工作组。
 * @param rigId - 必填的工作组标识符
 * @param delete - 可选，停止后删除工作组记录
 * @param force - 可选，立即杀死会话
 * @param snapshot - 可选，拆除前打快照
 * @returns 拆除结果 TeardownResult
 */
downRoutes.post("/", async (c) => {
  const { teardownOrchestrator } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : "";
  const deleteRig = body["delete"] === true;
  const force = body["force"] === true;
  const snapshot = body["snapshot"] === true;

  if (!rigId) {
    return c.json({ error: "rigId 为必填项" }, 400);
  }

  try {
    const result = await teardownOrchestrator.teardown(rigId, {
      delete: deleteRig,
      force,
      snapshot,
    });

    // 确定 HTTP 状态码
    if (deleteRig && !result.deleted) {
      if (result.deleteBlocked) {
        return c.json(result, 409);
      }
      return c.json(result, 500);
    }

    // 在响应中带上工作组名 + 唯一性，供命令后交接使用
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const rig = rigRepo.getRig(rigId);
    const rigName = rig?.rig.name ?? null;
    const isUniqueName = rigName ? rigRepo.findRigsByName(rigName).length === 1 : false;
    const enriched = { ...result, rigName, isUniqueName };
    return c.json(enriched, 200);
  } catch (err) {
    if (err instanceof DeliveryGuardError) throw err;
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});
