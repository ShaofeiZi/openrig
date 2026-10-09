// PL-007 工作区基元 v0 —— 共享的工作区类型标签组件。
//
// 为 5 种带类型的工作区之一渲染一枚小型徽章：
// user / project / knowledge / lab / delivery。在 文件、进度、切片、规格、
// 驾驶舱等界面中复用，让使用者一眼就能看出"这是哪一类工作区"。
//
// 视觉：小号大写等宽标签，每种类型一个区分色。尺寸按密集列表设计；
// `compact` 属性在空间紧张的行里收缩为单个字符字形。

export type WorkspaceKindLabel = "user" | "project" | "knowledge" | "lab" | "delivery";

const KIND_META: Record<WorkspaceKindLabel, { label: string; glyph: string; bg: string; fg: string; border: string }> = {
  user:      { label: "用户",     glyph: "U", bg: "bg-violet-50",  fg: "text-violet-700",  border: "border-violet-200" },
  project:   { label: "项目",     glyph: "P", bg: "bg-blue-50",    fg: "text-blue-700",    border: "border-blue-200" },
  knowledge: { label: "知识",     glyph: "K", bg: "bg-emerald-50", fg: "text-emerald-700", border: "border-emerald-200" },
  lab:       { label: "实验室",   glyph: "L", bg: "bg-amber-50",   fg: "text-amber-700",   border: "border-amber-200" },
  delivery:  { label: "交付",     glyph: "D", bg: "bg-rose-50",    fg: "text-rose-700",    border: "border-rose-200" },
};

interface Props {
  kind: WorkspaceKindLabel;
  compact?: boolean;
  className?: string;
}

export function WorkspaceKindBadge({ kind, compact, className }: Props) {
  const meta = KIND_META[kind];
  if (!meta) return null;
  const base = `inline-block border ${meta.border} ${meta.bg} ${meta.fg} font-mono text-[8px] uppercase tracking-[0.14em] leading-none rounded-sm`;
  const sized = compact ? "px-1 py-[2px]" : "px-1.5 py-0.5";
  return (
    <span
      data-testid={`workspace-kind-badge-${kind}`}
      title={`工作区类型：${kind}`}
      className={`${base} ${sized} ${className ?? ""}`.trim()}
    >
      {compact ? meta.glyph : meta.label}
    </span>
  );
}

/** 针对给定绝对路径，依据带类型的工作区块解析其工作区类型。
 *  当无匹配时返回 null（路径不在任何已声明的 repo 或 knowledge_root 内）。
 *  最长前缀优先，与 daemon 侧 resolveNodeWorkspace 逻辑保持一致。 */
export function resolveKindForPath(
  absolutePath: string | null | undefined,
  workspace: {
    repos: Array<{ name: string; path: string; kind: WorkspaceKindLabel }>;
    knowledgeRoot: string | null;
  } | null | undefined,
): WorkspaceKindLabel | null {
  if (!absolutePath || !workspace) return null;
  let best: { kind: WorkspaceKindLabel; len: number } | null = null;
  for (const r of workspace.repos) {
    if (isInsideOrEq(absolutePath, r.path) && r.path.length > (best?.len ?? -1)) {
      best = { kind: r.kind, len: r.path.length };
    }
  }
  if (best) return best.kind;
  if (workspace.knowledgeRoot && isInsideOrEq(absolutePath, workspace.knowledgeRoot)) {
    return "knowledge";
  }
  return null;
}

function isInsideOrEq(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
