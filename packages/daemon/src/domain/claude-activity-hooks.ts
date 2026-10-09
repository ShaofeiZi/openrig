// 判断 zrig 管理的 Claude activity-relay hooks 是否可交付以及应注入哪些事件的唯一事实源。
// ClaudeCodeAdapter reconcile（控制启用）与 rigspec-preflight（发出警告）都会消费它——
// 共用一套校验和一个 manifest 解析器，避免两个接缝漂移。事件命令由适配器构造
//（绝对路径并完成 shell 引用）；本模块只负责判断可交付性和派生事件词汇。

/** 用于选择托管 Claude 活动 hooks 的已发布 runtime_resource `type`。 */
export const CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE = "claude_activity_hooks";

/** 最小读取接口；适配器和预检的文件系统操作均可满足。 */
export interface ActivityHookFsRead {
  exists(path: string): boolean;
  readFile(path: string): string;
}

export interface ActivityRelayEvent {
  event: string;
  timeout?: number;
}

export interface ActivityHookDelivery {
  /** 中继资源源文件存在。 */
  relaySourceOk: boolean;
  /** 从规范 claude.json manifest 派生的中继事件（不含压缩事件）。 */
  events: ActivityRelayEvent[];
  /** 可交付启用：中继源存在，且至少派生出一个中继事件。 */
  deliverable: boolean;
}

/**
 * 校验交付输入：中继源存在，且规范 manifest 能生成非空中继事件集合。这是唯一门禁——
 * 适配器（执行任何剥离、复制或写入前）和预检（用于警告）都会用相同资源路径调用它。
 */
export function validateClaudeActivityHookDelivery(
  fs: ActivityHookFsRead,
  relayPath: string | null | undefined,
  manifestPath: string | null | undefined,
): ActivityHookDelivery {
  const relaySourceOk = !!relayPath && fs.exists(relayPath);
  const events = deriveRelayEvents(fs, manifestPath);
  return { relaySourceOk, events, deliverable: relaySourceOk && events.length > 0 };
}

/**
 * 从规范 claude.json manifest 派生中继事件词汇：选择其分组会调用 activity-relay.cjs 的
 * 事件（排除 compaction/bridge 分组），并携带每个事件声明的 timeout。manifest 缺失、
 * 不可读、不是对象或没有中继支持的事件时返回空数组。
 */
export function deriveRelayEvents(fs: ActivityHookFsRead, manifestPath: string | null | undefined): ActivityRelayEvent[] {
  if (!manifestPath || !fs.exists(manifestPath)) return [];
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFile(manifestPath)); } catch { return []; }
  const hooks = isPlainObject(manifest) && isPlainObject(manifest["hooks"]) ? (manifest["hooks"] as Record<string, unknown>) : {};
  const out: ActivityRelayEvent[] = [];
  const seen = new Set<string>();
  for (const [event, groups] of Object.entries(hooks)) {
    if (seen.has(event) || !Array.isArray(groups)) continue;
    for (const group of groups as unknown[]) {
      if (!isPlainObject(group) || !Array.isArray(group["hooks"])) continue;
      const relay = (group["hooks"] as unknown[]).find((h) => {
        const c = isPlainObject(h) && typeof h["command"] === "string" ? (h["command"] as string) : "";
        return c.includes("activity-relay.cjs");
      });
      if (relay) {
        const t = isPlainObject(relay) ? relay["timeout"] : undefined;
        out.push({ event, timeout: typeof t === "number" ? t : undefined });
        seen.add(event);
        break;
      }
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
