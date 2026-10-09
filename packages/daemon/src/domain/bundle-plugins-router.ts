/**
 * Bundle 插件路由器（第 6 项 / slice-05 检查点 7.3c）。
 *
 * 纯函数。将 bundle 清单 plugins[] 块声明的插件树从已解包目录复制到操作员插件库
 *（按 ID 分子目录）。沿用 bundle-skills-router 模式：注入 FsOps；对信任边界两侧
 * 都执行路径包含检查（已记录的
 * feedback_pre_existing_trust_boundary_reuse_canonical_helper 补充说明：
 * feedback_pre_existing_trust_boundary_reuse_canonical_helper 补充要求：处理不受信任
 * 路径输入时，同时约束来源与目标）；来源缺失呈现 status=missing，不安全路径以
 * status=unsafe 拒绝。
 *
 * 按 orch 批准的 HYBRID 决策：v0 的 source.kind 只支持 local，即 bundle 解包树下的路径。
 * 其他类别（操作员主机外部路径、远程获取）留待未来版本。
 *
 * /install 处理器集成在检查点 7.3d 落地。
 */

import nodePath from "node:path";

/** 文件系统注入点——真实实现封装 node:fs，测试使用内存实现替代。 */
export interface PluginsRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** bundle 清单中的插件引用，与后台服务的 BundlePluginReference 形状一致。 */
export interface PluginRoutingInput {
  id: string;
  source: { kind: "local"; path: string };
}

/** routePlugins 的输入。 */
export interface RoutePluginsInput {
  /** bundle 解包根目录的绝对路径（unpack 创建的临时目录）。 */
  bundleRoot: string;
  /** 清单声明的插件引用。 */
  declaredPlugins: PluginRoutingInput[];
  /** 操作员插件库的绝对路径（默认为 ~/.openrig/plugins）。 */
  targetPluginsDir: string;
}

/** 一个已路由插件（或一条拒绝记录）。 */
export interface RoutedPluginRecord {
  /** 来自 manifest.plugins[].id 的插件 ID。 */
  id: string;
  /** "routed" 表示目录已复制；"missing" 表示 bundle 中没有来源；"unsafe" 表示
   * 来源或目标越出其边界目录；"not_directory" 表示来源路径不是目录。 */
  status: "routed" | "missing" | "unsafe" | "not_directory";
  /** 路由成功时插件在目标库中的绝对落盘路径。 */
  installedAt?: string;
  /** 人类可读详情。 */
  detail?: string;
}

/** 聚合路由结果。 */
export interface RoutePluginsResult {
  records: RoutedPluginRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * 将每个已声明插件从 bundle 树路由到操作员插件库的 <targetPluginsDir>/<id>/。
 * 每个插件都同时检查来源路径（位于 bundleRoot 下）与目标路径
 *（位于 targetPluginsDir 下）的包含关系，落实信任边界两侧都需防护的经验。
 */
export function routePlugins(input: RoutePluginsInput, fs: PluginsRouterFsOps): RoutePluginsResult {
  const records: RoutedPluginRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetPluginsDir);
  fs.mkdirp(input.targetPluginsDir);

  for (const plugin of input.declaredPlugins) {
    if (!plugin.id || plugin.source.kind !== "local") {
      records.push({
        id: plugin.id || "(unknown)",
        status: "unsafe",
        detail: `插件引用无效：必须提供 id，且 source.kind 必须为 'local'（其他类别留待未来版本）`,
      });
      continue;
    }
    // 来源包含检查：source.path 必须解析到 bundleRoot 内部。
    const sourceAbs = nodePath.resolve(input.bundleRoot, plugin.source.path);
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        id: plugin.id,
        status: "unsafe",
        detail: `插件来源路径 '${plugin.source.path}' 越出 bundle 工作区，已拒绝`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        id: plugin.id,
        status: "missing",
        detail: `bundle 中不存在插件来源 '${plugin.source.path}'，已跳过`,
      });
      continue;
    }
    if (!fs.isDirectory(sourceAbs)) {
      records.push({
        id: plugin.id,
        status: "not_directory",
        detail: `插件来源 '${plugin.source.path}' 不是目录，已跳过`,
      });
      continue;
    }
    // 目标包含检查：ID 生成的路径必须位于 targetPluginsDir 内部。
    const targetAbs = nodePath.resolve(input.targetPluginsDir, plugin.id);
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        id: plugin.id,
        status: "unsafe",
        detail: `插件 ID '${plugin.id}' 会解析到目标插件库外部，已拒绝`,
      });
      continue;
    }
    fs.copyDir(sourceAbs, targetAbs);
    records.push({
      id: plugin.id,
      status: "routed",
      installedAt: targetAbs,
    });
  }

  const routedCount = records.filter((r) => r.status === "routed").length;
  const rejectedCount = records.length - routedCount;
  return { records, routedCount, rejectedCount };
}
