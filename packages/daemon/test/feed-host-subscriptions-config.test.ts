// OPR.0.4.4.15（guard G15-P1 收敛）——唯一登记的动态 key 类：
// feed.subscriptions.<hostId>.enabled。这些测试固定完整契约：往返持久化、分隔符和保留段守卫
//（读取侧警告并忽略，写入侧响亮拒绝）、不匹配的未知 key 逐字节保持现有 400/抛错行为，
// 以及 CLI/后台服务双实现对等性（host-registry 双实现纪律：共享 fixture 经过两种实现）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsStore,
  parseFeedHostSubscriptionKey as daemonParse,
} from "../src/domain/user-settings/settings-store.js";
import { parseFeedHostSubscriptionKey as cliParse } from "../../cli/src/config-store.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-host-cfg-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function store(): SettingsStore {
  return new SettingsStore(configPath);
}

describe("dynamic feed-host subscription keys — daemon store", () => {
  it("set/resolve/list 可往返；reset 移除整个 host 节点", () => {
    const s = store();
    s.set("feed.subscriptions.vps-b.enabled", "true");
    s.set("feed.subscriptions.mac_mini2.enabled", "false");
    expect(s.resolveFeedHostSubscription("feed.subscriptions.vps-b.enabled")).toEqual({ value: true, source: "file", defaultValue: false });
    expect(s.resolveFeedHostSubscription("feed.subscriptions.never-set.enabled")).toEqual({ value: false, source: "default", defaultValue: false });
    expect(s.listFeedHostSubscriptions()).toEqual([
      { hostId: "vps-b", enabled: true },
      { hostId: "mac_mini2", enabled: false },
    ]);
    s.reset("feed.subscriptions.vps-b.enabled");
    expect(s.listFeedHostSubscriptions()).toEqual([{ hostId: "mac_mini2", enabled: false }]);
    // 文件布局嵌套在 feed.subscriptions.<hostId>.enabled 下。
    const fc = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, never>;
    expect(fc).toEqual({ feed: { subscriptions: { mac_mini2: { enabled: false } } } });
  });

  it("写入侧响亮拒绝非布尔值、保留段、带点 host id 及所有不匹配的未知 key（现有行为逐字节保留）", () => {
    const s = store();
    expect(() => s.set("feed.subscriptions.vps-b.enabled", "yes")).toThrow(/应为 "true" 或 "false"/);
    // 保留段绝不会解析为 host id，因此由扁平 key/未知路径处理。
    expect(() => s.set("feed.subscriptions.approvals.enabled", "true")).toThrow(/未知配置键/);
    expect(() => s.set("feed.subscriptions.auditLog.enabled", "true")).toThrow(/未知配置键/);
    // 带点的 host id 无法用点分 key 表达（分隔符场景）。
    expect(() => s.set("feed.subscriptions.vps.b.enabled", "true")).toThrow(/未知配置键/);
    // v1 中每个 host 的 key 集合封闭为 {enabled}。
    expect(() => s.set("feed.subscriptions.vps-b.altitude", "high")).toThrow(/未知配置键/);
    // 既有未知 key 反例保持不变。
    expect(() => s.set("totally.unknown.key", "x")).toThrow(/未知配置键/);
  });

  it("读取侧警告并忽略畸形持久节点，同时保留合法节点（已批准守卫）", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        feed: {
          subscriptions: {
            approvals: true, // flat toggle leaf — silently fine, not a host
            "vps-b": { enabled: true },
            auditLog: { enabled: true }, // reserved OBJECT node — warned + ignored
            "bad seg!": { enabled: true }, // invalid segment — warned + ignored
            "half-baked": { enabled: "yes" }, // non-boolean — warned + ignored
          },
        },
      }),
    );
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as never);
    expect(store().listFeedHostSubscriptions()).toEqual([{ hostId: "vps-b", enabled: true }]);
    expect(warnings.join("")).toContain("auditLog");
    expect(warnings.join("")).toContain("bad seg!");
    expect(warnings.join("")).toContain("half-baked");
  });
});

describe("dynamic feed-host subscription keys — CLI/daemon twin parity", () => {
  const PARSE_FIXTURES: Array<{ key: string; hostId: string | null }> = [
    { key: "feed.subscriptions.vps-b.enabled", hostId: "vps-b" },
    { key: "feed.subscriptions.mac_mini2.enabled", hostId: "mac_mini2" },
    { key: "feed.subscriptions.approvals.enabled", hostId: null }, // reserved (key-level)
    { key: "feed.subscriptions.auditLog.enabled", hostId: null }, // reserved (file-level)
    { key: "feed.subscriptions.enabled.enabled", hostId: null }, // reserved
    { key: "feed.subscriptions.vps.b.enabled", hostId: null }, // delimiter
    { key: "feed.subscriptions.vps-b.altitude", hostId: null }, // closed per-host set
    { key: "feed.subscriptions..enabled", hostId: null }, // empty segment
    { key: "workspace.root", hostId: null }, // unrelated key
  ];

  it("两个解析器对每个 fixture 结果一致（出现差异即说明一侧漂移）", () => {
    for (const f of PARSE_FIXTURES) {
      const d = daemonParse(f.key);
      const c = cliParse(f.key);
      expect(d?.hostId ?? null).toBe(f.hostId);
      expect(c?.hostId ?? null).toBe(f.hostId);
    }
  });
});
