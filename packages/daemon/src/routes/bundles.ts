import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Hono } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import { LegacyBundleAssembler as BundleAssembler, type AssemblerFsOps } from "../domain/bundle-assembler.js";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../domain/pod-bundle-assembler.js";
import { computeIntegrity, writeIntegrity, verifyIntegrity, type IntegrityFsOps } from "../domain/bundle-integrity.js";
import { pack, unpack, verifyArchiveDigest } from "../domain/bundle-archive.js";
import { resolvePackage } from "../domain/package-resolve-helper.js";
import {
  compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds, bundleExportWarning,
  topologyFromLegacyRigSpec, topologyFromLiveNodeIds, type ConformanceResult,
} from "../domain/spec-live-conformance.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, serializePodBundleManifest, parsePodBundleManifest, validatePodBundleManifest, validateLegacyBundleManifest, normalizeProvenanceBlock, normalizeCompatibilityBlock, isRelativeSafePath } from "../domain/bundle-types.js";
import type { PodBundleManifest, BundleProvenance, BundleCompatibility, BundlePluginReference } from "../domain/bundle-types.js";
import { detectBundleConflicts, type BundleConflict } from "../domain/bundle-conflict-detector.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { BundleAuditReader, BundleAuditWriter, type BundleAuditFsOps, type BundleAuditRecord } from "../domain/bundle-audit.js";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { routeSkills, type SkillsRouterFsOps, type RouteSkillsResult } from "../domain/bundle-skills-router.js";
import { routePlugins, type PluginsRouterFsOps, type RoutePluginsResult, type PluginRoutingInput } from "../domain/bundle-plugins-router.js";
import { routeWorkflowSpecs, type WorkflowSpecsRouterFsOps, type RouteWorkflowSpecsResult } from "../domain/bundle-workflow-specs-router.js";
import { routeContextPacks, type ContextPacksRouterFsOps, type RouteContextPacksResult } from "../domain/bundle-context-packs-router.js";
import { routeAgentImages, type AgentImagesRouterFsOps, type RouteAgentImagesResult } from "../domain/bundle-agent-images-router.js";
import { SettingsStore as ContextPackSettingsStore } from "../domain/user-settings/settings-store.js";
import { getDaemonVersion } from "../domain/daemon-version.js";
import { assertShippableSubstance } from "../domain/agent-resolver.js";

/**
 * 比较两个点分数字版本串（semver 风格）。a < b 返回 -1，相等返回 0，a > b 返回 1。
 * 非数字段强制为 0。对 0.x.y / 1.x.y 范围足够；不解释 pre-release / build metadata。
 * Item-2 安装时版本检查（Checkpoint 3.3）。
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
  const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/** 三段式错误响应中呈现的单条兼容性检查失败。 */
interface CompatibilityFailure {
  reason: "daemon_version_mismatch" | "cli_version_mismatch";
  required: string;
  actual: string;
  description: string;
}

/**
 * 运行安装时兼容性检查（Item 2 Checkpoint 3.3）。返回失败数组（每类一条），全部通过
 * 则返回 null。compat 中缺字段是 no-op（缺 min_cli_version 时只查 daemon；两者都缺则
 * 全通过）。cliVersion undefined 时静默跳过 CLI 检查（pre-Item-2 CLI 不发它；诚实的
 * 向后兼容）。
 */
function checkBundleCompatibility(
  compat: BundleCompatibility | undefined,
  daemonVersion: string,
  cliVersion: string | undefined,
): CompatibilityFailure[] | null {
  if (!compat) return null;
  const failures: CompatibilityFailure[] = [];
  if (compat.minDaemonVersion && compareVersions(daemonVersion, compat.minDaemonVersion) < 0) {
    failures.push({
      reason: "daemon_version_mismatch",
      required: compat.minDaemonVersion,
      actual: daemonVersion,
      description: `bundle 要求 daemon >= ${compat.minDaemonVersion}，当前 daemon 是 ${daemonVersion}`,
    });
  }
  if (compat.minCliVersion && cliVersion && compareVersions(cliVersion, compat.minCliVersion) < 0) {
    failures.push({
      reason: "cli_version_mismatch",
      required: compat.minCliVersion,
      actual: cliVersion,
      description: `bundle 要求 CLI >= ${compat.minCliVersion}，当前 CLI 是 ${cliVersion}`,
    });
  }
  return failures.length > 0 ? failures : null;
}

/**
 * 经规范安全解压路径（domain/bundle-archive 的 unpack）从 .rigbundle 归档抽取
 * bundle.yaml manifest。unpack 先 verifyArchiveDigest，再 tar.list 预扫描拒绝
 * symlink / hardlink / 绝对路径 / dot-dot 穿越，然后解压，再验证内容完整性。这里用
 * unpack 把安装时兼容检查保留在既有信任边界内——对不可信归档裸 tar.extract 会绕过
 * 安全预扫描（B1 回归已修）。归档 / 安全 / 解析失败时 throw；调用方把这些转成三段式
 * 400 响应。
 */
async function extractManifestForCompatCheck(bundlePath: string): Promise<Record<string, unknown>> {
  const meta = await extractInstallTimeMetadata(bundlePath);
  return meta.bundleManifest;
}

/**
 * 一次安全 pass 同时抽 bundle.yaml manifest 和 bundle rig.yaml 中的 rig 名
 * （Item 3 / slice-05 Checkpoint 4.2）。/install handler 用 bundleManifest 做兼容检查
 * （Item 2），用 rigName 做冲突检查（Item 3）。复用 unpack——单一信任边界。
 */
async function extractInstallTimeMetadata(bundlePath: string): Promise<{
  bundleManifest: Record<string, unknown>;
  rigName: string | undefined;
}> {
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-meta-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) throw new Error("bundle 缺 bundle.yaml");
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const bundleManifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;

    // B1 安全修复（slice-05 Checkpoint 4.2 / qitem-20260518204906）：在信任任何字段前
    // 校验解析后的 manifest。validator 拒绝不安全 rig_spec 值（isRelativeSafePath：
    // 无绝对、无 ../、无反斜杠、无空段）。schema 版本感知：v2 用 pod-aware validator；
    // 其他回退到 v1 legacy validator。这与 Item 2 的 unpack/B1 修复是同一信任边界复用。
    const schemaVersion = bundleManifest["schema_version"];
    if (schemaVersion === 2) {
      const v2Validation = validatePodBundleManifest(bundleManifest);
      if (!v2Validation.valid) {
        throw new Error(`非法 v2 bundle manifest：${v2Validation.errors.join("; ")}`);
      }
    } else {
      const v1Validation = validateLegacyBundleManifest(bundleManifest, { requireIntegrity: false });
      if (!v1Validation.valid) {
        throw new Error(`非法 v1 bundle manifest：${v1Validation.errors.join("; ")}`);
      }
    }

    // rig 名住在 bundle 的 rig.yaml 中（路径由 bundle.yaml 的 rig_spec 字段引用；
    // legacy bundle 默认 rig.yaml）。读 + 解析；缺或畸形的 rig 名使 rigName undefined，
    // detector 对此 fail-open（无 rig 名可比）。
    //
    // B1 安全修复（与上面 validator 并列的纵深防御）：在 tmpDir 内解析 rig_spec 并要求
    // 结果在读之前留在 tmpDir 内，镜像 bundle-source-resolver.ts:60-63。validator 本应
    // 已拒绝不安全 rig_spec；这是第二道线。
    let rigName: string | undefined;
    const rigSpecRel = typeof bundleManifest["rig_spec"] === "string" ? bundleManifest["rig_spec"] : "rig.yaml";
    const rigSpecPath = nodePath.resolve(tmpDir, rigSpecRel);
    const tmpDirResolved = nodePath.resolve(tmpDir);
    if (rigSpecPath !== tmpDirResolved && !rigSpecPath.startsWith(tmpDirResolved + nodePath.sep)) {
      throw new Error(`rig spec 路径 '${rigSpecRel}' 逃出 bundle 工作区`);
    }
    if (fs.existsSync(rigSpecPath)) {
      try {
        const rigYaml = fs.readFileSync(rigSpecPath, "utf-8");
        const rigParsed = parsePodBundleManifest(rigYaml) as Record<string, unknown>;
        if (typeof rigParsed["name"] === "string" && rigParsed["name"].length > 0) {
          rigName = rigParsed["name"];
        }
      } catch {
        // rig.yaml 畸形——留 rigName undefined；冲突检查跳过
      }
    }
    return { bundleManifest, rigName };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 把请求 body 中的原始 compatibility 清洗成 BundleCompatibility 对象。只接受已知
 * 类型化字段；未知字段静默丢弃。输入缺或无可用字时返回 undefined。
 */
function compatibilityFromRequestBody(raw: unknown): BundleCompatibility | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const result: BundleCompatibility = {};
  if (typeof c["minDaemonVersion"] === "string") result.minDaemonVersion = c["minDaemonVersion"];
  if (typeof c["minCliVersion"] === "string") result.minCliVersion = c["minCliVersion"];
  if (typeof c["schemaVersion"] === "number") result.schemaVersion = c["schemaVersion"];
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 把请求 body 中的原始 provenance 规范化成 BundleProvenance 对象。只接受字符串字段；
 * 未知/非字符串字段静默丢弃。输入缺或无可用字时返回 undefined。daemon 侧
 * daemonVersion 注入是调用方责任。
 */
function provenanceFromRequestBody(raw: unknown): BundleProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const result: BundleProvenance = {};
  if (typeof p["sourceHost"] === "string") result.sourceHost = p["sourceHost"];
  if (typeof p["authorSession"] === "string") result.authorSession = p["authorSession"];
  if (typeof p["sourceRigId"] === "string") result.sourceRigId = p["sourceRigId"];
  if (typeof p["sourceRigName"] === "string") result.sourceRigName = p["sourceRigName"];
  if (typeof p["cliVersion"] === "string") result.cliVersion = p["cliVersion"];
  if (typeof p["notes"] === "string") result.notes = p["notes"];
  return Object.keys(result).length > 0 ? result : undefined;
}
import type { FsOps } from "../domain/package-resolver.js";

export const bundleRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    eventBus: c.get("eventBus" as never) as EventBus,
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    rigRepo: c.get("rigRepo" as never) as RigRepository | undefined,
  };
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) => {
      const r: string[] = [];
      function walk(d: string, prefix: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
  };
}

/**
 * Build B——把即将导出的 spec 与同名 RUNNING 工作组比较。
 *
 * assembler 把 spec 文本逐字拷进 bundle，从不读 live DB，所以运行时扩容的工作组
 * （无东西把 spec 写回）会静默地导出成更小、更旧的拓扑。这个函数把 delta 大声说出来。
 *
 * 真正无可报告时返回 null——调用方随后什么也不说：无 repo、spec 的工作组未运行
 * （编写新工作组不是 drift）、或一致。只报告：绝不 mutation、绝不 block、绝不 throw
 * 进导出路径。
 */
export function describeSpecLiveDrift(rawParsed: unknown, rigRepo: RigRepository | undefined): string | null {
  try {
    const result = assessSpecLiveDrift(rawParsed, rigRepo);
    return result ? bundleExportWarning(result) : null;
  } catch {
    // REPORTING 契约，刻意与下面的 enforcement 不同：banner 绝不能成为导出失败的理由。
    // Enforcement 承担不起这个，也不共享它。
    return null;
  }
}

/**
 * 与 `describeSpecLiveDrift` 相同的比较，但结构化返回而非句子。
 *
 * null 表示真正无可比较：无 repository、spec 无 `name:`、既非 pod-aware 也非 legacy 的形状、
 * 或无该名工作组记录。这些都是诚实的"无比较"。
 *
 * repository 或查询失败不在其中，会传播。上面的报告助手可以吞掉它，因为那里最坏只是
 * 缺 banner。Enforcement 不能：把 DB 读失败翻译成"无 drift"会让导出凭一次从未发生的
 * 比较继续，那正是本守卫存在要移除的 fail-open。调用方 fail closed。
 */
export function assessSpecLiveDrift(rawParsed: unknown, rigRepo: RigRepository | undefined): ConformanceResult | null {
  if (!rigRepo) return null;
  const spec = rawParsed as { name?: unknown; pods?: unknown; nodes?: unknown } | null;
  const rigName = typeof spec?.name === "string" ? spec.name : "";
  if (!rigName) return null;
  // Pod-aware 和 legacy spec 都到达此端点，都会 ship 同一错误 artifact。一个比较器、两个
  // reader——格式只决定 id 怎么读，绝不决定 "drift" 是什么意思。
  const isPodAware = Array.isArray(spec?.pods);
  const isLegacy = !isPodAware && Array.isArray(spec?.nodes);
  if (!isPodAware && !isLegacy) return null;
  const rig = rigRepo.listRigs().find((r) => r.name === rigName);
  if (!rig) return null;
  const rows = rigRepo.db
    .prepare("SELECT logical_id FROM nodes WHERE rig_id = ?")
    .all(rig.id) as Array<{ logical_id: string | null }>;
  const liveIds = rows.map((r) => r.logical_id);
  return isPodAware
    ? compareSpecToLive(topologyFromRigSpec(spec as never), topologyFromLiveLogicalIds(liveIds))
    : compareSpecToLive(topologyFromLegacyRigSpec(spec as never), topologyFromLiveNodeIds(liveIds));
}

/**
 * 这个 spec 描述的工作组与记录中的不同——无论哪个方向？
 *
 * 早先版本只拒绝 drop 方向，理由是声明比 live 更多的 spec 是一个把其余带起来的 bundle。
 * 那是错的，原因是 DB 行实际是什么：`nodes` 是工作组的持久拓扑，不是当前运行 session 列表。
 * 把 spec 从未声明的席位带起来的 restore，与丢弃它们一样确定地产生不同工作组。方向不是
 * 判据；不一致才是。`--allow-drift` 是操作员认真要做时诚实通过的方式。
 */
export function specDivergesFromLive(result: ConformanceResult | null): boolean {
  return result ? !result.conforms : false;
}

/** 操作员可据此行动的拒绝：哪里不一致，以及通过的路。 */
export function bundleExportRefusal(result: ConformanceResult): string {
  return [
    `拒绝打包：此 spec 描述的工作组与它命名的不符——${result.message}。`,
    `该 bundle 会实例化 ${result.spec.pods} pod/${result.spec.seats} 席位，不是`,
    `本工作组记录中的拓扑。`,
    `更新 spec 使其匹配，或带 --allow-drift 原样打包（分歧随后`,
    `盖进 bundle provenance，使 artifact 自带警示）。`,
  ].join(" ");
}

function assemblerFsOps(): AssemblerFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function integrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => realFsOps().listFiles!(dir),
  };
}

function podAssemblerFsOps(): PodAssemblerFsOps {
  return {
    ...assemblerFsOps(),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) => realFsOps().listFiles!(dir),
  };
}

/** 第 6 项 / slice-05 检查点 7.3d：由 node:fs 支撑的真实 PluginsRouterFsOps。 */
function pluginsRouterFsOps(): PluginsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

/** 第 6 项 / slice-05 检查点 7.3e 第 3 步：由 node:fs 支撑的真实 WorkflowSpecsRouterFsOps。 */
function workflowSpecsRouterFsOps(): WorkflowSpecsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

/** 第 6 项 / slice-05 检查点 7.3f 第 3 步：由 node:fs 支撑的真实 ContextPacksRouterFsOps。 */
function contextPacksRouterFsOps(): ContextPacksRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    listFiles: (dir) => {
      const files: string[] = [];
      const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = nodePath.join(current, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child, relativePath);
          else if (entry.isFile()) files.push(relativePath);
        }
      };
      walk(dir, "");
      return files;
    },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

/** 第 6 项 / slice-05 检查点 7.3g 第 3 步：由 node:fs 支撑的真实 AgentImagesRouterFsOps。 */
function agentImagesRouterFsOps(): AgentImagesRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

/**
 * Item 6 / slice-05 Checkpoint 7.3g step 3：安全解压 bundle（复用 unpack 信任边界）
 * 并把任何声明的 agent_images 路由到 operator agent-images 库。bundle 无
 * agent_images[] 时返回 null（no-op）。
 *
 * 目标解析：<openrigHome>/agent-images——见 startup.ts:523（live
 * AgentImageLibraryService 构造所对的用户文件根）。无 SettingsStore 复杂性；规范
 * 路径按 agent-image-types.ts:9-10 以 OPENRIG_HOME 为根。
 *
 * 按 e7a0b253 PRD 一致契约：agent_images 条目是 image 目录路径（不是 manifest 路径——
 * 与 context_packs 形状不同）。router 在拷整个 image 目录前强制 sourceAbs isDirectory
 * + dir 内 manifest.yaml 是文件。
 *
 * routeContextPacksAfterBootstrap 模式的镜像，适配 dir-path 契约。按 5f410eee B1 教训
 * 只用 bundlePath 签名。
 */
async function routeAgentImagesAfterBootstrap(bundlePath: string): Promise<RouteAgentImagesResult | null> {
  const targetAgentImagesDir = getDefaultOpenRigPath("agent-images");
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-agent-images-route-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) return null;
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const rawAgentImages = manifest["agent_images"];
    if (!Array.isArray(rawAgentImages) || rawAgentImages.length === 0) return null;
    const declaredAgentImages = rawAgentImages.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (declaredAgentImages.length === 0) return null;
    return routeAgentImages(
      {
        bundleRoot: tmpDir,
        declaredAgentImages,
        targetAgentImagesDir,
      },
      agentImagesRouterFsOps(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Item 6 / slice-05 Checkpoint 7.3f step 3：安全解压 bundle（复用 unpack 信任边界）
 * 并把任何声明的 context_packs 路由到 operator context-packs 库。bundle 无
 * context_packs[] 时返回 null（no-op）。
 *
 * 目标解析用 context.root，与 live ContextPackLibraryService 完全一致。配置的 root
 * 替换默认；bundle 路由绝不能静默创建第二个可写库。
 *
 * routeSkillsAfterBootstrap / routePluginsAfterBootstrap /
 * routeWorkflowSpecsAfterBootstrap 模式的镜像：只用 bundlePath
 * （按 5f410eee B1 教训与 installMeta 解耦；路由在 dual-override 路径也必须触发）。
 */
async function routeContextPacksAfterBootstrap(bundlePath: string): Promise<RouteContextPacksResult | null> {
  const targetContextPacksDir = new ContextPackSettingsStore().resolveOne("context.root").value as string;
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-context-packs-route-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) return null;
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const rawContextPacks = manifest["context_packs"];
    if (!Array.isArray(rawContextPacks) || rawContextPacks.length === 0) return null;
    const declaredContextPacks = rawContextPacks.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (declaredContextPacks.length === 0) return null;
    return routeContextPacks(
      {
        bundleRoot: tmpDir,
        declaredContextPacks,
        targetContextPacksDir,
      },
      contextPacksRouterFsOps(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Item 6 / slice-05 Checkpoint 7.3e step 3：安全解压 bundle（复用 unpack 信任边界）
 * 并把任何声明的 workflow_specs 路由到 operator workflow-specs 库。bundle 无
 * workflow_specs[]（no-op）、无 manifest 或 workspaceSpecsRoot 未解析时返回 null。
 *
 * 按 bundle-workflow-specs-router.ts 的 CALLER CONTRACT 解析目标：SettingsStore 是
 * 唯一权威。解析为 nodePath.join(workspaceSpecsRoot, "workflows")——spec-library-
 * workflow-scanner 实际读的路径（startup.ts:903-916）。若 SettingsStore 无法解析
 * workspaceSpecsRoot（settings 未初始化 / config 错误），返回 null 且安装生命周期
 * 不带 workflow_specs 路由继续——镜像 startup.ts:910-916 try/catch 姿态。
 *
 * routeSkillsAfterBootstrap / routePluginsAfterBootstrap 模式的镜像：只用 bundlePath
 * （按 5f410eee B1 教训与 installMeta 解耦；路由在 dual-override 路径也必须触发）。
 */
async function routeWorkflowSpecsAfterBootstrap(bundlePath: string): Promise<RouteWorkflowSpecsResult | null> {
  let workspaceSpecsRoot: string | undefined;
  try {
    const settingsStore = new ContextPackSettingsStore();
    workspaceSpecsRoot = settingsStore.resolveConfig().workspaceSpecsRoot;
  } catch {
    return null; // settings 不可解析；no-op 路由
  }
  if (!workspaceSpecsRoot) return null;
  const targetWorkflowSpecsDir = nodePath.join(workspaceSpecsRoot, "workflows");

  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-workflow-specs-route-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) return null;
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const rawWorkflowSpecs = manifest["workflow_specs"];
    if (!Array.isArray(rawWorkflowSpecs) || rawWorkflowSpecs.length === 0) return null;
    const declaredWorkflowSpecs = rawWorkflowSpecs.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (declaredWorkflowSpecs.length === 0) return null;
    return routeWorkflowSpecs(
      {
        bundleRoot: tmpDir,
        declaredWorkflowSpecs,
        targetWorkflowSpecsDir,
      },
      workflowSpecsRouterFsOps(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Item 6 / slice-05 Checkpoint 7.3d：安全解压 bundle（复用 unpack 信任边界）并把任何
 * 声明的 plugin 引用路由到 operator plugins 库（<OPENRIG_HOME>/plugins/<id>/）。
 * bundle 无 plugins[] 时返回 null（no-op）。routeSkillsAfterBootstrap 模式的镜像——
 * 只用 bundlePath（按 5f410eee B1 教训与 installMeta 解耦；路由在 dual-override
 * 路径也必须触发）。
 */
async function routePluginsAfterBootstrap(bundlePath: string): Promise<RoutePluginsResult | null> {
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-plugins-route-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) return null;
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const rawPlugins = manifest["plugins"];
    if (!Array.isArray(rawPlugins) || rawPlugins.length === 0) return null;
    const declaredPlugins: PluginRoutingInput[] = [];
    for (const entry of rawPlugins) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as Record<string, unknown>;
      const s = p["source"];
      if (typeof p["id"] !== "string" || !p["id"]) continue;
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const src = s as Record<string, unknown>;
      if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
      declaredPlugins.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
    }
    if (declaredPlugins.length === 0) return null;
    return routePlugins(
      {
        bundleRoot: tmpDir,
        declaredPlugins,
        targetPluginsDir: getDefaultOpenRigPath("plugins"),
      },
      pluginsRouterFsOps(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Item 6 / slice-05 Checkpoint 7.3：node:fs 支撑的真实 SkillsRouterFsOps。 */
function skillsRouterFsOps(): SkillsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

/**
 * Item 6 / slice-05 Checkpoint 7.3：安全解压 bundle（复用 unpack 信任边界）并把 legacy
 * 声明的 skill 文件路由到 package 缓存。S04 把这种 package 形状的 payload 排除在托管
 * skill catalog 外；把完整 harness skill 导入 catalog 是单独动作。bundle 无 skills[]
 * 时返回 null（no-op）。
 *
 * B1 修复（qitem-20260518220247-22f5257a）：只用 bundlePath 并自己做安全 unpack +
 * parse。先前耦合到 pre-check 抽取的 installMeta，当 operator 同时传 --skip-version-check
 * 与 --force 时它是 null；那错误地抑制了 dual-override 路径上的 post-install skills 路由。
 * Skills 路由独立于 pre-check 决策，应在任何声明 skills 的 bundle 安装成功时触发。
 *
 * Best-effort：任何抽取/解析失败返回 null（调用方有外层 try/catch）。每次调用一次
 * unpack；manifest 重解析相对 unpack 成本很便宜，而 unpack 无论如何都要做才能访问
 * skill 源文件做路由。
 */
async function routeSkillsAfterBootstrap(bundlePath: string): Promise<RouteSkillsResult | null> {
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-skills-route-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) return null;
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const rawSkills = manifest["skills"];
    if (!Array.isArray(rawSkills) || rawSkills.length === 0) return null;
    const declaredSkills = rawSkills.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (declaredSkills.length === 0) return null;
    return routeSkills(
      {
        bundleRoot: tmpDir,
        declaredSkills,
        targetSkillsDir: getDefaultOpenRigPath("packages"),
        targetPrefixToStrip: "packages/",
      },
      skillsRouterFsOps(),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Item 4 / slice-05 Checkpoint 5.2：node:fs 支撑的真实 BundleAuditFsOps。 */
function auditFsOps(): BundleAuditFsOps {
  return {
    appendFile: (p, c) => fs.appendFileSync(p, c, "utf-8"),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

/**
 * 审计文件路径在调用时经 getDefaultOpenRigPath（"bundle-audit.jsonl"）解析。
 * 函数级读取（无模块级常量），使请求/测试之间 OPENRIG_HOME env 变化被遵守。
 */
function bundleAuditPath(): string {
  return getDefaultOpenRigPath("bundle-audit.jsonl");
}

/**
 * Item 4 / slice-05 Checkpoint 5.3：追加 bundle 安装审计记录。Best-effort——审计失败经
 * eventBus 形状记日志，但绝不使安装响应失败（安装已发生或已失败；审计是 side-channel
 * 记录）。bundleManifest 可选；存在时 provenance.source_host 镜像进记录。
 */
function writeInstallAudit(opts: {
  bundlePath: string;
  outcome: "success" | "failed" | "partial";
  targetRigId?: string;
  targetRigName?: string;
  cliVersion?: string;
  bundleManifest?: Record<string, unknown>;
}): void {
  try {
    const writer = new BundleAuditWriter({
      opts: { auditPath: bundleAuditPath() },
      fsOps: auditFsOps(),
    });
    const provenance = normalizeProvenanceBlock(opts.bundleManifest?.["provenance"]);
    const record: BundleAuditRecord = {
      installedAt: new Date().toISOString(),
      bundlePath: opts.bundlePath,
      outcome: opts.outcome,
    };
    if (opts.targetRigId) record.targetRigId = opts.targetRigId;
    if (opts.targetRigName) record.targetRigName = opts.targetRigName;
    if (opts.cliVersion) record.cliVersion = opts.cliVersion;
    record.daemonVersion = getDaemonVersion();
    if (provenance?.sourceHost) record.sourceHost = provenance.sourceHost;
    writer.append(record);
  } catch {
    // 审计写失败是 side-channel；绝不使安装响应失败。
    // 未来增强：经 eventBus 呈现（本次提交范围外）。
  }
}

/**
 * Item 6 / slice-05 Checkpoint 7.5（QA-20260601 A2 修复）：消费源根处 author 提供的
 * bundle.yaml，并把声明的 cross-primitive 内容 vendor 进 staging 树。在 assembler
 * 建好 staging（rig.yaml + agents/）之后、computeIntegrity 之前运行，使 vendor 的内容
 * 落进 integrity manifest。
 *
 * Auto-detect 契约（按 orch 裁决，无新 CLI flag）：若源根存在 bundle.yaml，解析它并消费
 * 5 个 cross-primitive 字段（skills、plugins、workflow_specs、context_packs、
 * agent_images）。Provenance + compatibility 保持仅请求 body（create 时由调用方控制）。
 * 源根无 bundle.yaml 则 no-op（既有行为不变）。
 *
 * Vendor 语义：
 * - 每个声明路径相对源根解析。
 * - 双侧包含：源路径在 sourceRoot 下，目标路径在 staging 下（复用
 *   feedback_pre_existing_trust_boundary_reuse_canonical_helper
 *   附录，贯穿 7.3a-g）。
 * - symlink 在 create 时被跟随，作为常规文件写入 staging 树（tar 安全；复用既有
 *   信任边界教训——归档中绝不包含 symlink 条目）。
 * - 按种类形状：skills + workflow_specs 是文件路径（单文件拷贝）；plugins +
 *   context_packs（manifest.yaml 路径→父目录）+ agent_images 是目录路径（递归拷贝
 *   带 symlink 解引用）。
 * - 缺源路径 / 路径包含违规 / realpath 逃逸时 throw（复用 79a89d40 B1：词法包含
 *   本身不足——sourceRoot 下的 symlink 可指向外部内容；每个声明路径都经 realpath
 *   校验，dir vendor 预先用 lstat 走树以捕获嵌套 symlink 逃逸）。/create 路由的外层
 *   catch 带消息返回 500；若这对操作员 UX 映射不佳，后续可包成 400。
 *
 * 返回 cross-primitive 块，以填充到 assembler 返回的 manifest 上。/create 路由在填充
 * 这些字段后写 manifest，使构建的 bundle.yaml 携带它们供 install 侧路由。
 */
interface AuthorBundleCrossPrimitives {
  skills?: string[];
  plugins?: BundlePluginReference[];
  workflowSpecs?: string[];
  contextPacks?: string[];
  agentImages?: string[];
}

function consumeAuthorBundleYaml(sourceRoot: string, staging: string): AuthorBundleCrossPrimitives {
  const authorBundlePath = nodePath.join(sourceRoot, "bundle.yaml");
  if (!fs.existsSync(authorBundlePath)) return {};
  // vendor 前规范化 sourceRoot（复用 79a89d40 B1 守卫 catch：词法包含 + 解引用允许
  // sourceRoot 下的 symlink 逃逸）。对根 realpath 一次；每个声明路径的 realpath 必须
  // 留在本边界内。
  const sourceRootReal = fs.realpathSync(sourceRoot);
  const stagingResolved = nodePath.resolve(staging);

  /** Realpath 包含检查：`absPath` 背后的真实文件/目录（symlink 解析后）必须住在
   * sourceRootReal 下。即使词法路径在 sourceRoot 内，也能捕获目标逃出源树的
   * symlink。逃逸时 throw。 */
  const assertSourceRealContained = (absPath: string, kindLabel: string, declared: string): string => {
    let realPath: string;
    try {
      realPath = fs.realpathSync(absPath);
    } catch (err) {
      throw new Error(`author bundle ${kindLabel} '${declared}' 在源中不存在：${(err as Error).message}`);
    }
    if (realPath !== sourceRootReal && !realPath.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} '${declared}' 解析到 bundle 源根外（symlink 逃逸）；已拒绝`);
    }
    return realPath;
  };

  /** 用 lstat 预走目录树；对每个遇到的 symlink，realpath 校验在 sourceRootReal 下包含。
   * 常规文件和目录无需特殊检查（它们固有地被包含——问题类是 symlink 逃逸）。任何
   * 逃逸都 throw。 */
  const assertNoSymlinkEscapeInTree = (dirAbs: string, kindLabel: string, declared: string): void => {
    const stack: string[] = [dirAbs];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        // 不可读目录——跳过；若实际有影响，cpSync 会呈现失败
        continue;
      }
      for (const entry of entries) {
        const entryAbs = nodePath.join(cur, entry.name);
        if (entry.isSymbolicLink()) {
          // 对 symlink 目标 realpath；若逃出 sourceRootReal 则拒绝
          let entryReal: string;
          try {
            entryReal = fs.realpathSync(entryAbs);
          } catch (err) {
            throw new Error(`author bundle ${kindLabel} '${declared}' 在 '${nodePath.relative(sourceRootReal, entryAbs)}' 有不可读 symlink：${(err as Error).message}`);
          }
          if (entryReal !== sourceRootReal && !entryReal.startsWith(sourceRootReal + nodePath.sep)) {
            throw new Error(`author bundle ${kindLabel} '${declared}' 在 '${nodePath.relative(sourceRootReal, entryAbs)}' 含嵌套 symlink 逃出 bundle 源根；已拒绝`);
          }
          // 若 symlink 目标是 sourceRoot 下的目录，走它
          // （带 dereference:true 的 cpSync 会跟随；我们也需要校验任何嵌套 symlink）
          try {
            const st = fs.statSync(entryReal);
            if (st.isDirectory()) stack.push(entryReal);
          } catch { /* unreadable — skip */ }
        } else if (entry.isDirectory()) {
          stack.push(entryAbs);
        }
      }
    }
  };

  const authorYaml = fs.readFileSync(authorBundlePath, "utf-8");
  const authorParsed = parsePodBundleManifest(authorYaml) as Record<string, unknown>;
  const result: AuthorBundleCrossPrimitives = {};

  const vendorFile = (declared: string, kindLabel: string): void => {
    if (!isRelativeSafePath(declared)) throw new Error(`author bundle ${kindLabel} 路径 '${declared}' 不安全`);
    const sourceAbs = nodePath.resolve(sourceRootReal, declared);
    // 词法包含 + realpath 包含（复用 79a89d40 B1）
    if (sourceAbs !== sourceRootReal && !sourceAbs.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} 路径 '${declared}' 逃出 bundle 源根`);
    }
    if (!fs.existsSync(sourceAbs)) throw new Error(`author bundle ${kindLabel} '${declared}' 在源中不存在`);
    assertSourceRealContained(sourceAbs, kindLabel, declared);
    const targetAbs = nodePath.resolve(staging, declared);
    if (!targetAbs.startsWith(stagingResolved + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} 目标 '${declared}' 逃出 staging`);
    }
    // readFileSync 跟随 symlink；我们已校验其 realpath 留在 sourceRootReal 内。
    // 作为常规文件写（tar 安全）。
    const content = fs.readFileSync(sourceAbs);
    assertShippableSubstance([{ path: declared, bytes: content }]);
    fs.mkdirSync(nodePath.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, content);
  };
  const vendorDir = (declared: string, kindLabel: string): void => {
    if (!isRelativeSafePath(declared)) throw new Error(`author bundle ${kindLabel} 路径 '${declared}' 不安全`);
    const sourceAbs = nodePath.resolve(sourceRootReal, declared);
    if (sourceAbs !== sourceRootReal && !sourceAbs.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} 路径 '${declared}' 逃出 bundle 源根`);
    }
    if (!fs.existsSync(sourceAbs)) throw new Error(`author bundle ${kindLabel} '${declared}' 在源中不存在`);
    // 对声明的 dir 本身做 realpath 校验（捕获 symlink 指向外部目录）
    const sourceReal = assertSourceRealContained(sourceAbs, kindLabel, declared);
    // 在 cpSync 解引用任何东西之前，预走 realpath 解析后的 dir 以捕获嵌套 symlink 逃逸
    assertNoSymlinkEscapeInTree(sourceReal, kindLabel, declared);
    const sources: Array<{ path: string; bytes: Buffer }> = [];
    const collectSources = (current: string, prefix: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = nodePath.join(current, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collectSources(child, relativePath);
        else if (entry.isSymbolicLink() && fs.statSync(child).isDirectory()) {
          collectSources(fs.realpathSync(child), relativePath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          sources.push({ path: nodePath.join(declared, relativePath), bytes: fs.readFileSync(child) });
        }
      }
    };
    collectSources(sourceReal, "");
    assertShippableSubstance(sources);
    const targetAbs = nodePath.resolve(staging, declared);
    if (!targetAbs.startsWith(stagingResolved + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} 目标 '${declared}' 逃出 staging`);
    }
    fs.mkdirSync(nodePath.dirname(targetAbs), { recursive: true });
    // dereference: true→ symlink 被跟随（现已校验安全）并作为常规文件写以保证 tar 安全
    fs.cpSync(sourceAbs, targetAbs, { recursive: true, dereference: true });
  };

  // skills[]——文件路径。
  const rawSkills = authorParsed["skills"];
  if (Array.isArray(rawSkills) && rawSkills.length > 0) {
    const skills = rawSkills.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of skills) vendorFile(declared, "skill");
    if (skills.length > 0) result.skills = skills;
  }

  // plugins[]——经 source.path 的目录路径
  const rawPlugins = authorParsed["plugins"];
  if (Array.isArray(rawPlugins) && rawPlugins.length > 0) {
    const plugins: BundlePluginReference[] = [];
    for (const entry of rawPlugins) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as Record<string, unknown>;
      const s = p["source"];
      if (typeof p["id"] !== "string" || !p["id"]) continue;
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const src = s as Record<string, unknown>;
      if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
      vendorDir(src["path"], `plugin '${p["id"]}'`);
      plugins.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
    }
    if (plugins.length > 0) result.plugins = plugins;
  }

  // workflow_specs[]——文件路径。
  const rawWorkflowSpecs = authorParsed["workflow_specs"];
  if (Array.isArray(rawWorkflowSpecs) && rawWorkflowSpecs.length > 0) {
    const workflowSpecs = rawWorkflowSpecs.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of workflowSpecs) vendorFile(declared, "workflow_spec");
    if (workflowSpecs.length > 0) result.workflowSpecs = workflowSpecs;
  }

  // context_packs[]——manifest.yaml 路径；vendor 父目录
  const rawContextPacks = authorParsed["context_packs"];
  if (Array.isArray(rawContextPacks) && rawContextPacks.length > 0) {
    const contextPacks = rawContextPacks.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of contextPacks) {
      const parentRel = nodePath.dirname(declared);
      if (parentRel === ".") continue; // 在根声明；无有意义内容可 vendor
      vendorDir(parentRel, `context_pack parent of '${declared}'`);
    }
    if (contextPacks.length > 0) result.contextPacks = contextPacks;
  }

  // agent_images[]——目录路径。
  const rawAgentImages = authorParsed["agent_images"];
  if (Array.isArray(rawAgentImages) && rawAgentImages.length > 0) {
    const agentImages = rawAgentImages.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of agentImages) vendorDir(declared, "agent_image");
    if (agentImages.length > 0) result.agentImages = agentImages;
  }

  return result;
}

/** 扫描最终将被打包的精确目录树，包括生成文件。 */
function assertShippableStagingTree(staging: string): void {
  const sources: Array<{ path: string; bytes: Buffer }> = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        sources.push({
          path: nodePath.relative(staging, absolute).split(nodePath.sep).join("/"),
          bytes: fs.readFileSync(absolute),
        });
      } else {
        throw new Error(`公开产物内容被拒绝：不支持的暂存条目 '${nodePath.relative(staging, absolute)}'`);
      }
    }
  };
  walk(staging);
  assertShippableSubstance(sources);
}

// POST /api/bundles/create
bundleRoutes.post("/create", async (c) => {
  const { eventBus } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const specPath = typeof body["specPath"] === "string" ? body["specPath"] : "";
  const bundleName = typeof body["bundleName"] === "string" ? body["bundleName"] : "";
  const bundleVersion = typeof body["bundleVersion"] === "string" ? body["bundleVersion"] : "";
  const outputPath = typeof body["outputPath"] === "string" ? body["outputPath"] : "";
  const rigRoot = typeof body["rigRoot"] === "string" ? body["rigRoot"] : undefined;
  const includePackages = Array.isArray(body["includePackages"]) ? body["includePackages"] as string[] : undefined;

  const allowDrift = body["allowDrift"] === true;

  // Item 1 / slice-05：从请求 body 构建 provenance + server 侧注入 daemonVersion
  const clientProvenance = provenanceFromRequestBody(body["provenance"]);
  let provenance: BundleProvenance | undefined = clientProvenance
    ? { ...clientProvenance, daemonVersion: getDaemonVersion() }
    : undefined;

  // Item 2 / slice-05：从请求 body 构建 compatibility（无 server 侧字段）
  const compatibility = compatibilityFromRequestBody(body["compatibility"]);

  if (!specPath || !bundleName || !bundleVersion || !outputPath) {
    return c.json({ error: "specPath、bundleName、bundleVersion、outputPath 为必填项" }, 400);
  }

  try {
    // 读 spec 并检测格式
    const specYaml = fs.readFileSync(nodePath.resolve(specPath), "utf-8");
    const rawParsed = RigSpecCodec.parse(specYaml);
    const isPodAware = rawParsed && typeof rawParsed === "object" && Array.isArray((rawParsed as Record<string, unknown>).pods);

    // 先校验再评估。畸形 spec 没有可信拓扑可比，对它抛 drift 409 会把文件损坏归咎于
    // 工作组——让操作员去调和拓扑，而真正答案是"此 spec 解析不了"。Schema 错误保留
    // 既有 400，在守卫运行前返回。
    if (isPodAware) {
      const podValidation = RigSpecSchema.validate(rawParsed);
      if (!podValidation.valid) return c.json({ error: "非法 pod-aware 工作组 spec", errors: podValidation.errors }, 400);
    } else {
      const legacyValidation = LegacyRigSpecSchema.validate(rawParsed);
      if (!legacyValidation.valid) return c.json({ error: "非法工作组 spec", errors: legacyValidation.errors }, 400);
    }

    // bundle 逐字携带 SPEC，从不查 live DB，所以当工作组持久拓扑已变（无代码路径把 spec
    // 写回）时，导出会 ship 与记录不同的工作组。Build B 让那个 delta 可被说出；在 201
    // 上说还不够。.rigbundle 是恢复 artifact，钉在成功上的警告在最不该被读的时刻才被读——
    // 所以任何不合规拓扑在此拒绝。
    //
    // repository 读本身失败时它 throw 而非返回 null，这正是要点：吞掉 DB 错误的 enforcement
    // 路径会报告"无 drift"并导出，那正是本守卫存在要移除的 fail-OPEN。它经下面的 500
    // 失败关闭。
    const drift = assessSpecLiveDrift(rawParsed, getDeps(c).rigRepo);
    const driftWarning = drift ? bundleExportWarning(drift) : null;
    if (driftWarning) console.warn(`[bundle-create] ${driftWarning}`);

    if (specDivergesFromLive(drift) && !allowDrift) {
      return c.json({ error: bundleExportRefusal(drift!) }, 409);
    }

    // 被覆盖：操作员说他们认真要做，所以分歧带进 artifact。HTTP 警告随打印它的 terminal
    // 一同消亡；几个月后谁恢复这个 bundle 读 manifest，它绝不能呈现为工作组的忠实快照。
    if (driftWarning && allowDrift) {
      const stamp = `以 --allow-drift 导出：${driftWarning}`;
      provenance = {
        ...(provenance ?? { daemonVersion: getDaemonVersion() }),
        notes: provenance?.notes ? `${provenance.notes} | ${stamp}` : stamp,
      };
    }

    if (isPodAware) {
      // Pod-aware bundle 创建
      // 上面已校验，在 drift 守卫运行前。
      const effectiveRigRoot = rigRoot ? nodePath.resolve(rigRoot) : nodePath.dirname(nodePath.resolve(specPath));
      const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pod-bundle-create-"));
      try {
        const assembler = new PodBundleAssembler({ fsOps: podAssemblerFsOps() });
        const result = assembler.assemble({ rigRoot: effectiveRigRoot, rigSpecPath: nodePath.resolve(specPath), outputDir: tmpStaging, bundleName, bundleVersion, provenance, compatibility });

        // Item 6 / Checkpoint 7.5（QA-20260601 A2 修复）：在工作组源根 auto-detect
        // author bundle.yaml；把声明的 cross-primitive 内容 vendor 进 staging + 把字段
        // 带到 manifest。下面的 computeIntegrity 覆盖 vendor 的内容。
        const authorPrimitives = consumeAuthorBundleYaml(effectiveRigRoot, tmpStaging);
        if (authorPrimitives.skills) result.manifest.skills = authorPrimitives.skills;
        if (authorPrimitives.plugins) result.manifest.plugins = authorPrimitives.plugins;
        if (authorPrimitives.workflowSpecs) result.manifest.workflowSpecs = authorPrimitives.workflowSpecs;
        if (authorPrimitives.contextPacks) result.manifest.contextPacks = authorPrimitives.contextPacks;
        if (authorPrimitives.agentImages) result.manifest.agentImages = authorPrimitives.agentImages;

        const integrity = computeIntegrity(tmpStaging, integrityFsOps());
        result.manifest.integrity = integrity;
        fs.writeFileSync(nodePath.join(tmpStaging, "bundle.yaml"), serializePodBundleManifest(result.manifest), "utf-8");

        assertShippableStagingTree(tmpStaging);
        const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));
        eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });
        return c.json({ bundleName, bundleVersion, archiveHash, schemaVersion: 2, agents: result.manifest.agents.length, ...(driftWarning ? { warning: driftWarning } : {}) }, 201);
      } finally {
        fs.rmSync(tmpStaging, { recursive: true, force: true });
      }
    }

    // Legacy bundle 创建
    // 上面已校验，在 drift 守卫运行前。
    const spec = LegacyRigSpecSchema.normalize(rawParsed);

    const specDir = nodePath.dirname(nodePath.resolve(specPath));
    const allRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.packageRefs) for (const ref of node.packageRefs) allRefs.add(ref);
    }

    const refsToBundle = includePackages ?? [...allRefs];

    if (includePackages) {
      const includedSet = new Set(includePackages);
      const missing = [...allRefs].filter((r) => !includedSet.has(r));
      if (missing.length > 0) {
        return c.json({ error: "提供的 packages 未覆盖工作组 spec 的所有 package_refs", missing }, 400);
      }
    }

    const fsOps = realFsOps();
    const packages = [];
    for (const ref of refsToBundle) {
      const cleanRef = ref.startsWith("local:") ? ref.slice(6) : ref;
      const result = resolvePackage(cleanRef, specDir, fsOps);
      if (!result.ok) {
        const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
        return c.json({ error: `解析 package '${ref}' 失败：${errMsg}` }, 400);
      }
      packages.push({
        name: result.resolved.manifest.name,
        version: result.resolved.manifest.version,
        sourcePath: result.resolved.sourceRef,
        originalSource: ref,
        manifestHash: result.resolved.manifestHash,
      });
    }

    const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-create-"));
    try {
      const assembler = new BundleAssembler({ fsOps: assemblerFsOps() });
      const manifest = assembler.assemble({
        specPath: nodePath.resolve(specPath), packages, outputDir: tmpStaging, bundleName, bundleVersion, provenance, compatibility,
      });

      // Item 6 / Checkpoint 7.5（QA-20260601 A2 修复，legacy 路径镜像）：在源目录
      // auto-detect author bundle.yaml；在 integrity 前 vendor + 带 cross-primitive
      // 字段。重序列化 bundle.yaml，因为 assembler 已写了一个不含这些字段的。
      const legacyAuthorPrimitives = consumeAuthorBundleYaml(specDir, tmpStaging);
      const hasLegacyPrimitives = legacyAuthorPrimitives.skills || legacyAuthorPrimitives.plugins ||
        legacyAuthorPrimitives.workflowSpecs || legacyAuthorPrimitives.contextPacks || legacyAuthorPrimitives.agentImages;
      if (hasLegacyPrimitives) {
        if (legacyAuthorPrimitives.skills) manifest.skills = legacyAuthorPrimitives.skills;
        if (legacyAuthorPrimitives.plugins) manifest.plugins = legacyAuthorPrimitives.plugins;
        if (legacyAuthorPrimitives.workflowSpecs) manifest.workflowSpecs = legacyAuthorPrimitives.workflowSpecs;
        if (legacyAuthorPrimitives.contextPacks) manifest.contextPacks = legacyAuthorPrimitives.contextPacks;
        if (legacyAuthorPrimitives.agentImages) manifest.agentImages = legacyAuthorPrimitives.agentImages;
        const { serializeLegacyBundleManifest } = await import("../domain/bundle-types.js");
        fs.writeFileSync(nodePath.join(tmpStaging, "bundle.yaml"), serializeLegacyBundleManifest(manifest), "utf-8");
      }

      const integrity = computeIntegrity(tmpStaging, integrityFsOps());
      writeIntegrity(tmpStaging, integrity, integrityFsOps());

      assertShippableStagingTree(tmpStaging);
      const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));
      eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });
      return c.json({ bundleName, bundleVersion, archiveHash, packages: manifest.packages.length, ...(driftWarning ? { warning: driftWarning } : {}) }, 201);
    } finally {
      fs.rmSync(tmpStaging, { recursive: true, force: true });
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /api/bundles/inspect
bundleRoutes.post("/inspect", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";

  if (!bundlePath) return c.json({ error: "bundlePath 为必填项" }, 400);

  let digestValid = false;
  try {
    const dr = verifyArchiveDigest(bundlePath);
    digestValid = dr.valid;
  } catch { /* 缺 digest = 非法 */ }

  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-inspect-"));
  try {
    // 用安全预扫描抽取（同 unpack）但不做内容完整性验证
    const tar = await import("tar");
    const unsafeEntries: string[] = [];
    await tar.list({
      file: bundlePath,
      onReadEntry: (entry) => {
        const p = entry.path;
        const t = entry.type;
        if (t === "SymbolicLink" || t === "Link") unsafeEntries.push(`${t}: ${p}`);
        if (p.startsWith("/")) unsafeEntries.push(`absolute: ${p}`);
        if (p.split("/").some((s: string) => s === "..")) unsafeEntries.push(`traversal: ${p}`);
      },
    });
    if (unsafeEntries.length > 0) {
      return c.json({ error: `不安全归档条目：${unsafeEntries.join("; ")}`, digestValid }, 200);
    }
    await tar.extract({ file: bundlePath, cwd: tmpDir });

    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) {
      return c.json({ error: "bundle 缺 bundle.yaml", digestValid }, 200);
    }
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const rawParsed = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;

    // 检测 v2（pod-aware）vs v1（legacy）
    if (rawParsed && rawParsed["schema_version"] === 2) {
      const validation = validatePodBundleManifest(rawParsed);
      if (!validation.valid) {
        return c.json({ error: `非法 v2 manifest：${validation.errors.join("; ")}`, digestValid }, 200);
      }
      const agents = (rawParsed["agents"] as Array<Record<string, unknown>>).map((a) => ({
        name: a["name"] as string,
        version: (a["version"] as string) ?? "",
        path: a["path"] as string,
      }));
      // 从 raw manifest 抽 integrity
      const integritySection = rawParsed["integrity"] as { algorithm?: string; files?: Record<string, string> } | undefined;
      const podManifest = {
        schemaVersion: 2 as const,
        name: rawParsed["name"] as string,
        version: rawParsed["version"] as string,
        createdAt: rawParsed["created_at"] as string,
        rigSpec: rawParsed["rig_spec"] as string,
        agents,
        integrity: integritySection ? {
          algorithm: integritySection.algorithm ?? "sha256",
          files: integritySection.files ?? {},
        } : undefined,
        // Item 1 / slice-05：以规范化 camelCase 呈现 provenance，使
        // /api/bundles/inspect 契约无论 v1 vs v2 都是一个形状（v1 路径经下面的
        // normalizeLegacyBundleManifest 规范化）。字段可选；bundle 无 provenance 时 undefined。
        provenance: normalizeProvenanceBlock(rawParsed["provenance"]),
        // Item 2 / slice-05：以规范化 camelCase 呈现 compatibility（与上面 provenance
        // 相同的单契约理由）。v1 已在本 handler 末尾经 normalizer 呈现。
        compatibility: normalizeCompatibilityBlock(rawParsed["compatibility"]),
        // Item 6 / Checkpoint 7.5 / QA-20260601 C1 修复：以规范化 camelCase 呈现 5 个
        // cross-primitive 块，使 /inspect 契约携带 v1 normalizer 已呈现的同形状。
        // raw YAML key 是 snake_case；暴露 camelCase 以匹配 v2 inspect 契约其余部分。
        skills: Array.isArray(rawParsed["skills"])
          ? (rawParsed["skills"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        plugins: Array.isArray(rawParsed["plugins"])
          ? (rawParsed["plugins"] as Array<Record<string, unknown>>).filter((p) => p && typeof p === "object")
          : undefined,
        workflowSpecs: Array.isArray(rawParsed["workflow_specs"])
          ? (rawParsed["workflow_specs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        contextPacks: Array.isArray(rawParsed["context_packs"])
          ? (rawParsed["context_packs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        agentImages: Array.isArray(rawParsed["agent_images"])
          ? (rawParsed["agent_images"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
      };
      const integrityCompat = integritySection ? {
        schemaVersion: 2,
        name: podManifest.name,
        version: podManifest.version,
        createdAt: podManifest.createdAt,
        rigSpec: podManifest.rigSpec,
        packages: [],
        integrity: { algorithm: "sha256" as const, files: integritySection.files ?? {} },
      } : undefined;
      const integrityResult = integrityCompat
        ? verifyIntegrity(tmpDir, integrityCompat, integrityFsOps())
        : { passed: false, mismatches: [], missing: [], extra: [], errors: ["no integrity section"] };
      return c.json({ manifest: podManifest, digestValid, integrityResult }, 200);
    }

    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const integrityResult = manifest.integrity
      ? verifyIntegrity(tmpDir, manifest, integrityFsOps())
      : { passed: false, mismatches: [], missing: [], extra: [], errors: ["no integrity section"] };
    return c.json({ manifest, digestValid, integrityResult }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// GET /api/bundles/history——Item 4 / slice-05 Checkpoint 5.2
// 返回安装审计 JSONL 记录（可按工作组名和/或 since 时间戳过滤）。只读——无审计写
// side effect。空审计文件返回 []。reader 对畸形 JSONL 行 fail-open（与未来记录形状
// 演进的 forward-compat）。
bundleRoutes.get("/history", async (c) => {
  const rig = c.req.query("rig");
  const since = c.req.query("since");
  const reader = new BundleAuditReader({
    opts: { auditPath: bundleAuditPath() },
    fsOps: auditFsOps(),
  });
  const records = reader.list({
    rig: typeof rig === "string" && rig.length > 0 ? rig : undefined,
    since: typeof since === "string" && since.length > 0 ? since : undefined,
  });
  return c.json({ records, total: records.length }, 200);
});

// POST /api/bundles/install——复用完整 bootstrap 生命周期
bundleRoutes.post("/install", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, rigRepo } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;
  // Item 2 / slice-05 Checkpoint 3.3：安装时兼容性检查输入
  const skipVersionCheck = body["skipVersionCheck"] === true;
  const clientCliVersion = typeof body["cliVersion"] === "string" ? body["cliVersion"] : undefined;
  // Item 3 / slice-05 Checkpoint 4.2：安装时冲突检查输入
  const force = body["force"] === true;

  if (!bundlePath) return c.json({ error: "bundlePath 为必填项" }, 400);
  if (!plan && !targetRoot) return c.json({ error: "apply 模式下 targetRoot 为必填项" }, 400);

  // 并发锁——在 compat 检查前运行，使既有 409 语义（并发安装检测）逐字保留。
  if (!bootstrapOrchestrator.tryAcquire(bundlePath)) {
    return c.json({ error: "bundle 安装已在进行中", code: "conflict" }, 409);
  }

  try {
  // Item 2 / slice-05 Checkpoint 3.3：安装时兼容性检查
  // 在锁之后 + bootstrap 委托之前运行。不匹配返回三段式错误并退出生命周期（锁经外层
  // finally 释放）。操作员经 --skip-version-check 覆盖（请求 body skipVersionCheck=true）。
  // Item 2 + Item 3 / slice-05：一次安全抽取 pass 同时产出 bundle manifest（compat 检查用）
  // 和工作组名（冲突检查用）。调用方可经 skipVersionCheck 跳过 compat 检查；冲突检查也
  // 从这同一抽取 pass 运行，除非 --force 绕过。
  let installMeta: { bundleManifest: Record<string, unknown>; rigName: string | undefined } | null = null;
  if (!skipVersionCheck || !force) {
    try {
      installMeta = await extractInstallTimeMetadata(bundlePath);
    } catch (err) {
      return c.json({
        error: "bundle 安装 pre-check 无法运行（抽取失败）",
        detail: (err as Error).message,
        resolutions: [
          "确认 bundle 路径正确且归档可读",
          "带 --skip-version-check 与 --force 绕过两项 pre-check（除非有意为之，不推荐）",
        ],
      }, 400);
    }
  }

  if (!skipVersionCheck && installMeta) {
    const compatibility = normalizeCompatibilityBlock(installMeta.bundleManifest["compatibility"]);
    const failures = checkBundleCompatibility(compatibility, getDaemonVersion(), clientCliVersion);
    if (failures) {
      return c.json({
        error: "bundle 兼容性检查失败",
        failures,
        resolutions: [
          "把受影响 runtime 升级到要求版本（推荐）",
          "使用最低要求更宽松的 bundle",
          "带 --skip-version-check 绕过以供操作员显式覆盖（日常使用不推荐）",
        ],
      }, 400);
    }
  }

  // Item 3 / slice-05 Checkpoint 4.2：安装时冲突检查
  // 在 compat 检查之后 + bootstrap 委托之前运行。不匹配返回带三段式错误形状的 400
  // （error + conflicts[] + resolutions[]）。操作员经 --force 覆盖（请求 body force=true）。
  // 检查在抽取失败时 fail CLOSED（上面已处理），在 bundle 缺工作组名时 fail-OPEN
  // （无工作组名可比）。
  if (!force && installMeta && rigRepo) {
    const runningRigs = rigRepo.listRigs().map((r) => ({ rigId: r.id, name: r.name }));
    const report = detectBundleConflicts({
      bundleRigName: installMeta.rigName ?? "",
      runningRigs,
    });
    if (report.hasConflicts) {
      return c.json({
        error: "bundle 安装冲突检查失败",
        conflicts: report.conflicts,
        resolutions: [
          "停掉冲突中的运行工作组并重试安装",
          "用 --force 绕过以供操作员显式覆盖（日常使用不推荐；冲突可能产生部分安装状态）",
        ],
      }, 400);
    }
  }

  if (plan) {
    // Plan 模式：无运行生命周期
    try {
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "plan", sourceRef: bundlePath, sourceKind: "rig_bundle",
      });
      if (result.status === "planned") {
        eventBus.emit({ type: "bootstrap.planned", runId: result.runId, sourceRef: bundlePath, stages: result.stages.length });
        return c.json(result, 200);
      }
      // Plan 失败——结构化映射（同 bootstrap plan 路由）
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: bundlePath, error: result.errors[0] ?? "plan failed" });
      const failedStage = result.stages.find((s: { status: string; detail?: unknown }) => s.status === "failed" || s.status === "blocked");
      let httpStatus: number = 500;
      if (failedStage) {
        if (failedStage.status === "blocked") httpStatus = 409;
        else if (failedStage.stage === "resolve_spec") {
          const detail = failedStage.detail as { code?: string } | undefined;
          if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error") httpStatus = 400;
        }
      }
      return c.json(result, httpStatus as 400 | 409 | 500);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // Apply 模式：带 bootstrap.started 的完整运行生命周期
  const run = bootstrapRepo.createRun("rig_bundle", bundlePath);
  bootstrapRepo.updateRunStatus(run.id, "running");
  eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef: bundlePath });

  try {
    const result = await bootstrapOrchestrator.bootstrap({
      mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle",
      autoApprove, targetRoot, runId: run.id,
    });

    if (result.status === "completed") {
      eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef: bundlePath });
      writeInstallAudit({
        bundlePath, outcome: "success", targetRigId: result.rigId,
        targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
        bundleManifest: installMeta?.bundleManifest,
      });
      // Item 6 / Checkpoint 7.3：成功安装后路由任何声明的 skills。Best-effort：路由失败
      // 不使安装响应失败（安装已成功；skills 路由是 side-channel post-install 步骤）。
      // 路由结果含在响应 body 中，使操作员看到落了什么。
      let skillsRouting: RouteSkillsResult | null = null;
      let pluginsRouting: RoutePluginsResult | null = null;
      let workflowSpecsRouting: RouteWorkflowSpecsResult | null = null;
      let contextPacksRouting: RouteContextPacksResult | null = null;
      let agentImagesRouting: RouteAgentImagesResult | null = null;
      try {
        skillsRouting = await routeSkillsAfterBootstrap(bundlePath);
      } catch {
        // Side-channel 失败；安装已成功
      }
      try {
        pluginsRouting = await routePluginsAfterBootstrap(bundlePath);
      } catch {
        // Side-channel 失败；安装已成功
      }
      try {
        workflowSpecsRouting = await routeWorkflowSpecsAfterBootstrap(bundlePath);
      } catch {
        // Side-channel 失败；安装已成功
      }
      try {
        contextPacksRouting = await routeContextPacksAfterBootstrap(bundlePath);
      } catch {
        // Side-channel 失败；安装已成功
      }
      try {
        agentImagesRouting = await routeAgentImagesAfterBootstrap(bundlePath);
      } catch {
        // Side-channel 失败；安装已成功
      }
      const extras: Record<string, unknown> = {};
      if (skillsRouting) extras.skillsRouting = skillsRouting;
      if (pluginsRouting) extras.pluginsRouting = pluginsRouting;
      if (workflowSpecsRouting) extras.workflowSpecsRouting = workflowSpecsRouting;
      if (contextPacksRouting) extras.contextPacksRouting = contextPacksRouting;
      if (agentImagesRouting) extras.agentImagesRouting = agentImagesRouting;
      return c.json(Object.keys(extras).length > 0 ? { ...result, ...extras } : result, 201);
    }
    if (result.status === "partial") {
      const ok = result.stages.filter((s: { status: string }) => s.status === "ok").length;
      const fail = result.stages.filter((s: { status: string }) => s.status === "failed" || s.status === "blocked").length;
      eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef: bundlePath, rigId: result.rigId, completed: ok, failed: fail });
      writeInstallAudit({
        bundlePath, outcome: "partial", targetRigId: result.rigId,
        targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
        bundleManifest: installMeta?.bundleManifest,
      });
      return c.json(result, 200);
    }
    eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: bundlePath, error: result.errors[0] ?? "failed" });
    writeInstallAudit({
      bundlePath, outcome: "failed",
      targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
      bundleManifest: installMeta?.bundleManifest,
    });
    const hasBlocked = result.stages.some((s: { status: string }) => s.status === "blocked");
    return c.json(result, hasBlocked ? 409 : 500);
  } catch (err) {
    bootstrapRepo.updateRunStatus(run.id, "failed");
    eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef: bundlePath, error: (err as Error).message });
    writeInstallAudit({
      bundlePath, outcome: "failed",
      targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
      bundleManifest: installMeta?.bundleManifest,
    });
    return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
  }
  } finally { bootstrapOrchestrator.release(bundlePath); }
});
