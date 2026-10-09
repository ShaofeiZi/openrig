// V1 attempt-3 Phase 5 P5-5 —— 基于文件系统的 Project 树任务发现。
//
// 通过既有 /api/files/list 后台服务路由遍历 `<workspace.root>/missions/`
// （依 SC-29 不新增后台服务端点）。返回任务目录列表，ProjectTreeView 据此把它们渲染为树节点，
// 与 railItem 分组的切片兜底并列（或取而代之）。依 project-tree.md L13–L46，Project 树形状为
// workspace > mission > slice；规范任务单元是 workspace.root/missions/ 下的一个目录。
//
// 解析链：
//   1. useSettings → workspace.root（绝对路径）
//   2. useFilesRoots → (name, path) 白名单根列表
//   3. 找一个 `path` 是 workspace.root 前缀的白名单根
//      （首选精确相等；“工作区根”是典型注册场景）
//   4. 计算从根出发的相对路径 → workspace.root/missions
//   5. useFilesList(rootName, relPath) → 任务目录条目
//
// 当没有合适根被注册（操作者未把 workspace.root 加入
// OPENRIG_FILES_ALLOWLIST）时返回 { unavailable: true }，使 UI 能退化为旧 railItem
// 分组的切片列表而不崩溃。

import { useFilesRoots, useFilesList } from "./useFiles.js";
import { useWorkspaceName } from "./useWorkspaceName.js";

export interface DiscoveredMission {
  /** 任务目录名（例如 "release-0-3-0"）。 */
  name: string;
  /** 供 /api/files/* 端点使用的白名单根名。 */
  root: string;
  /** 本任务目录在根下的路径（例如 "missions/foo"）。 */
  path: string;
}

export interface UseMissionDiscoveryResult {
  missions: DiscoveredMission[];
  /** 白名单中没有任何根包含 workspace.root 时为真。 */
  unavailable: boolean;
  /** 任一底层查询进行中时为真。 */
  isLoading: boolean;
  /** 不可用时空态的提示文案。 */
  hint: string | null;
}

/** 当 `parent` 是 `child` 的路径前缀（二者视为绝对文件系统路径）时返回 true。容忍尾部斜杠；
 *  强制段边界（因此 "/work" 不是 "/workspace" 的前缀）。 */
function isPathPrefix(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/** 计算根内的相对路径：child = "<root>/<rel>" → "<rel>"。 */
function relativeUnder(rootPath: string, absChild: string): string {
  const p = rootPath.replace(/\/+$/, "");
  const c = absChild.replace(/\/+$/, "");
  if (c === p) return "";
  if (c.startsWith(p + "/")) return c.slice(p.length + 1);
  return c;
}

export function useMissionDiscovery(opts?: { enabled?: boolean }): UseMissionDiscoveryResult {
  // OPR.0.4.6.MH2 guard-B1 —— 发现遍历本地文件系统
  // （/api/files/roots + /api/files/list）。远程主机选择下调用方传 enabled:false、
  // 不发任何文件请求（事后的结果包装不是门控——否则 hooks 早已抓取）。
  const enabled = opts?.enabled ?? true;
  const workspace = useWorkspaceName();
  const rootsQuery = useFilesRoots({ enabled });
  const rootsResp = enabled ? rootsQuery.data : undefined;

  // 解析：为 workspace.root 选最佳匹配根（若有）。
  let chosenRoot: { name: string; path: string } | null = null;
  if (workspace.root && rootsResp && "roots" in rootsResp) {
    // 首选精确匹配。
    const exact = rootsResp.roots.find((r) => r.path === workspace.root);
    if (exact) {
      chosenRoot = exact;
    } else {
      // 否则选是 workspace.root 前缀的最深根
      // （处理把 ~/code 注册为根、workspace.root = ~/code/projects/openrig-work 的操作者）。
      const prefixed = rootsResp.roots
        .filter((r) => workspace.root && isPathPrefix(r.path, workspace.root))
        .sort((a, b) => b.path.length - a.path.length);
      const first = prefixed[0];
      if (first) chosenRoot = first;
    }
  }

  // 从所选根计算 missions/ 的相对路径。
  const missionsRelPath =
    chosenRoot && workspace.root
      ? (() => {
          const rel = relativeUnder(chosenRoot.path, workspace.root);
          return rel ? `${rel}/missions` : "missions";
        })()
      : null;

  const listQuery = useFilesList(
    chosenRoot ? chosenRoot.name : null,
    missionsRelPath,
  );

  // 已禁用（远程选择）：如实不可用，上面未发任何文件请求
  // （roots 禁用 ⇒ chosenRoot 为 null ⇒ list 禁用）。
  if (!enabled) {
    return {
      missions: [],
      unavailable: true,
      isLoading: false,
      hint: null,
    };
  }

  const isLoading =
    workspace.isLoading ||
    rootsQuery.isLoading ||
    (chosenRoot !== null && listQuery.isLoading);

  // 不可用情形：
  //   - 设置不可达（无 /api/config 的旧版 v0.2.0 后台服务）。
  //   - 未配置 workspace.root。
  //   - 无白名单根包含 workspace.root（操作者须注册）。
  if (!workspace.settingsAvailable && !workspace.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: "后台服务未暴露 /api/config（可能为 v0.2.0）。升级到 v0.3.0+ 以启用实时任务发现。",
    };
  }
  if (!workspace.root && !workspace.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: "请配置工作区根：zrig config set workspace.root <path>",
    };
  }
  if (!chosenRoot && !rootsQuery.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: `没有白名单根包含 workspace.root（${workspace.root}）。设置 OPENRIG_FILES_ALLOWLIST=<名称>:<路径> 以注册。`,
    };
  }

  // listQuery 可能进行中或出错；把错误视为不可用，使 UI 优雅兜底而不抛错。
  if (listQuery.isError) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: `无法在 ${chosenRoot?.name} 下列出 ${missionsRelPath}。`,
    };
  }

  const entries = listQuery.data?.entries ?? [];
  const missions: DiscoveredMission[] = entries
    .filter((e) => e.type === "dir")
    .map((e) => ({
      name: e.name,
      root: chosenRoot!.name,
      path: missionsRelPath ? `${missionsRelPath}/${e.name}` : e.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    missions,
    unavailable: false,
    isLoading,
    hint: null,
  };
}
