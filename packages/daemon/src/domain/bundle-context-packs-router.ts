/**
 * Bundle context_packs 路由器（Item 6 / slice-05 Checkpoint 7.3f 第 2 步）。
 *
 * 纯函数。将 bundle 清单 context_packs[] 块中声明的 context-pack 目录从 bundle
 * 解压目录树复制到操作员的 context-packs 库。不依赖后台服务，可通过 FsOps
 * 注入完整地进行单元测试。
 *
 * 根据 PRD Item 6 第 196 行：context_packs 条目是 bundle 内
 * context-pack 的 manifest.yaml 路径。PACK 是该 manifest.yaml 的父目录（依据
 * context-pack-types.ts:9-10 和 context-pack-library-service.ts:50-77：pack
 * 是直接包含 manifest.yaml 及其引用内容文件的目录）。路由器把这个父目录复制到
 * <targetContextPacksDir>/<basename(parentDir)>/，即实时消费者扫描的操作员主机规范布局。
 *
 * 已固化的退化输入自测纪律（扩展自
 * workflow_specs 的 basename 冲突与非 YAML 循环）：
 * 每次路由器提交在声称 routedCount 可信前，都通过实时消费者契约显式探测各类
 * 失败边界。context_packs 中消费者不可见的类别包括：
 *   - 声明路径的 basename 不是 "manifest.yaml" → 消费者永不扫描
 *     （它只在 pack 目录根查找 manifest.yaml）。status=
 *     not_manifest.
 *   - 两个声明路径的父目录 basename 冲突 → 第二个会静默覆盖第一个；
 *     status=conflict，先到者胜出。
 *   - bundle 中不存在源 pack 目录 → status=missing（如实跳过）。
 *   - 源路径逃逸 bundleRoot → status=unsafe。
 *   - lore 类或结构上属于内部的内容 → 复制前标记 status=lore_refused 或
 *     substance_refused。
 *
 * 双侧路径包含校验（已固化的
 * feedback_pre_existing_trust_boundary_reuse_canonical_helper 补充条款）：
 * 源端必须位于 bundleRoot 下，目标端必须位于 targetContextPacksDir 下
 * （目标由 basename 构造，结构上安全，但仍保留防御性检查）。
 *
 * /install 处理器集成在 Checkpoint 7.3f 第 3 步落地，并针对路由目录提供真实的
 * consumer-scan() 证明（对应
 * d81456dc 中 workflow_specs scanWorkflowSpecFolder 的可达性证明）。
 */

import nodePath from "node:path";
import { assertShippableSubstance } from "./agent-resolver.js";

/** 文件系统注入点——真实实现包装 node:fs，测试使用内存实现替代。 */
export interface ContextPacksRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  readFile: (path: string) => string;
  listFiles: (dirPath: string) => string[];
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** routeContextPacks 的输入。 */
export interface RouteContextPacksInput {
  /** bundle 解压根目录的绝对路径（unpack 产生的临时目录）。 */
  bundleRoot: string;
  /** bundle 清单 context_packs[] 块中声明的 context-pack manifest.yaml 相对路径。 */
  declaredContextPacks: string[];
  /** 操作员上下文库的绝对路径（依据 context-pack-types.ts:9-10，通常为
   * `<context.root>`；调用方也可路由到工作区本地的 `.openrig/context-packs`）。 */
  targetContextPacksDir: string;
}

/** 一个已路由的 context_pack（或一条拒绝记录）。 */
export interface RoutedContextPackRecord {
  /** 来自 manifest.context_packs[] 的声明路径。 */
  declaredPath: string;
  /** "routed" = pack 目录复制成功且消费者可见。
   * "missing" = bundle 中没有 pack 清单源文件（如实跳过）。
   * "unsafe" = 源路径逃逸 bundleRoot，或目标路径逃逸 targetContextPacksDir
   * （由 basename 构造时理论上不可能，保留作防御）。
   * "not_manifest" = 声明路径的 basename 不是 "manifest.yaml"；消费者
   * （context-pack-library-service.scan）在 pack 目录中扫描顶层 manifest.yaml，
   * 其他 basename 在结构上不可见。
   * "not_directory" = 声明的清单路径之父项不是 bundle 目录树中的目录。
   * "conflict" = 父目录 basename 与较早路由的 pack 冲突；先到者胜出，后到者
   * 被标记，使 routedCount 在消费者可见边界保持真实（已固化的 16ebb8af 经验）。
   * "lore_refused" = pack 声明 taxonomy: lore。
   * "substance_refused" = pack 含有结构上的内部内容。两类拒绝都发生在复制前。 */
  status: "routed" | "missing" | "unsafe" | "not_manifest" | "not_directory" | "conflict" | "lore_refused" | "substance_refused";
  /** 路由成功时 pack 在目标库中的落点（pack 目录绝对路径）。 */
  installedAt?: string;
  /** 人类可读详情（供调用方构造三段式错误）。 */
  detail?: string;
}

/** 聚合路由结果。 */
export interface RouteContextPacksResult {
  records: RoutedContextPackRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * 将每个声明的 context_pack 从 bundle 目录树路由到操作员的 context-packs 库。
 * 每条记录均校验安全边界：源必须包含在 bundleRoot 中，目标必须包含在
 * targetContextPacksDir 中。消费者会忽略的退化输入（非 manifest.yaml basename、
 * 父目录 basename 冲突）在写入前即被捕获，使 routedCount 在消费者可见边界保持
 * 真实。调用方使用这里返回的记录写入安装审计。
 */
export function routeContextPacks(
  input: RouteContextPacksInput,
  fs: ContextPacksRouterFsOps,
): RouteContextPacksResult {
  const records: RoutedContextPackRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetContextPacksDir);
  fs.mkdirp(input.targetContextPacksDir);
  // 记录已路由的父目录 basename，使冲突显式成为 conflict 记录，而不是静默覆盖
  // （已固化的 workflow_specs 经验 16ebb8af）。
  const routedDirNames = new Set<string>();

  for (const declared of input.declaredContextPacks) {
    // 消费者可见性预筛：context-pack-library-service 只扫描直接包含 manifest.yaml
    // 的 pack 目录。basename 不是 "manifest.yaml" 的声明路径会被路由到消费者永远
    // 无法识别为 pack 的目录，因此在写入前拒绝，确保 routedCount 在消费者可见
    // 边界保持真实。
    if (nodePath.basename(declared) !== "manifest.yaml") {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `context_pack“${declared}”的 basename 不是“manifest.yaml”；context-pack-library 只扫描含顶层 manifest.yaml 的 pack 目录`,
      });
      continue;
    }
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // 对源路径执行纵深防御式包含校验（与 skills/workflow_specs 路由器一致）。
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `context_pack 路径“${declared}”逃逸 bundle 工作区，已拒绝`,
      });
      continue;
    }
    // 清单文件存在性检查（a0e7e0e1 guard 捕获后固化的 B1）：消费者
    // （context-pack-library-service.scan 第 76 行）会跳过缺少 manifest.yaml 的
    // pack 目录。若只存在父目录而清单缺失，pack 会以 status=routed 路由却对消费者
    // 不可见，形成 routedCount 假阳性。因此必须检查文件本身而不只是父目录。
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `bundle 中不存在 context_pack 清单“${declared}”，已跳过（消费者要求文件本身存在）`,
      });
      continue;
    }
    // 清单类型检查（d491eca9 guard 捕获后固化的 B2）：exists() 对文件和目录都会
    // 返回 true。若 sourceAbs 是名为 manifest.yaml 的目录而非文件，实时消费者的
    // readFileSync(manifestPath) 会抛出异常，scan() 只记录错误诊断，不会索引可见
    // pack，造成 routedCount 假阳性。因此在写入前拒绝。
    if (fs.isDirectory(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `context_pack 清单“${declared}”存在但它是目录而非文件；消费者要求 manifest.yaml 是可读文件`,
      });
      continue;
    }
    const sourcePackDir = nodePath.dirname(sourceAbs);
    if (!fs.isDirectory(sourcePackDir)) {
      records.push({
        declaredPath: declared,
        status: "not_directory",
        detail: `context_pack“${declared}”的父项不是目录，已跳过`,
      });
      continue;
    }
    try {
      assertShippableSubstance(fs.listFiles(sourcePackDir).map((relativePath) => ({
        path: nodePath.join(nodePath.dirname(declared), relativePath),
        bytes: fs.readFile(nodePath.join(sourcePackDir, relativePath)),
      })));
    } catch (error) {
      const detail = (error as Error).message;
      records.push({
        declaredPath: declared,
        status: /lore-class/.test(detail) ? "lore_refused" : "substance_refused",
        detail,
      });
      continue;
    }
    const dirName = nodePath.basename(sourcePackDir);
    // 目标 = <targetContextPacksDir>/<basename(parentDir)>/（依据
    // context-pack-types.ts:9-10，这是操作员主机上的规范布局）。
    const targetAbs = nodePath.resolve(input.targetContextPacksDir, dirName);
    // 健全性检查（basename 在结构上安全，但 resolve 理论上可能对空字符串不产生
    // 变化，因此保留此检查；正常情况下应始终通过）。
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `context_pack“${declared}”的目标路径逃逸目标 context-packs 库，已拒绝`,
      });
      continue;
    }
    if (routedDirNames.has(dirName)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `context_pack 父目录 basename“${dirName}”与较早声明的路径冲突；仅路由第一个（已固化的冲突检测经验）`,
      });
      continue;
    }
    fs.copyDir(sourcePackDir, targetAbs);
    routedDirNames.add(dirName);
    records.push({
      declaredPath: declared,
      status: "routed",
      installedAt: targetAbs,
    });
  }

  const routedCount = records.filter((r) => r.status === "routed").length;
  const rejectedCount = records.length - routedCount;
  return { records, routedCount, rejectedCount };
}
