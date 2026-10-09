import { describe, it, expect } from "vitest";
import { classifyResourceProjection, hashContent } from "../src/domain/conflict-detector.js";

// 内容 fixture。source 是要投影的新内容；target 各不相同。
const files: Record<string, string> = {
  src: "SOURCE-NEW-v2",
  tgt_stale: "PROJECTED-OLD-v1", // == 上次写入的内容 → stale-projection
  tgt_operator: "OPERATOR-EDIT", // 与上次写入值及 source 均不同
  tgt_same: "SOURCE-NEW-v2", // == source → no_op
};
const fsOps = { exists: (p: string) => p in files, readFile: (p: string) => files[p]! };

describe("classifyResourceProjection——P20 判别（查询 manifest）", () => {
  it("target 缺失 → safe_projection", () => {
    expect(classifyResourceProjection("src", "MISSING", "skill", undefined, fsOps, () => null)).toBe("safe_projection");
  });

  it("source == target → no_op（已经是最新内容）", () => {
    expect(classifyResourceProjection("src", "tgt_same", "skill", undefined, fsOps, () => hashContent(files.tgt_same!))).toBe("no_op");
  });

  it("陈旧：target == 上次投影内容（source 已更新）→ stale_overwrite（安全、静默）", () => {
    const last = hashContent(files.tgt_stale!); // manifest 表明这正是我们写入的内容
    expect(classifyResourceProjection("src", "tgt_stale", "skill", undefined, fsOps, () => last)).toBe("stale_overwrite");
  });

  it("操作者修改：target 与上次写入值及 source 均不同 → operator_conflict（保护）", () => {
    const last = hashContent("WHAT-WE-WROTE-EARLIER"); // ≠ 当前 target（操作者已编辑）
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => last)).toBe("operator_conflict");
  });

  it("没有 manifest 条目 → hash_conflict（P17 回退）", () => {
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => null)).toBe("hash_conflict");
  });

  it("旧版调用方（无 lookup 参数）→ hash_conflict（P17 行为不变）", () => {
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps)).toBe("hash_conflict");
  });

  // 损坏与缺失的区别（review-r1 MEDIUM）。manifest 读取抛错表示损坏：无法排除操作者编辑，
  // 而 hash_conflict 会覆盖它。真正的闭合失败 = 保护（operator_conflict）。这不同于缺失
  //（null，无条目），后者是无害的 P17 hash_conflict 回退（由下方固定）。
  it("manifest 查询抛错（读取损坏）→ operator_conflict（真正闭合失败：保护，绝不覆盖）", () => {
    const throwing = () => {
      throw new Error("db locked");
    };
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, throwing)).toBe("operator_conflict");
  });

  it("BROKEN≠ABSENT: a returned null (no entry) stays hash_conflict, only a THROW protects", () => {
    // 守卫二者的区分——此处回归要么会重新混淆两者，要么会过度保护缺失 target。
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => null)).toBe("hash_conflict");
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => { throw new Error("x"); })).toBe("operator_conflict");
  });
});
