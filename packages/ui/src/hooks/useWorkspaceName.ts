// V1 第三次尝试阶段 3 回修 A5——useWorkspaceName。
//
// 通过 useSettings 从 ConfigStore 读取已配置的工作区根目录，并返回其 basename 用于显示。
// 未设置时，或随附后台服务版本低于 v0.3.0、设置端点不可达时，返回 null，使消费者如实
// 渲染“未连接工作区”空状态。

import { useSettings } from "./useSettings.js";

export interface WorkspaceNameResult {
  /** 已配置工作区根目录的实时 basename；未设置或不可达时为 null。 */
  name: string | null;
  /** 已配置的完整根路径；未设置或不可达时为 null。 */
  root: string | null;
  /** 设置端点可达，即后台服务支持 /api/config。 */
  settingsAvailable: boolean;
  /** 初始设置请求仍在进行时为 true。 */
  isLoading: boolean;
}

function basename(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function useWorkspaceName(): WorkspaceNameResult {
  const { data, isLoading, error } = useSettings();

  if (error || !data || !data.settings || typeof data.settings !== "object") {
    return {
      name: null,
      root: null,
      settingsAvailable: false,
      isLoading,
    };
  }

  const resolved = data.settings["workspace.root"];
  const rawValue = resolved?.value;
  const root = typeof rawValue === "string" && rawValue.length > 0 ? rawValue : null;

  return {
    name: root ? basename(root) : null,
    root,
    settingsAvailable: true,
    isLoading,
  };
}
