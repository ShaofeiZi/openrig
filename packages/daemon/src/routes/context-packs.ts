// Rig Context / 可组合上下文注入 v0（PL-014）——context_packs 的后台服务 HTTP
// 路由。
//
// 端点（Slice-03 Atom 5——ref 为主；冒号 id `/library/:id` 已移除）：
//   GET    /api/context-packs/library                  — 列出全部 pack
//   POST   /api/context-packs/library/sync            — 重新遍历发现根
//   POST   /api/context-packs/library/compose         — 把文件组合成持久 ref
//   GET    /api/context-packs/library/by-ref?ref=      — pack manifest + 文件
//   DELETE /api/context-packs/library/by-ref?ref=      — 删除 pack
//   GET    /api/context-packs/library/by-ref/preview?ref= — 组装后的 bundle（dry-run 形状）
//
// pack 由其路径样 ref 寻址（例如 `packs/compaction-restore`）；
// 条目的不透明 `id` 是 `context-pack:<ref>`（仅作 UI 路由 key）。

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ContextPackLibraryService } from "../domain/context-packs/context-pack-library-service.js";
import { assembleBundle, assemblePlainFiles } from "../domain/context-packs/bundle-assembler.js";
import { ContextPackError, type ContextPackAtom, type ContextPackEntry } from "../domain/context-packs/context-pack-types.js";
import { parseManifest } from "../domain/context-packs/manifest-parser.js";
import { composeNamedProfile, composeProfile, ProfileComposeError, type ComposeInput, type ComposeRuntime, type ComposeSituation } from "../domain/context-packs/profile-composer.js";
import { makeProfileReadFile, sourceKindForAddress, SourceResolutionError, type ProfileSourceRoots, type SourceReadRecord } from "../domain/context-packs/profile-source-resolver.js";
import { AddressResolutionError, parseAddress, resolveAddress } from "../domain/markdown-address.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";

interface ComposeBody {
  outRef?: string;
  sources?: unknown[];
}

type RefErrorStatus = 400 | 404 | 500;
function jsonError(
  status: RefErrorStatus,
  error: string,
  message: string,
  details?: Record<string, unknown>,
): { status: RefErrorStatus; body: Record<string, unknown> } {
  return { status, body: { error, message, ...(details ?? {}) } };
}

function isRelativeMarkdownAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let path: string;
  try {
    path = parseAddress(value).ref;
  } catch (err) {
    if (err instanceof AddressResolutionError) return false;
    throw err;
  }
  return path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    [".md", ".markdown"].includes(extname(path).toLowerCase());
}

export function contextPacksRoutes(): Hono {
  const router = new Hono();

  // GET /library
  router.get("/library", (c) => {    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    return c.json(lib.list());
  });

  // POST /library/sync
  router.post("/library/sync", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const result = lib.scan();
    return c.json({ ...result, entries: lib.list() });
  });

  // POST /library/compose——Atom 3 的无投递 file -> durable-ref 路径。
  router.post("/library/compose", async (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const body = await c.req.json<ComposeBody>().catch(() => ({} as ComposeBody));
    if (
      typeof body.outRef !== "string" ||
      !Array.isArray(body.sources) ||
      body.sources.some((source) =>
        typeof source !== "object" ||
        source === null ||
        Array.isArray(source) ||
        typeof (source as Record<string, unknown>).path !== "string" ||
        typeof (source as Record<string, unknown>).label !== "string"
      )
    ) {
      return c.json({
        error: "invalid_compose_request",
        message: "body 必须包含 { outRef, sources: [{ path, label }, ...] }",
      }, 400);
    }
    try {
      const result = lib.composeFromFiles({
        outRef: body.outRef,
        sources: body.sources as Array<{ path: string; label: string }>,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "pack_exists"
          ? 409
          : err.code === "store_unavailable"
            ? 503
            : err.code === "pack_write_failed"
              ? 500
              : 400;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "compose_failed", message: (err as Error).message }, 500);
    }
  });

  // Slice-03 Atom 4——以 ref 为主的读/删表面。路径样 ref 携带 '/'，
  // 因此走 `?ref=` 查询，绝不作 `:id` 路径段。在 `/library/:id` 之前注册，
  // 使静态 `by-ref` 段绝不被捕获为冒号 id。两个动词都流经 store 密封的
  // getByRef/removeByRef 边界（任何副作用前先 assertSafePackRef）。

  // GET /library/by-ref?ref=<路径样 ref>
  router.get("/library/by-ref", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const ref = c.req.query("ref");
    if (!ref) return c.json({ error: "ref_required", message: "查询必须包含 ?ref=<路径样 ref>" }, 400);
    try {
      const entry = lib.getByRef(ref);
      if (!entry) return c.json({ error: "pack_not_found", message: `镜像库中未找到 context pack '${ref}'` }, 404);
      return c.json(entry);
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "unsafe_ref" ? 400 : 500;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "by_ref_failed", message: (err as Error).message }, 500);
    }
  });

  // DELETE /library/by-ref?ref=<路径样 ref>
  router.delete("/library/by-ref", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const ref = c.req.query("ref");
    if (!ref) return c.json({ error: "ref_required", message: "查询必须包含 ?ref=<路径样 ref>" }, 400);
    try {
      const result = lib.removeByRef(ref);
      return c.json({ ...result, count: lib.list().length });
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "unsafe_ref"
          ? 400
          : err.code === "pack_not_found"
            ? 404
            : err.code === "pack_not_removable"
              ? 403
              : 500;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "rm_failed", message: (err as Error).message }, 500);
    }
  });

  // Slice-03 Atom 5——preview 从已移除的冒号 id `/library/:id` 路由迁移到
  // 以 ref 为主的 `?ref=` 表面（getByRef 后端）。已解析条目的不透明 `id`
  // （context-pack:<ref>）回显给 UI，但解析只按 ref。
  const resolveByRef = (
    lib: ContextPackLibraryService,
    ref: string | undefined,
  ): { entry: ContextPackEntry } | { error: ReturnType<typeof jsonError> } => {
    if (!ref) return { error: jsonError(400, "ref_required", "查询必须包含 ?ref=<路径样 ref>") };
    let entry: ContextPackEntry | null;
    try {
      entry = lib.getByRef(ref);
    } catch (err) {
      if (err instanceof ContextPackError) {
        return { error: jsonError(err.code === "unsafe_ref" ? 400 : 500, err.code, err.message, err.details) };
      }
      return { error: jsonError(500, "by_ref_failed", (err as Error).message) };
    }
    if (!entry) return { error: jsonError(404, "pack_not_found", `镜像库中未找到 context pack '${ref}'`) };
    return { entry };
  };

  // GET /library/by-ref/preview?ref=<路径样 ref>——组装后的 bundle（只读）
  router.get("/library/by-ref/preview", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;
    try {
      const bundle = assembleBundle({ packEntry: entry });
      return c.json({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        bundleText: bundle.text,
        bundleBytes: bundle.bytes,
        estimatedTokens: bundle.estimatedTokens,
        files: bundle.files,
        missingFiles: bundle.missingFiles,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // GET /library/by-ref/pieces?ref=<路径样 ref>——按成员有序内容，供 `zrig walk`；
  // 缺失成员在投递前报告。
  router.get("/library/by-ref/pieces", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;
    const pieces: Array<{ path: string; role: string; content: string }> = [];
    const missingFiles: Array<{ path: string; role: string }> = [];
    for (const file of entry.files) {
      if (file.absolutePath === null) {
        missingFiles.push({ path: file.path, role: file.role });
        continue;
      }
      try {
        const absolutePath = lib.resolveFileWithinPack(entry, file.path);
        pieces.push({ path: file.path, role: file.role, content: readFileSync(absolutePath, "utf-8") });
      } catch {
        missingFiles.push({ path: file.path, role: file.role });
      }
    }
    // Slice-03 Atom 6b：`text` = 整个 plain 内容（在场成员经密封的 compose 分隔符
    // 由 assemblePlainFiles 连接，只读）——--context/--body-context 投递 flag 注入/快照的
    // 单载荷形式，与逐段走步的 `pieces` 相对。`bytes` 让调用方做大小预警。
    const assembled = assemblePlainFiles({ files: pieces.map((p) => ({ path: p.path, content: p.content })) });
    return c.json({ ref: entry.relativePath, id: entry.id, pieces, missingFiles, text: assembled.text, bytes: assembled.bytes });
  });

  // OPR.0.5.3.5 Atom 4c——GET /library/resolve-address?address=<name#H2/H3>：
  // ref 语法地址形式的唯一 resolver 归属（mini-req 6 / Q4）。
  // 后台服务拥有整个解析——对库索引做最长前缀 pack 匹配，pack 内文件
  // （由库服务做包含校验），文件内 span（Atom-1 机制：Q1 完整 span、
  // fence 保护、带候选 fail-loud、歧义拒绝）。可寻址单元按锁定语法是 FILE；
  // 组装后的 bundle 绝非地址目标（其 '## File:' 框本身就是 H2）。
  router.get("/library/resolve-address", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const address = c.req.query("address");
    if (!address) return c.json({ error: "missing_address", message: "address 为必填：<pack-ref>/<file>[#H2-slug[/H3-slug]]" }, 400);

    let parsed;
    try {
      parsed = parseAddress(address);
    } catch (err) {
      return c.json({ error: "invalid_address", message: (err as Error).message }, 400);
    }

    // 最长前缀 pack 匹配：pack ref 与文件路径共享 '/'，因此由库索引决定切分——
    // 绝不猜。借用不变量，在此处具名，因为本循环的正确性依赖它（r1 4c rec）：
    // scanner 不递归进 pack 目录，因此没有 pack ref 能是另一个的段边界前缀，
    // 本循环至多匹配一个 pack。若未来加子 pack 索引，此切分会变歧义——
    // context-pack-address-route.test.ts 中的 no-nested-packs pin 会在那里变红，
    // 使该变更无法静默落地。
    const entries = lib.list();
    const segments = parsed.ref.split("/");
    let entry: ContextPackEntry | undefined;
    let filePath = "";
    for (let cut = segments.length - 1; cut >= 1; cut--) {
      const candidateRef = segments.slice(0, cut).join("/");
      const found = entries.find((e) => e.relativePath === candidateRef);
      if (found) {
        entry = found;
        filePath = segments.slice(cut).join("/");
        break;
      }
    }
    if (!entry) {
      return c.json({ error: "pack_not_found", message: `没有库 pack 匹配 '${parsed.ref}' 的任何前缀——运行 'zrig context list' 查看可用 ref` }, 404);
    }
    if (filePath.length === 0) {
      return c.json({ error: "missing_file_path", message: `'${parsed.ref}' 命名了 pack '${entry.relativePath}' 但其中无文件——可寻址单元是文件：<pack-ref>/<file>[#...]` }, 400);
    }
    const declared = entry.files.find((f) => f.path === filePath);
    if (!declared) {
      return c.json({ error: "file_not_in_pack", message: `pack '${entry.relativePath}' 未声明文件 '${filePath}'——已声明：${entry.files.map((f) => f.path).join(", ")}` }, 404);
    }
    let fileText: string;
    try {
      fileText = readFileSync(lib.resolveFileWithinPack(entry, filePath), "utf-8");
    } catch (err) {
      return c.json({ error: "file_unreadable", message: `pack '${entry.relativePath}' 文件 '${filePath}'：${(err as Error).message}` }, 422);
    }
    if (parsed.headerPath.length === 0) {
      return c.json({ address, packRef: entry.relativePath, filePath, text: fileText });
    }
    try {
      const section = resolveAddress(fileText, parsed.headerPath);
      return c.json({
        address,
        packRef: entry.relativePath,
        filePath,
        headerPath: section.headerPath,
        headerLine: section.headerLine,
        text: section.text,
        ownText: section.ownText,
      });
    } catch (err) {
      if (err instanceof AddressResolutionError) {
        return c.json({ error: "address_unresolved", message: `${parsed.ref}: ${err.message}` }, 422);
      }
      throw err;
    }
  });

  // OPR.0.5.3.5 Atom 4b——GET /library/by-ref/profile?ref=&situation=&runtime=
  // [&budget=][&rig=&seat=]：经 pack 的 atom 图 + seat 树做 situation 组合投递。
  // manifest 流经唯一 parser chokepoint；seat 根从 topology.root CONFIG 解析
  // （slice-06 D1 布局：rigs/<rig>/seats/<seat>），绝不字面写死；每次 compose
  // 失败都是具名 4xx——profile 绝不悄悄比其图所说更薄。
  router.get("/library/by-ref/profile", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;

    const situation = c.req.query("situation");
    if (situation !== "fresh" && situation !== "handover" && situation !== "post-compaction") {
      return c.json({ error: "invalid_situation", message: `situation 必须是 fresh | handover | post-compaction（收到：${situation ?? "(缺失)"}）` }, 400);
    }
    const runtime = c.req.query("runtime");
    if (runtime !== "claude" && runtime !== "codex") {
      return c.json({ error: "invalid_runtime", message: `runtime 必须是 claude | codex（收到：${runtime ?? "(缺失)"}）` }, 400);
    }
    const budgetRaw = c.req.query("budget");
    let budgetTokens: number | undefined;
    if (budgetRaw !== undefined) {
      budgetTokens = Number(budgetRaw);
      if (!Number.isInteger(budgetTokens) || budgetTokens < 0) {
        return c.json({ error: "invalid_budget", message: `budget 必须是非负整数（收到：${budgetRaw}）` }, 400);
      }
    }

    let manifest;
    try {
      manifest = parseManifest(readFileSync(join(entry.sourcePath, "manifest.yaml"), "utf-8"), entry.sourcePath);
    } catch (err) {
      return c.json({ error: "manifest_unreadable", message: (err as Error).message }, 422);
    }
    if (!manifest.atoms || manifest.atoms.length === 0) {
      return c.json({ error: "no_atoms", message: `pack '${entry.relativePath}' 未声明 atoms——profile 从 atom 元数据组合（mini-req 1）；请在其 manifest 加 atoms: 段` }, 422);
    }
    const requestedProfileId = c.req.query("profile");
    const selectedProfile = requestedProfileId === undefined
      ? undefined
      : manifest.profiles?.find((profile) => profile.id === requestedProfileId);
    if (requestedProfileId !== undefined && !selectedProfile) {
      return c.json({
        error: "profile_not_found",
        message: `pack '${entry.relativePath}' 未声明 profile '${requestedProfileId}'——可用：${manifest.profiles?.map((profile) => profile.id).join(", ") || "(无)"}`,
      }, 400);
    }
    if (selectedProfile && !selectedProfile.situations.includes(situation)) {
      return c.json({ error: "profile_situation_mismatch", message: `profile '${selectedProfile.id}' 不适用于 situation '${situation}'` }, 400);
    }
    if (selectedProfile && !selectedProfile.runtimes.includes(runtime)) {
      return c.json({ error: "profile_runtime_mismatch", message: `profile '${selectedProfile.id}' 不适用于 runtime '${runtime}'` }, 400);
    }

    // 当调用方命名 seat 时，seat 根来自 CONFIG。rig/seat 是路径段——有界 token
    // 检查防止查询串走遍 topology 树（与 install-ref 段规则同类）。信任边界
    // （r1 rider 2）：传 rig+seat 即调用方对该 seat 目录子树的显式读授权——
    // pack 在授权根内选路径（这正是根授权的含义），每次树读都在下面 provenance
    // 表面可见，因此不可信（URL 安装）pack 的 seat: atom 既读不到调用方未授权的根，
    // 也投递不了来源隐藏的字节。
    const roots: ProfileSourceRoots = {};
    let atoms: ContextPackAtom[] = manifest.atoms;
    const contextAtoms: Partial<Record<"project" | "mission" | "seat" | "slice", ContextPackAtom[]>> = {};
    const workMeta = new Map<string, { altitude: "project" | "mission" | "seat" | "slice"; source: "default" | "manifest" }>();
    const warnings: string[] = [];
    const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    const rig = c.req.query("rig");
    const seat = c.req.query("seat");
    if (rig !== undefined || seat !== undefined) {
      if (!rig || !seat || !SEGMENT.test(rig) || !SEGMENT.test(seat)) {
        return c.json({ error: "invalid_seat_params", message: "rig 和 seat 必须都是单个有界段（[A-Za-z0-9][A-Za-z0-9._-]{0,63}）" }, 400);
      }
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      roots.seat = join(topologyRoot, "rigs", rig, "seats", seat);
      contextAtoms.seat = [{
        id: "profile-seat-learned",
        address: "seat:LEARNED.md",
        taxonomy: "lore",
        situations: ["fresh"],
        purpose: "width",
        runtime: "any",
        order: 1,
        priority: "core",
      }];
      workMeta.set("profile-seat-learned", { altitude: "seat", source: "default" });
    }
    // Mission 根在已裁决的既有 key 上（desk row 2675535d：复用
    // workspace.slices_root，绝不新造兄弟）：mission 根 =
    // <slices_root>/<mission>，同样的有界段门、同样的授权语义——
    // 命名 mission 即授予本次 compose 对该 mission 目录子树的读权限。
    const mission = c.req.query("mission");
    const slice = c.req.query("slice");
    const requiredProfileContext = new Set(selectedProfile?.phases.flatMap((phase) => phase.context ?? []) ?? []);
    if (requiredProfileContext.has("seat") && (!rig || !seat)) {
      return c.json({ error: "profile_context_missing", message: `profile '${selectedProfile!.id}' 需要 seat 上下文；请同时传 rig 和 seat` }, 400);
    }
    if (["project", "mission", "slice"].some((source) => requiredProfileContext.has(source as "project" | "mission" | "slice")) && (!mission || !slice)) {
      return c.json({ error: "profile_context_missing", message: `profile '${selectedProfile!.id}' 需要情境化 project/mission/task 上下文；请同时传 mission 和 slice` }, 400);
    }
    if (slice !== undefined && mission === undefined) {
      return c.json({ error: "mission_required", message: "slice 需要精确的 mission 选择；legacy 工作层级是 project -> mission -> slice" }, 400);
    }
    if (slice !== undefined && !SEGMENT.test(slice)) {
      return c.json({ error: "invalid_slice_param", message: "slice 必须是单个有界段（[A-Za-z0-9][A-Za-z0-9._-]{0,63}）" }, 400);
    }
    if (mission !== undefined) {
      if (!SEGMENT.test(mission)) {
        return c.json({ error: "invalid_mission_param", message: "mission 必须是单个有界段（[A-Za-z0-9][A-Za-z0-9._-]{0,63}）" }, 400);
      }
      const settings = new SettingsStore();
      const slicesRoot = String(settings.resolveOne("workspace.slices_root").value);
      roots.mission = join(slicesRoot, mission);

      const hasAuthoredWorkAtom = manifest.atoms.some((atom) => {
        const kind = sourceKindForAddress(atom.address);
        return kind === "project" || kind === "mission";
      });
      if (slice === undefined && !hasAuthoredWorkAtom && !selectedProfile) {
        return c.json({
          error: "slice_required",
          message: `pack '${entry.relativePath}' 未声明 project: 或 mission: atom，因此单独 --mission 会是 no-op；请传精确 --slice 以请求 legacy 默认工作走步`,
        }, 400);
      }

      // Story 1 的有界兼容接缝。同时提供 mission 和 slice 即请求既有单 project
      // 层级的常规 Markdown 走步。刻意限于无歧义的 legacy 布局；
      // 多 project/目录解析属于后续 story。
      if (slice !== undefined) {
        if (situation !== "fresh") {
          return c.json({ error: "legacy_default_fresh_only", message: "有界 legacy 默认工作走步仅对 fresh profile 可用" }, 400);
        }
        const workspaceRoot = String(settings.resolveOne("workspace.root").value);
        if (resolve(slicesRoot) !== resolve(workspaceRoot, "missions")) {
          return c.json({
            error: "legacy_workspace_required",
            message: `legacy 默认组合要求 workspace.slices_root 为 <workspace.root>/missions；实际 ${slicesRoot}`,
          }, 422);
        }
        roots.project = workspaceRoot;
        const maxOrder = atoms.reduce((max, atom) => Math.max(max, atom.order), Number.MIN_SAFE_INTEGER);
        const idPrefix = selectedProfile ? "profile" : "legacy-default";
        let projectIntent = "SPEC.md";
        let projectIntentSource: "default" | "manifest" = "default";
        let projectContext: string[] = [];
        const projectManifestPath = join(workspaceRoot, "project.yaml");
        if (existsSync(projectManifestPath)) {
          const projectManifest = parseYaml(readFileSync(projectManifestPath, "utf-8")) as {
            install?: { intent?: unknown; context?: unknown };
          } | null;
          const manifestIntent = projectManifest?.install?.intent;
          if (isRelativeMarkdownAddress(manifestIntent)) {
            projectIntent = manifestIntent;
            projectIntentSource = "manifest";
          } else if (manifestIntent !== undefined) {
            warnings.push("project.yaml：可选 install.intent 必须是相对 Markdown 地址；已忽略该非法值并保留基线工作 install。");
          }
          const manifestContext = projectManifest?.install?.context;
          if (Array.isArray(manifestContext) && manifestContext.every(isRelativeMarkdownAddress)) {
            projectContext = manifestContext;
          } else if (manifestContext !== undefined) {
            warnings.push("project.yaml：可选 install.context 必须是相对 Markdown 地址列表；已忽略该非法值并保留基线工作 install。");
          }
        }
        const projectAtoms: ContextPackAtom[] = [
          {
            id: `${idPrefix}-project-spec`,
            address: `project:${projectIntent}`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: maxOrder + 1,
            priority: "core",
          },
          ...projectContext.map((address, index): ContextPackAtom => ({
            id: `${idPrefix}-project-context-${index + 1}`,
            address: `project:${address}`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: maxOrder + index + 2,
            requires: [index === 0 ? `${idPrefix}-project-spec` : `${idPrefix}-project-context-${index}`],
            priority: "core",
          })),
        ];
        const finalProjectAtom = projectAtoms.at(-1)!;
        const defaultAtoms: ContextPackAtom[] = [
          ...projectAtoms,
          {
            id: `${idPrefix}-mission-spec`,
            address: "mission:SPEC.md",
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: finalProjectAtom.order + 1,
            requires: [finalProjectAtom.id],
            priority: "core",
          },
          {
            id: `${idPrefix}-slice-spec`,
            address: `mission:slices/${slice}/SPEC.md`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: finalProjectAtom.order + 2,
            requires: [`${idPrefix}-mission-spec`],
            priority: "core",
          },
        ];
        const collision = defaultAtoms.find((atom) => atoms.some((existing) => existing.id === atom.id));
        if (collision) {
          return c.json({ error: "default_atom_conflict", message: `pack '${entry.relativePath}' 已声明保留 atom id '${collision.id}'` }, 422);
        }
        if (selectedProfile) {
          contextAtoms.project = projectAtoms;
          const missionSpec = defaultAtoms[projectAtoms.length]!;
          const sliceSpec = defaultAtoms[projectAtoms.length + 1]!;
          contextAtoms.mission = [
            missionSpec,
            {
              id: "profile-mission-arrangement",
              address: "mission:mission.yaml",
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: missionSpec.order + 1,
              priority: "core",
            },
            {
              id: "profile-mission-progress",
              address: "mission:PROGRESS.md",
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: missionSpec.order + 2,
              priority: "core",
            },
          ];
          contextAtoms.slice = [
            sliceSpec,
            {
              id: "profile-slice-progress",
              address: `mission:slices/${slice}/PROGRESS.md`,
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: sliceSpec.order + 1,
              priority: "core",
            },
          ];
        } else {
          atoms = [...atoms, ...defaultAtoms];
        }
        workMeta.set(`${idPrefix}-project-spec`, { altitude: "project", source: projectIntentSource });
        projectContext.forEach((_, index) => {
          workMeta.set(`${idPrefix}-project-context-${index + 1}`, { altitude: "project", source: "manifest" });
        });
        workMeta.set(`${idPrefix}-mission-spec`, { altitude: "mission", source: "default" });
        workMeta.set(`${idPrefix}-slice-spec`, { altitude: "slice", source: "default" });
        if (selectedProfile) {
          workMeta.set("profile-mission-arrangement", { altitude: "mission", source: "default" });
          workMeta.set("profile-mission-progress", { altitude: "mission", source: "default" });
          workMeta.set("profile-slice-progress", { altitude: "slice", source: "default" });
        }
      }
    }

    try {
      // 每次读的字节 provenance（r1 rider 1）：source 标签必须可校验。
      // 按 ref 建 key——同 ref 的每个 piece 共享该次读。
      const readsByRef = new Map<string, SourceReadRecord>();
      const composeInput: ComposeInput = {
        atoms,
        situation: situation as ComposeSituation,
        runtime: runtime as ComposeRuntime,
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        readFile: makeProfileReadFile({
          packDir: entry.sourcePath,
          roots,
          onRead: (record) => readsByRef.set(record.ref, record),
        }),
        sourceKindFor: (a) => sourceKindForAddress(a.address),
      };
      const profile = selectedProfile
        ? composeNamedProfile({ ...composeInput, profile: selectedProfile, contextAtoms })
        : composeProfile(composeInput);
      const pieces = profile.pieces.map((p) => {
        const record = readsByRef.get(parseAddress(p.address).ref);
        // 每 piece sha256：Test-A 门把 profile 选中的 piece 与走步投递的 piece
        // 按哈希精确比较，而非按数量。
        const pieceWorkMeta = workMeta.get(p.atomId);
        const hashed = { ...p, ...(pieceWorkMeta ?? {}), sha256: createHash("sha256").update(p.text, "utf8").digest("hex") };
        return record
          ? { ...hashed, provenance: { nominalPath: record.nominalPath, realPath: record.realPath, escapesRoot: record.escapesRoot } }
          : hashed;
      });
      // 始终是数组（消费方只守卫一种形状）：空 = 每个 piece 的字节都来自其授权根内。
      // 只报告、绝不阻断——realpath 包含检查会破坏合法的符号链接布局。
      const provenanceWarnings = pieces
        .filter((p) => "provenance" in p && (p as { provenance: { escapesRoot: boolean } }).provenance.escapesRoot)
        .map((p) => {
          const prov = (p as { provenance: { realPath: string } }).provenance;
          return `piece '${p.atomId}'（${p.address}）：字节来自其 ${p.sourceKind} 根之外——真实路径 ${prov.realPath}`;
        });
      const phases = profile.phases?.map((phase) => ({
        ...phase,
        pieces: pieces.filter((piece) => piece.phaseId === phase.id),
      }));
      return c.json({
        ref: entry.relativePath,
        ...profile,
        pieces,
        ...(phases ? { phases } : {}),
        warnings,
        provenanceWarnings,
      });
    } catch (err) {
      if (err instanceof ProfileComposeError || err instanceof SourceResolutionError) {
        return c.json({ error: "profile_compose_failed", message: err.message }, 422);
      }
      throw err;
    }
  });

  return router;
}
