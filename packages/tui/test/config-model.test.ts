import { describe, expect, it } from "vitest";
import { CONFIG_CATEGORIES, configCategory, configEntries, configDetailLines, configListLines,
  configValue, configSourceLines, type ConfigRead, type ConfigEntry } from "../src/config/config-model.js";
import { SETTINGS_VALID_KEYS } from "../../daemon/src/domain/user-settings/settings-store.js";
import { strWidth } from "../src/text-width.js";
const entry = (key: string, overrides: Partial<ConfigEntry> = {}): ConfigEntry => ({
  key, group: "general", value: true, defaultValue: false, source: "file", visibility: "shown",
  reason: null, scope: "Displayed daemon instance", application: "Running application unverified.", ...overrides,
});
const makeRead = (entries: ConfigEntry[]): ConfigRead => ({ observedAt: "2026-09-09T00:00:00Z", home: "/fixture",
  sources: [{ id: "general", state: "available", path: "/fixture/config.json", detail: "Environment > file > default." }],
  entries, exclusions: ["Credentials withheld."], readOnly: true });

describe("CONFIG 呈现核心（共享导航尚未接入）", () => {
  it("保持所有运行时 key 分类或可发现，并可搜索标签与精确 key", () => {
    const read = makeRead([...SETTINGS_VALID_KEYS.map((key) => entry(key)), entry("future.owner_setting"),
      entry("slack.enabled", { group: "slack" }), entry("hosts.0.transport", { group: "hosts" }),
      entry("health.policy.diagnosis.enabled", { group: "health" })]);
    expect(read.entries.every((e) => CONFIG_CATEGORIES.some((c) => c.id === configCategory(e)))).toBe(true);
    expect(configEntries(read, "all")).toHaveLength(read.entries.length);
    expect(configEntries(read, "all", "retry interval").map((e) => e.key)).toEqual(["queue.wake_retry_interval_seconds"]);
    expect(configEntries(read, "all", "future.owner_setting")).toHaveLength(1);
    expect(configEntries(read, "slack").map((e) => e.key)).toEqual(["slack.enabled"]);
    expect(configEntries(read, "context").some((e) => e.group === "health")).toBe(true);
    expect(configEntries(read, "instance").some((e) => e.group === "hosts")).toBe(true);
  });
  it.each([54, 88])("fits a %i-column content pane while retaining full long detail", (width) => {
    const path = "/fixture/" + "long-folder/".repeat(18) + "tail";
    const read = makeRead([entry("workspace.root", { value: path, defaultValue: path }),
      entry("queue.wake_retry_interval_seconds", { value: 300, defaultValue: 300 })]);
    const list = configListLines(read.entries, width, "workspace.root");
    expect(list.every((l) => strWidth(l.text) <= width)).toBe(true);
    expect(list[0].text).toContain("…");
    const detail = configDetailLines(read, "workspace.root", width);
    expect(detail.every((l) => l.text.length <= width)).toBe(true);
    expect(detail.map((l) => l.text).join("").replaceAll(" ", "")).toContain(path);
    expect(read.entries[0].value).toBe(path);
    expect(configValue(read.entries[1])).toBe("5 分钟");
  });
  it("保持不可用与隐藏值诚实，并使已移除的选择失效", () => {
    const read = makeRead([entry("host.name", { visibility: "unavailable", value: null, defaultKnown: false }),
      entry("policies.claude_compaction.message_inline", { value: null, visibility: "withheld", reason: "Instruction body withheld." })]);
    expect(configValue(read.entries[0])).toBe("不可用");
    expect(configValue(read.entries[0], true)).toBe("未报告");
    expect(configValue(read.entries[1])).toBe("内容已隐藏");
    expect(configDetailLines(read, "removed.setting", 54)[0].text).toContain("刷新后设置不可用");
    expect(configSourceLines(read, 54).map((l) => l.text).join(" ")).toContain("Credentials withheld.");
    expect(configSourceLines(null, 54)[0].text).toContain("配置不可用");
  });
});
