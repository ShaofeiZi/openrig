// Slice-03 V3 无投递名词门禁：context pack 由 `zrig context` 组合和管理；
// startup_files 绝不能将其转为 send_text 操作。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeStartupBlock, validateStartupFile } from "../src/domain/startup-validation.js";

describe("startup_files 拒绝已退役、与投递耦合的 context_pack 表示形式", () => {
  it.each([
    { kind: "context_pack", ref: "packs/release-priming" },
    { kind: "context_pack", name: "release-priming", version: "1" },
  ])("拒绝 $kind 输入，而不是将其转换为 send_text", (entry) => {
    const errors = validateStartupFile(entry, 0, "");
    expect(errors.join("\n")).toMatch(/context.pack.*不支持|compose.*专用.*投递/i);
  });

  it("保留普通启动文件规范化行为", () => {
    expect(validateStartupFile({ kind: "file", path: "skill.md" }, 0, "")).toEqual([]);
    const block = normalizeStartupBlock({ files: [{ path: "skill.md" }] });
    expect(block.files[0]).toMatchObject({ kind: "file", path: "skill.md" });
  });

  it("生产代码中不存在从 context_pack 到 send_text 的表示或展开路径", () => {
    const paths = [
      "../src/domain/startup-validation.ts",
      "../src/domain/runtime-adapter.ts",
      "../src/domain/types.ts",
      "../src/domain/rigspec-instantiator.ts",
    ];
    const source = paths.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    expect(source).not.toContain("contextPackRef");
    expect(source).not.toContain("expandContextPackStartupFiles");
    expect(source).not.toMatch(/kind\??:\s*"file"\s*\|\s*"context_pack"/);
    expect(source).not.toMatch(/context_pack[\s\S]{0,500}send_text/);
  });
});
