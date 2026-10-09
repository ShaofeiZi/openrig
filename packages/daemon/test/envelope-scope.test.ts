import { describe, it, expect } from "vitest";
import { scopeForTarget } from "../src/domain/session-transport.js";

// Send/broadcast header（裁定 03c35295）——TargetSpec → EnvelopeScope 映射。transport 扇出
// 知道目标形态和已解析的收件人集合，因此在 daemon 侧构建真实的规模 scope；收件人只看 header
// 就能区分 DM、multi、rig-broadcast 或 topology，这正是防消息风暴的约束。

describe("scopeForTarget——TargetSpec → EnvelopeScope（daemon 侧规模真相）", () => {
  it("{session} → dm", () => {
    expect(scopeForTarget({ session: "a@r" }, ["a@r"])).toEqual({ kind: "dm" });
  });
  it("{sessions} → 带完整收件人列表的 multi", () => {
    expect(scopeForTarget({ sessions: ["a@r", "b@r"] }, ["a@r", "b@r"])).toEqual({ kind: "multi", recipients: ["a@r", "b@r"] });
  });
  it("{rig} → 带席位数量的 rig-broadcast（防消息风暴规模）", () => {
    expect(scopeForTarget({ rig: "openrig-pm" }, ["a@pm", "b@pm", "c@pm"])).toEqual({ kind: "rig-broadcast", rig: "openrig-pm", seats: 3 });
  });
  it("{pod, rig} → 标记为 <rig>/<pod> 的限定范围 broadcast", () => {
    expect(scopeForTarget({ pod: "dev", rig: "pm" }, ["a@pm", "b@pm"])).toEqual({ kind: "rig-broadcast", rig: "pm/dev", seats: 2 });
  });
  it("{global} → topology", () => {
    expect(scopeForTarget({ global: true }, ["a@r", "b@x"])).toEqual({ kind: "topology" });
  });
});
