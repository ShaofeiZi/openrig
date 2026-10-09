export type RuntimeBrandId = "claude-code" | "codex" | "pi" | "terminal" | "unknown";

export interface RuntimeBrand {
  id: RuntimeBrandId;
  label: string;
  shortLabel: string;
  tone: "sand" | "green" | "slate" | "neutral";
}

const RUNTIME_BRANDS: Record<RuntimeBrandId, RuntimeBrand> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude",
    shortLabel: "Claude",
    tone: "sand",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    tone: "green",
  },
  // OPR.0.4.6.PI1——Pi 编程智能体（earendil-works/pi），RPC 优先的运行时。
  pi: {
    id: "pi",
    label: "Pi",
    shortLabel: "Pi",
    tone: "slate",
  },
  terminal: {
    id: "terminal",
    label: "终端",
    shortLabel: "TTY",
    tone: "slate",
  },
  unknown: {
    id: "unknown",
    label: "未知",
    shortLabel: "未知",
    tone: "neutral",
  },
};

export function normalizeRuntimeBrandId(runtime: string | null | undefined): RuntimeBrandId {
  const normalized = runtime?.toLowerCase().trim() ?? "";
  if (normalized === "claude" || normalized === "claude-code" || normalized.includes("claude")) return "claude-code";
  if (normalized === "codex" || normalized.includes("codex") || normalized.includes("openai")) return "codex";
  // 仅精确/前缀匹配——绝不裸 includes("pi")（api/pilot/…）。
  if (normalized === "pi" || normalized.startsWith("pi-")) return "pi";
  if (normalized === "terminal" || normalized === "tmux" || normalized === "shell") return "terminal";
  return "unknown";
}

export function runtimeBrand(runtime: string | null | undefined): RuntimeBrand {
  return RUNTIME_BRANDS[normalizeRuntimeBrandId(runtime)];
}

export function formatRuntimeModel(runtime: string | null | undefined, model?: string | null): string {
  const brand = runtimeBrand(runtime);
  if (brand.id === "unknown") return model ?? "运行时未知";
  return model ? `${brand.label} / ${model}` : brand.label;
}
