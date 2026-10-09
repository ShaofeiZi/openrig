// PL-007 Workspace Primitive v0——工作区 HTTP 路由。
//
// 只读端点：
//
//   POST /api/workspace/validate
//     body: { root: string; workspaceKind?: WorkspaceKind;
//              recursive?: boolean; requireFrontmatter?: boolean;
//              maxFiles?: number }
//     response: FrontmatterValidationReport
//
//   POST /api/workspace/doctor  (slice-21 FR-5)
//     body（全部可选）：{ workspaceRoot?: string;
//                            filesAllowlistOverride?: string }
//     response: DoctorReport（8 项检查的工作区就绪度报告）
//
// 不做任何文件系统变更。操作员每次调用自行选择 root + kind。
//
// Whoami / node-inventory 通过既有路由暴露工作区数据；
// 不另设 /api/workspace/whoami。

import { Hono } from "hono";
import * as path from "node:path";
import {
  validateWorkspaceFrontmatter,
  type ValidateOpts,
} from "../domain/workspace/frontmatter-validator.js";
import { WORKSPACE_KINDS, type WorkspaceKind } from "../domain/types.js";
import {
  runWorkspaceDoctor,
  type WorkspaceRootSource,
} from "../domain/workspace/workspace-doctor.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";

export function workspaceRoutes(): Hono {
  const app = new Hono();

  app.post("/validate", async (c) => {
    const body = await c.req.json<{
      root?: string;
      workspaceKind?: string;
      recursive?: boolean;
      requireFrontmatter?: boolean;
      maxFiles?: number;
    }>().catch(() => ({} as never));

    if (!body.root || typeof body.root !== "string") {
      return c.json({ error: "root_required", message: "root 为必填项" }, 400);
    }
    let kind: WorkspaceKind | undefined;
    if (body.workspaceKind !== undefined) {
      if (!(WORKSPACE_KINDS as readonly string[]).includes(body.workspaceKind)) {
        return c.json({
          error: "invalid_workspace_kind",
          message: `workspaceKind 必须为以下之一：${[...WORKSPACE_KINDS].join(", ")}`,
        }, 400);
      }
      kind = body.workspaceKind as WorkspaceKind;
    }

    const opts: ValidateOpts = {
      root: body.root,
      ...(kind !== undefined ? { workspaceKind: kind } : {}),
      ...(body.recursive !== undefined ? { recursive: body.recursive } : {}),
      ...(body.requireFrontmatter !== undefined ? { requireFrontmatter: body.requireFrontmatter } : {}),
      ...(body.maxFiles !== undefined ? { maxFiles: body.maxFiles } : {}),
    };
    try {
      const report = validateWorkspaceFrontmatter(opts);
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "内部错误";
      return c.json({ error: "validate_failed", message }, 500);
    }
  });

  // Slice-21 FR-5——工作区 doctor。
  //
  // 从后台服务 SettingsStore（与 /api/config 一致）解析全部输入，
  // 运行 8 项检查编排器，返回 DoctorReport。调用方可通过
  // body.workspaceRoot 覆盖被检查的工作区——便于 `zrig workspace doctor
  // --workspace <path>` 探测另一个工作区而无需重启后台服务。覆盖时，
  // check #4（后台服务指向本工作区）仍解析后台服务侧的 workspace.root。
  app.post("/doctor", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);

    const body = await c.req.json<{
      workspaceRoot?: string;
      filesAllowlistOverride?: string;
    }>().catch(
      () => ({} as { workspaceRoot?: string; filesAllowlistOverride?: string }),
    );

    try {
      const daemonResolved = store.resolveOne("workspace.root");
      const workspaceUnderCheck =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? body.workspaceRoot
          : (daemonResolved.value as string);
      // 调用方提供的 workspaceRoot 在 fix-hint 上被视为操作员的显式选择
      // （类似 env）。未提供时，来源是后台服务实际的解析通道
      // （env / file / default）。
      const workspaceRootSource: WorkspaceRootSource =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? "env"
          : (daemonResolved.source as WorkspaceRootSource);

      // 调用方覆盖工作区时，slicesRoot 默认取 `<workspaceRoot>/missions`
      // （与 ConfigStore 对未设置的 workspace.slices_root 的推导一致）。
      // 未覆盖时，采用后台服务解析出的 slicesRoot。
      const slicesRoot =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? path.join(body.workspaceRoot, "missions")
          : (store.resolveOne("workspace.slices_root").value as string);

      // FR-5e A2——files.allowlist CLI 侧 env 覆盖。当 CLI 在自己的 shell 里
      // 设置 OPENRIG_FILES_ALLOWLIST 时，后台服务 SettingsStore 观察不到
      // 该 env（不同进程）；CLI 把原始值作为 body.filesAllowlistOverride
      // 转发，我们在此以 source="env" 采纳，使 check #3 的 fix-hint
      // 指向正确的修复通道。
      const allowlistResolved = store.resolveOne("files.allowlist");
      const usingAllowlistOverride =
        typeof body.filesAllowlistOverride === "string"
        && body.filesAllowlistOverride.length > 0;
      const allowlistValue = usingAllowlistOverride
        ? body.filesAllowlistOverride!
        : (allowlistResolved.value as string);
      const allowlistSource: WorkspaceRootSource = usingAllowlistOverride
        ? "env"
        : (allowlistResolved.source as WorkspaceRootSource);

      // 后台服务启动时间在请求时从 process.uptime() 捕获。按已入库的约定
      // （见 workspace-doctor.ts：CheckDaemonReloadInput.daemonStartTime JSDoc），
      // 这是务实的近似——足以回答「启动后配置是否变过」，但不考虑显式时钟漂移。
      const daemonStartTime = new Date(Date.now() - process.uptime() * 1000);

      const report = runWorkspaceDoctor({
        workspaceRoot: workspaceUnderCheck,
        workspaceRootSource,
        slicesRoot,
        allowlistValue,
        allowlistSource,
        daemonResolvedWorkspaceRoot: daemonResolved.value as string,
        configFilePath: store.configPath,
        daemonStartTime,
      });
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "内部错误";
      return c.json({ error: "doctor_failed", message }, 500);
    }
  });

  return app;
}
