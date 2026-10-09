export type ToolBrandId =
  | "cmux"
  | "tmux"
  | "vscode"
  | "terminal"
  | "file"
  | "markdown"
  | "config"
  | "code"
  | "screenshot"
  | "proof"
  | "transcript"
  | "commit"
  | "folder"
  | "skill"
  | "video"
  | "trace"
  | "unknown";

export interface ToolBrand {
  id: ToolBrandId;
  label: string;
  shortLabel: string;
  actionLabel: string;
  tone: "cyan" | "green" | "blue" | "amber" | "slate" | "neutral";
}

const TOOL_BRANDS: Record<ToolBrandId, ToolBrand> = {
  cmux: {
    id: "cmux",
    label: "CMUX",
    shortLabel: "CMUX",
    actionLabel: "在 CMUX 中打开",
    tone: "cyan",
  },
  tmux: {
    id: "tmux",
    label: "tmux",
    shortLabel: "tmux",
    actionLabel: "接入 tmux",
    tone: "green",
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    shortLabel: "VS Code",
    actionLabel: "在 VS Code 中打开",
    tone: "blue",
  },
  terminal: {
    id: "terminal",
    label: "终端",
    shortLabel: "TTY",
    actionLabel: "预览终端",
    tone: "slate",
  },
  file: {
    id: "file",
    label: "文件",
    shortLabel: "文件",
    actionLabel: "打开文件",
    tone: "neutral",
  },
  markdown: {
    id: "markdown",
    label: "Markdown",
    shortLabel: "MD",
    actionLabel: "打开 Markdown",
    tone: "neutral",
  },
  config: {
    id: "config",
    label: "配置",
    shortLabel: "YAML",
    actionLabel: "打开配置",
    tone: "blue",
  },
  code: {
    id: "code",
    label: "代码",
    shortLabel: "代码",
    actionLabel: "打开代码",
    tone: "slate",
  },
  screenshot: {
    id: "screenshot",
    label: "截图",
    shortLabel: "截图",
    actionLabel: "打开截图",
    tone: "amber",
  },
  proof: {
    id: "proof",
    label: "校验包",
    shortLabel: "校验",
    actionLabel: "打开校验包",
    tone: "green",
  },
  transcript: {
    id: "transcript",
    label: "转录",
    shortLabel: "日志",
    actionLabel: "打开转录",
    tone: "slate",
  },
  commit: {
    id: "commit",
    label: "提交",
    shortLabel: "Git",
    actionLabel: "打开提交",
    tone: "green",
  },
  folder: {
    id: "folder",
    label: "文件夹",
    shortLabel: "目录",
    actionLabel: "打开文件夹",
    tone: "neutral",
  },
  skill: {
    id: "skill",
    label: "技能",
    shortLabel: "技能",
    actionLabel: "打开技能",
    tone: "amber",
  },
  video: {
    id: "video",
    label: "视频",
    shortLabel: "视频",
    actionLabel: "打开视频",
    tone: "blue",
  },
  trace: {
    id: "trace",
    label: "追踪",
    shortLabel: "追踪",
    actionLabel: "打开追踪",
    tone: "neutral",
  },
  unknown: {
    id: "unknown",
    label: "未知工具",
    shortLabel: "未知",
    actionLabel: "打开",
    tone: "neutral",
  },
};

export function normalizeToolBrandId(tool: string | null | undefined): ToolBrandId {
  const normalized = tool?.toLowerCase().trim() ?? "";
  if (normalized === "cmux" || normalized.includes("cmux")) return "cmux";
  if (normalized === "tmux" || normalized.includes("tmux")) return "tmux";
  if (
    normalized === "vscode" ||
    normalized === "vs-code" ||
    normalized === "vs code" ||
    normalized.includes("visual studio code")
  ) return "vscode";
  if (normalized === "terminal" || normalized === "tty" || normalized === "shell") return "terminal";
  if (
    normalized === "screenshot" ||
    normalized === "image" ||
    normalized === "proof-image" ||
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".svg") ||
    normalized.includes("screenshot")
  ) return "screenshot";
  if (
    normalized === "proof" ||
    normalized === "proof-packet" ||
    normalized.includes("proof packet") ||
    normalized.endsWith("proof.md")
  ) return "proof";
  if (
    normalized === "skill" ||
    normalized === "skill-folder" ||
    normalized === "skill.md" ||
    normalized.endsWith("/skill.md")
  ) return "skill";
  if (
    normalized === "folder" ||
    normalized === "directory" ||
    normalized === "dir"
  ) return "folder";
  if (
    normalized === "commit" ||
    normalized === "git" ||
    normalized.includes("commit") ||
    /^[a-f0-9]{7,40}$/.test(normalized)
  ) return "commit";
  if (
    normalized === "transcript" ||
    normalized.includes("transcript") ||
    normalized.endsWith(".log")
  ) return "transcript";
  if (
    normalized === "video" ||
    normalized.endsWith(".mp4") ||
    normalized.endsWith(".webm") ||
    normalized.endsWith(".mov")
  ) return "video";
  if (
    normalized === "trace" ||
    normalized.endsWith(".zip") ||
    normalized.endsWith(".har") ||
    normalized.endsWith(".trace")
  ) return "trace";
  if (
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  ) return "markdown";
  if (
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".jsonl") ||
    normalized.endsWith(".toml")
  ) return "config";
  if (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".jsx") ||
    normalized.endsWith(".py") ||
    normalized.endsWith(".rs") ||
    normalized.endsWith(".go") ||
    normalized.endsWith(".sh")
  ) return "code";
  if (
    normalized === "file" ||
    normalized === "path" ||
    normalized.includes("artifact") ||
    normalized.endsWith(".txt")
  ) return "file";
  return "unknown";
}

export function toolBrand(tool: string | null | undefined): ToolBrand {
  return TOOL_BRANDS[normalizeToolBrandId(tool)];
}
