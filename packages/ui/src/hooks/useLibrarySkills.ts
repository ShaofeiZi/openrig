// Slice 28 检查点 C-4——useLibrarySkills 使用 /api/skills/library。
//
// C4 之前，此钩子会按每个白名单根目录 × 每个候选路径扇出探测（N×3 次 fetch），并在
// 客户端递归遍历嵌套类别目录。slice 28 C-2 的 QA 裁决
//（qitem-20260513045711-39ccfdf3）证明：当操作员白名单不含后台服务源码树时，该方案会失败。
//
// 由后台服务拥有的发现逻辑（SkillLibraryDiscoveryService，累计覆盖 SC-29 EXCEPTION #11）
// 是唯一事实源：共享技能通过后台服务安装路径解析，工作区技能通过后台服务 filesAllowlist 解析。

import { useQuery } from "@tanstack/react-query";

export type LibrarySkillSource = "workspace" | "openrig-managed";

export interface LibrarySkillFile {
  /** 仅文件名，不含路径前缀。 */
  name: string;
  /** 相对于技能文件夹根目录的路径，如 "SKILL.md" 或 "examples/basic.md"。 */
  path: string;
  size: number;
  mtime: string;
}

export interface LibrarySkillEntry {
  /** 稳定 id，包含来源和来源树内的相对路径，例如
   *  "openrig-managed:core/openrig-user" 或 "workspace:<root-name>:skill-name"。 */
  id: string;
  /** 叶级技能文件夹名。 */
  name: string;
  source: LibrarySkillSource;
  /** 技能文件夹顶层的 Markdown 文件。 */
  files: LibrarySkillFile[];
  /** Slice 29 HG-4——后台服务读取此技能时使用的绝对文件系统路径。操作员可在技能详情页
   *  查看该路径，以了解每个随附技能实际位于磁盘何处（后台服务 bundle/插件/用户工作区）。 */
  absolutePath: string;
}

async function fetchLibrarySkills(): Promise<LibrarySkillEntry[]> {
  const res = await fetch("/api/skills/library");
  if (res.status === 503) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LibrarySkillEntry[];
}

export function useLibrarySkills() {
  return useQuery({
    queryKey: ["skills", "library"],
    queryFn: fetchLibrarySkills,
    staleTime: 30_000,
  });
}
