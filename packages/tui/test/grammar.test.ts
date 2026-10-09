import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { defaultSections } from "../src/state.js";

describe("safe-core grammar (FR-1, §4.B)", () => {
  it("解析 launch 区段的 :section 跳转", () => {
    expect(parseCommand(":topology")).toEqual({ type: "jump", section: "topology" });
    expect(parseCommand(":specs")).toEqual({ type: "jump", section: "specs" });
    expect(parseCommand(":needs")).toEqual({ type: "jump", section: "needs" });
    expect(parseCommand(":scopes")).toEqual({ type: "jump", section: "scopes" });
    expect(parseCommand(":execution").type).toBe("error");
  });

  it("保留 needs 命令别名，并允许新增中文别名", () => {
    expect(parseCommand("needs")).toEqual({ type: "jump", section: "needs" });
    expect(parseCommand("需要")).toEqual({ type: "jump", section: "needs" });
  });

  it("点名未知区段，绝不静默 no-op", () => {
    const r = parseCommand(":bogus");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/未知分区 ":bogus"/);
  });

  it("从同一份 supplied registry 派生 section 命令", () => {
    const sections = [...defaultSections(), { name: "extra", sourceRead: "GET /extra", drillShape: "flat" }];
    expect(parseCommand(":extra", sections)).toEqual({ type: "jump", section: "extra" });
  });

  it("解析 /text filter；裸 / 清空", () => {
    expect(parseCommand("/driver")).toEqual({ type: "filter", text: "driver" });
    expect(parseCommand("/")).toEqual({ type: "filter", text: "" });
  });

  it("通过命令路径驱动 rig-spec 视图与内容滚动", () => {
    expect(parseCommand("tab topology")).toEqual({ type: "tab", tab: "topology" });
    expect(parseCommand("tab configuration")).toEqual({ type: "tab", tab: "configuration" });
    expect(parseCommand("tab yaml")).toEqual({ type: "tab", tab: "yaml" });
    expect(parseCommand("scroll down")).toEqual({ type: "content-scroll", delta: 10 });
    expect(parseCommand("scroll up")).toEqual({ type: "content-scroll", delta: -10 });
  });

  it("为已知 resource kind 解析 <resource> <name> drill", () => {
    expect(parseCommand("rig openrig-build")).toEqual({ type: "drill", resource: "rig", name: "openrig-build" });
    expect(parseCommand("agent dev50.driver")).toEqual({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(parseCommand("host vm-host")).toEqual({ type: "drill", resource: "host", name: "vm-host" });
    expect(parseCommand("spec driver-agent")).toEqual({ type: "drill", resource: "spec", name: "driver-agent" });
  });

  it("解析跨导航动词", () => {
    expect(parseCommand("spec-of dev50.driver")).toEqual({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(parseCommand("running driver-agent")).toEqual({ type: "cross", kind: "running", name: "driver-agent" });
  });

  it("用违规 token 点名未知命令", () => {
    const r = parseCommand("frobnicate xyz");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/未知命令 "frobnicate"/);
  });

  it("点名缺目标的 drill", () => {
    const r = parseCommand("agent");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/agent/);
  });

  it("把空输入视为显式 typed no-op", () => {
    expect(parseCommand("")).toEqual({ type: "noop" });
    expect(parseCommand("   ")).toEqual({ type: "noop" });
  });
});
