import { describe, it, expect } from "vitest";
import { buildRestorePacket } from "../src/domain/seat-handover-service.js";

// 后继启动数据包携带前任最后几轮交互的有界“来自记录”标签回顾（源自 provider JSONL），
// 加上一行标明前任记录路径的回执，并标记为如实降级。该回顾是 claude 运行时保留回滚内容的
// 永久支路（备用屏幕中的 seat 不保留原生回滚）；绝不称其为 "scrollback"——标签必须明确
// 表明这是重放。

const base = {
  seatRef: "dev.driver@my-rig",
  reason: "context 85%",
  departingSession: "dev-driver-h1@my-rig",
  handoverAt: "2026-08-07T01:00:00Z",
  capturedContext: "",
};

describe("buildRestorePacket——回顾 + 回执（标明来自记录）", () => {
  it("根据前任交互渲染有界回顾，并标为从记录重放（而非 scrollback）", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [
        { role: "user", content: "完成这个原子" },
        { role: "assistant", content: "原子已完成，正在移交" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });
    expect(packet).toContain("前任回顾（从记录重放，并非实时终端）");
    expect(packet).not.toContain("scrollback");
    expect(packet).toContain("user: 完成这个原子");
    expect(packet).toContain("assistant: 原子已完成，正在移交");
  });

  it("渲染标明前任记录路径的回执行，并标记为如实降级（持久、可 grep、不便人工滚动查看）", () => {
    const packet = buildRestorePacket({ ...base, recap: [{ role: "user", content: "x" }], recordPath: "/p/abc.jsonl" });
    expect(packet).toContain("前任记录：/p/abc.jsonl");
    expect(packet).toContain("如实降级");
    expect(packet).toContain("不便人工滚动查看");
  });

  it("没有可用记录时如实省略回顾/回执 section（不伪造）", () => {
    const packet = buildRestorePacket({ ...base, recap: [], recordPath: null });
    expect(packet).not.toContain("前任回顾（从记录重放");
    expect(packet).not.toContain("前任记录：");
    // 基础数据包（seat/reason/predecessor/handover）仍会渲染
    expect(packet).toContain("Seat：dev.driver@my-rig");
  });

  it("B16：不可用回顾将其具名原因渲染为带标签行（绝不静默省略）", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [],
      recordPath: null,
      recapUnavailableReason: "以名称为键的上下文 sidecar 缺失或未携带 transcript_path",
    });
    expect(packet).toContain("--- 前任回顾不可用：以名称为键的上下文 sidecar 缺失或未携带 transcript_path ---");
    expect(packet).not.toContain("scrollback"); // 不可用行同样遵守边界
  });

  it("B16：回顾已解析时，即使传入原因也会抑制不可用行", () => {
    const packet = buildRestorePacket({
      ...base,
      recap: [{ role: "user", content: "x" }],
      recordPath: "/p/abc.jsonl",
      recapUnavailableReason: "不应渲染",
    });
    expect(packet).toContain("前任回顾（从记录重放");
    expect(packet).not.toContain("前任回顾不可用");
  });

  it("完全省略 recap/recordPath 时保持向后兼容", () => {
    const packet = buildRestorePacket(base);
    expect(packet).toContain("Seat：dev.driver@my-rig");
    expect(packet).not.toContain("前任回顾（从记录重放");
  });
});

// OPR.0.5.3.5 recap-write 原子（微需求 7 / Q2 边界需求）——人工编写的 seat 回顾作为
//“来自记录”回顾旁的第三支路加入数据包：后继会被指向该地址（seat:RECAP.md——无复制组合，
// 绝不内联字节），并注明链深度；根据 B16 原则，缺失显示为带标签行，绝不静默省略。
describe("buildRestorePacket——人工编写的回顾支路（位于 seat，按地址引用）", () => {
  it("渲染人工回顾的地址与链深度——使用指针，绝不内联字节", () => {
    const packet = buildRestorePacket({
      ...base,
      authoredRecap: { address: "seat:RECAP.md", chainLength: 2 },
    });
    expect(packet).toContain("人工编写的 seat 回顾");
    expect(packet).toContain("seat:RECAP.md");
    expect(packet).toMatch(/保留了 2 个已被替代的前任/);
    // 告诉后继如何拉取——handover PROFILE compose 是解析 seat: 引用的动词
    //（get 仅用于 library）；在 green 前修正固定点（原 RED 断言 get，
    // 但它不接受 tree 引用——已披露）。
    expect(packet).toContain("zrig context profile");
  });

  it("缺失会以带标签行说明原因，绝不静默处理", () => {
    const packet = buildRestorePacket({
      ...base,
      authoredRecapAbsentReason: "seat 树中没有 RECAP.md（前任从未编写）",
    });
    expect(packet).toContain("人工编写的 seat 回顾");
    expect(packet).toContain("前任从未编写");
  });

  it("完全省略人工编写支路时保持向后兼容", () => {
    const packet = buildRestorePacket(base);
    expect(packet).not.toContain("人工编写的 seat 回顾");
  });
});
