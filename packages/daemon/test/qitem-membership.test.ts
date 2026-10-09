// Canonical scope-membership matcher（VM-003 + VM-004）——C1 纯单元矩阵。
//
// 固定 parseScopeTags：typed-tag authority、逐 JSON element 的 comma-legacy 识别、
// 仅 element-level trim（P1 精度 pin），以及 exact-name 语义（无 substring、无 suffix、
// 不做 post-prefix trim），使 parser 与不带引号的 SQL prefilter 对齐。

import { describe, it, expect } from "vitest";
import { parseScopeTags } from "../src/domain/slices/qitem-membership.js";

describe("parseScopeTags——canonical scope membership", () => {
  it("干净 array：slice 与 mission 为独立 element", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M", "slice:X"]));
    expect([...slices]).toEqual(["X"]);
    expect([...missions]).toEqual(["M"]);
  });

  it("逗号内嵌 legacy：一个 element 同时携带 mission + slice", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M,slice:X"]));
    expect(slices.has("X")).toBe(true);
    expect(missions.has("M")).toBe(true);
  });

  it("裁剪 element 边界空白（` slice:X ` -> X）", () => {
    const { slices } = parseScopeTags(JSON.stringify([" slice:X "]));
    expect([...slices]).toEqual(["X"]);
  });

  it("带空格逗号的 legacy element（`mission:M , slice:X`）", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M , slice:X"]));
    expect(slices.has("X")).toBe(true);
    expect(missions.has("M")).toBe(true);
  });

  it("P1 负向：`slice: X`（冒号后有空格）不属于 X", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice: X"]));
    expect(slices.has("X")).toBe(false); // name 是 ` X`，绝不做 post-prefix trim
    expect(slices.has(" X")).toBe(true); // 如实且与 prefilter 对齐的解析
  });

  it("负向：`slice:X-suffix` 产生 `X-suffix`，绝非 `X`", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice:X-suffix"]));
    expect(slices.has("X")).toBe(false);
    expect(slices.has("X-suffix")).toBe(true);
  });

  it("单 element 多 slice（`slice:X,slice:Y`）-> 两者都有", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice:X,slice:Y"]));
    expect([...slices].sort()).toEqual(["X", "Y"]);
  });

  it("格式错误的 JSON -> 空 set", () => {
    const { slices, missions } = parseScopeTags("{not json");
    expect(slices.size).toBe(0);
    expect(missions.size).toBe(0);
  });

  it("null / undefined -> 空 set", () => {
    for (const raw of [null, undefined]) {
      const { slices, missions } = parseScopeTags(raw);
      expect(slices.size).toBe(0);
      expect(missions.size).toBe(0);
    }
  });

  it("非 array JSON（object）-> 空 set", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify({ slice: "X" }));
    expect(slices.size).toBe(0);
    expect(missions.size).toBe(0);
  });

  it("跳过非 string array element", () => {
    const { slices } = parseScopeTags(JSON.stringify([42, { a: 1 }, "slice:X"]));
    expect([...slices]).toEqual(["X"]);
  });
});
