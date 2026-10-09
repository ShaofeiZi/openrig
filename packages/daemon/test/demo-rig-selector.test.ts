import { describe, expect, it } from "vitest";
import {
  filterNodesForRigId,
  selectCurrentRigSummary,
} from "../src/domain/demo-rig-selector.js";

describe("演示 rig selector", () => {
  it("返回给定名称唯一的当前 rig 摘要", () => {
    expect(
      selectCurrentRigSummary(
        [
          { rigId: "rig-1", name: "demo-rig" },
          { rigId: "rig-2", name: "other-rig" },
        ],
        "demo-rig"
      )
    ).toEqual({ rigId: "rig-1", name: "demo-rig" });
  });

  it("找不到 rig 名称时返回 null", () => {
    expect(selectCurrentRigSummary([{ rigId: "rig-1", name: "demo-rig" }], "missing")).toBeNull();
  });

  it("多个运行中的 rig 同名时明确失败", () => {
    expect(() =>
      selectCurrentRigSummary(
        [
          { rigId: "rig-1", name: "demo-rig" },
          { rigId: "rig-2", name: "demo-rig" },
        ],
        "demo-rig"
      )
    ).toThrow(/存在歧义/);
  });

  it("同名 rig 中优先选择唯一正在运行的 rig，而不是已停止的 rig", () => {
    expect(
      selectCurrentRigSummary(
        [
          { rigId: "old", name: "demo-rig", status: "stopped" },
          { rigId: "new", name: "demo-rig", status: "running" },
        ],
        "demo-rig"
      )
    ).toEqual({ rigId: "new", name: "demo-rig", status: "running" });
  });

  it("按 rig id 而不是 rig 名称过滤节点清单", () => {
    expect(
      filterNodesForRigId(
        [
          { rigId: "old", logicalId: "dev.impl" },
          { rigId: "new", logicalId: "dev.impl" },
          { rigId: "new", logicalId: "dev.qa" },
        ],
        "new"
      )
    ).toEqual([
      { rigId: "new", logicalId: "dev.impl" },
      { rigId: "new", logicalId: "dev.qa" },
    ]);
  });
});
