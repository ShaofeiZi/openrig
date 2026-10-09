// OPR.0.4.1.27 单元 6——发送者或所有者终端解析器。人类操作卡片
//（action-required/approval）打开发送者（sourceSession）；智能体拥有的卡片
//（progress/shipped/observation）打开当前持有者（destinationSession），目标无法解析时
// 回退到来源。依据 tasks-dev2 保真映射：sourceSession/destinationSession 是仅有的
// 可寻址终端会话，绝不使用 handed_off_from。

import { describe, it, expect } from "vitest";
import { resolveCardTerminalSession } from "../src/components/for-you/FeedCard.js";

const SRC = "orch-lead@openrig-delivery";
const DST = "dev1-driver@openrig-delivery";

describe("resolveCardTerminalSession (OPR.0.4.1.27 Unit 6)", () => {
  it("action-required opens the SENDER (sourceSession)", () => {
    expect(resolveCardTerminalSession("action-required", SRC, DST)).toBe(SRC);
  });
  it("approval opens the SENDER (sourceSession)", () => {
    expect(resolveCardTerminalSession("approval", SRC, DST)).toBe(SRC);
  });
  it("progress opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("progress", SRC, DST)).toBe(DST);
  });
  it("shipped opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("shipped", SRC, DST)).toBe(DST);
  });
  it("observation opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("observation", SRC, DST)).toBe(DST);
  });
  it("agent-owned falls back to source when no destination resolves", () => {
    expect(resolveCardTerminalSession("progress", SRC, undefined)).toBe(SRC);
  });
  it("returns undefined when neither session resolves", () => {
    expect(resolveCardTerminalSession("action-required", undefined, undefined)).toBeUndefined();
  });
});
