/**
 * Bundle agent_images 路由器（Item 6 / slice-05 Checkpoint 7.3g step 2）。
 *
 * 纯函数。把 bundle manifest 的 agent_images[] 块声明的 agent-image 目录，
 * 从 bundle 解压树复制到操作员的 agent-images 库。不依赖后台服务，
 * 可通过注入 FsOps 完整地进行单元测试。
 *
 * 根据 PRD §Item 6 第 197 行，agent_images 条目是 agent-image 目录路径
 *（不是 manifest 路径；按 e7a0b253 的 PRD 一致性修复，它与 context_packs 结构不同）。
 * 路由器把声明目录复制到 <targetAgentImagesDir>/<basename(sourceAbs)>/，
 * 即 agent-image-types.ts:9-10 定义的操作员主机规范布局。
 *
 * 消费方契约（agent-image-library-service.ts:77-95）：消费方遍历根目录，其直接子项必须是镜像目录；
 * 每个镜像目录还必须包含 manifest.yaml 文件。路由器在复制时强制这些消费方可见性不变量，
 * 使 routedCount 在消费方可见边界保持真实。
 *
 * context_packs 周期积累的四项路由器级防护
 *（d491eca9 + 3cd581e3 + 16ebb8af + a0e7e0e1）同样适用，并从首次提交即内置：
 *   1. 源路径约束（与所有同级路由器一致）
 *   2. sourceAbs 存在且 isDirectory（声明路径就是镜像目录）
 *   3. 内部的 manifest.yaml 必须以文件形式存在（消费方要求可读的 manifest.yaml；
 *      同时拒绝 manifest 缺失和 manifest 是目录两种情况，即区分文件与目录）
 *   4. basename(sourceAbs) 冲突检测（第一个胜出，第二个标记 status=conflict）
 *
 * /install handler 集成在 Checkpoint 7.3g step 3 落地，并对路由后的目录执行真实
 * consumer-scan() 证明（对应 cb0bf7b9 context_packs 的
 * ContextPackLibraryService.scan 可达性证明）。
 */

import nodePath from "node:path";

/** 文件系统注入点：真实实现封装 node:fs，测试使用内存替代实现。 */
export interface AgentImagesRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** routeAgentImages 的输入。 */
export interface RouteAgentImagesInput {
  /** bundle 解压根目录的绝对路径（解包产生的临时目录）。 */
  bundleRoot: string;
  /** bundle manifest 的 agent_images[] 块声明的 agent-image 目录相对路径
   *（见 PRD §Item 6 第 197 行）。 */
  declaredAgentImages: string[];
  /** 操作员 agent-images 库的绝对路径（按 agent-image-types.ts:9-10，通常为
   * `<openrigHome>/agent-images/` 或工作区本地的 `.openrig/agent-images/`）。由调用方解析。 */
  targetAgentImagesDir: string;
}

/** 一条已路由的 agent_image 记录（或一条拒绝记录）。 */
export interface RoutedAgentImageRecord {
  /** manifest.agent_images[] 中的声明路径。 */
  declaredPath: string;
  /** "routed" = 镜像目录复制成功且消费方可见。
   * "missing" = bundle 中不存在声明的镜像目录（如实跳过）。
   * "unsafe" = 源路径越出 bundleRoot，或目标路径越出 targetAgentImagesDir
   *（使用 basename 后结构上不可能发生，保留作纵深防御）。
   * "not_directory" = 声明路径存在，但不是目录。
   * "not_manifest" = 镜像目录存在，但内部缺少 manifest.yaml，或 manifest.yaml
   * 本身是目录；消费方要求镜像目录根部存在可读的 manifest.yaml 文件。
   * "conflict" = basename 与更早路由的镜像冲突；第一个胜出，第二个被标记，
   * 使 routedCount 在消费方可见边界保持真实（16ebb8af 的既有经验）。 */
  status: "routed" | "missing" | "unsafe" | "not_directory" | "not_manifest" | "conflict";
  /** 路由成功时，镜像在目标库中的落点（镜像目录绝对路径）。 */
  installedAt?: string;
  /** 人类可读详情（供调用方组成三段式错误）。 */
  detail?: string;
}

/** 汇总后的路由结果。 */
export interface RouteAgentImagesResult {
  records: RoutedAgentImageRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * 把每个声明的 agent_image 从 bundle 树路由到操作员的 agent-images 库。
 * 每条记录都检查：源路径位于 bundleRoot 下，且目标路径位于 targetAgentImagesDir 下。
 * 写入前强制消费方可见性不变量（声明目录确为目录，内部 manifest.yaml 确以文件存在），
 * 使 routedCount 在消费方可见边界保持真实。调用方使用这里返回的记录写入安装审计。
 */
export function routeAgentImages(
  input: RouteAgentImagesInput,
  fs: AgentImagesRouterFsOps,
): RouteAgentImagesResult {
  const records: RoutedAgentImageRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetAgentImagesDir);
  fs.mkdirp(input.targetAgentImagesDir);
  // 跟踪已路由的 basename，使冲突显式成为 conflict 记录，而不是静默覆盖
  //（沿用 workflow_specs 与 context_packs 的既有经验）。
  const routedDirNames = new Set<string>();

  for (const declared of input.declaredAgentImages) {
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // 对源路径执行纵深约束检查，与同级路由器保持一致。
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `agent_image path '${declared}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `agent_image dir '${declared}' not present in bundle; skipped`,
      });
      continue;
    }
    if (!fs.isDirectory(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "not_directory",
        detail: `agent_image '${declared}' exists but is not a directory; consumer requires the declared path to be an image dir`,
      });
      continue;
    }
    // 检查 manifest 文件是否存在（沿用 context_packs 的 d491eca9 经验）：
    // 消费方（agent-image-library-service.ts:93）会跳过缺少 manifest.yaml 的镜像目录，
    // 因此在写入前拒绝。
    const manifestPath = nodePath.join(sourceAbs, "manifest.yaml");
    if (!fs.exists(manifestPath)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `agent_image '${declared}' is missing manifest.yaml; consumer-invisible (agent-image-library scan requires it)`,
      });
      continue;
    }
    // 检查 manifest 类型（沿用 context_packs 的 3cd581e3 经验）：
    // exists() 对文件和目录都会返回 true。若 manifest.yaml 是目录，消费方的
    // readFileSync 会抛错，scan() 只记录错误诊断而不会索引镜像，因此拒绝。
    if (fs.isDirectory(manifestPath)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `agent_image '${declared}' has manifest.yaml as a directory, not a file; consumer requires a readable file`,
      });
      continue;
    }
    const dirName = nodePath.basename(sourceAbs);
    const targetAbs = nodePath.resolve(input.targetAgentImagesDir, dirName);
    // 健全性检查：basename 在结构上安全，但 resolve 对 "" 理论上可能无变化；
    // 因此保留此检查，预期始终通过。
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `agent_image target path for '${declared}' escapes target agent-images library; rejected`,
      });
      continue;
    }
    if (routedDirNames.has(dirName)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `agent_image basename '${dirName}' collides with an earlier declared path; only the first is routed (banked collision-detection lesson)`,
      });
      continue;
    }
    fs.copyDir(sourceAbs, targetAbs);
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
