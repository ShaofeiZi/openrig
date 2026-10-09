/**
 * Bundle skill router（第 6 项 / slice-05 Checkpoint 7.2）。
 *
 * 纯函数。将 bundle manifest 的 skills[] block 中声明的 skill file，从 bundle 解压目录树复制到
 * 用户 skill library。没有 daemon dependency——可通过 FsOps 注入完整执行单元测试。
 *
 * 安全性：每个已声明 skill path 都视为不可信 manifest content；helper 会拒绝逃逸 bundle tree 的
 * path（path containment check 镜像 bundle-source-resolver pattern）。output target directory
 * 通过 mkdirp 创建。
 *
 * 诚实限定 scope：缺失 source file 会在结果中呈现为 warning（不抛错），使 install lifecycle
 * 能继续处理可用内容。skill library 缺失时同理：由 caller 决定 skip 或 fail。
 *
 * /install handler 集成在 Checkpoint 7.3 落地。
 */

import nodePath from "node:path";

/** Filesystem 注入点——真实实现封装 node:fs；测试替换为内存实现。 */
export interface SkillsRouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
}

/** routeSkills 的输入。 */
export interface RouteSkillsInput {
  /** bundle 解压根目录的绝对路径（unpack 创建的临时目录）。 */
  bundleRoot: string;
  /** manifest skills[] block 中声明的相对 skill path。 */
  declaredSkills: string[];
  /** 用户 skill library 的绝对路径（默认 ~/.openrig/skills）。 */
  targetSkillsDir: string;
  /** 可选 package-layout prefix，仅从 destination path 中移除。source path 始终保持
   *  bundle 声明的精确路径。 */
  targetPrefixToStrip?: string;
}

/** 一个已路由 skill（或一项拒绝）。 */
export interface RoutedSkillRecord {
  /** manifest.skills[] 中声明的路径。 */
  declaredPath: string;
  /** "routed" = 复制成功；"missing" = source 不在 bundle 中；"unsafe" = 逃逸 bundle
   * workspace；"no_library" = target dir 不存在且 caller 未要求创建（为未来
   * library-reachability mode 保留）。 */
  status: "routed" | "missing" | "unsafe";
  /** 路由成功时 skill 在 target library 中的落点（绝对路径）。 */
  installedAt?: string;
  /** 人类可读详情（供 caller 构造三段式 error shape）。 */
  detail?: string;
}

/** 聚合 routing result。 */
export interface RouteSkillsResult {
  records: RoutedSkillRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * 将每个已声明 skill 从 bundle tree 路由到用户 skill library。逐 skill 安全性：resolved source
 * path 必须位于 bundleRoot 内；若 bundle 中缺失则跳过。caller 使用此处返回的 record 写入
 * install audit record（第 4 项 chain）。
 */
export function routeSkills(input: RouteSkillsInput, fs: SkillsRouterFsOps): RouteSkillsResult {
  const records: RoutedSkillRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetSkillsDir);
  fs.mkdirp(input.targetSkillsDir);

  for (const declared of input.declaredSkills) {
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // 对 source 做纵深 path-containment 防御（镜像 bundle-source-resolver pattern；manifest
    // validator 已通过 isRelativeSafePath 拒绝不安全 path，但此处重新检查以防 input 绕过上游校验）。
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `skill path '${declared}' 逃逸 bundle workspace；已拒绝`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `bundle 中不存在 skill source '${declared}'；已跳过`,
      });
      continue;
    }
    // target path 在 target skill directory 下镜像声明路径。用户 skill library 继承 bundle
    // 中已声明 skill 的目录布局（例如 skills/foo/SKILL.md → <target>/foo/SKILL.md）；若存在
    // 前导 "skills/" prefix，则将其移除，使 target dir 成为用户 skill tree 的根。
    const declaredTrimmed = input.targetPrefixToStrip && declared.startsWith(input.targetPrefixToStrip)
      ? declared.slice(input.targetPrefixToStrip.length)
      : declared.startsWith("skills/")
        ? declared.slice("skills/".length)
        : declared;
    const targetAbs = nodePath.resolve(input.targetSkillsDir, declaredTrimmed);
    // 对 target 做纵深 path-containment 防御（qitem-20260518215234-f84fff45 的 B1 修复）。
    // 移除前导 "skills/" 可能提升一个在 bundleRoot 下看似安全的 relative segment（例如
    // "skills/../outside/SKILL.md" 会通过 source-containment，因为 bundle tree 可能包含
    // "outside/SKILL.md"），但移除后得到的 "../outside/SKILL.md" 会逃逸 targetSkillsDir。
    // 若 target 解析到 target library 外，则拒绝。已沉淀教训：
    // feedback_pre_existing_trust_boundary_reuse_canonical_helper——处理不可信 path input 时，
    // 必须同时约束 source 与 target。
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `'${declared}' 的 skill target path 逃逸 target skill library；已拒绝`,
      });
      continue;
    }
    fs.mkdirp(nodePath.dirname(targetAbs));
    const content = fs.readFile(sourceAbs);
    fs.writeFile(targetAbs, content);
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
