// Slice-03 rig-context v1（OPR.0.5.0.3）——ref 加固（证明条目 6 + R2 收尾条目 8）。
// 寻址契约 §2 称其为“唯一必须正确的内容”：类路径多分段 ref（例如
// `packs/compaction-restore`）需要逐段校验。复用 assertSafePackName 字符集并按 `/` 分段调整，
// 同时继续禁止遍历、绝对路径、空段和注入。isSafePackVersion 是有界且不含分隔符的版本 token，
// 从检查点 b10c1618 原样复用，修复 R2 (a) ENAMETOOLONG 和 (b) 的存储 ID 部分。

import { describe, it, expect } from "vitest";
import { isSafePackRef, assertSafePackRef, isSafePackVersion } from "../src/domain/context-packs/ref-safety.js";

describe("isSafePackRef——类路径多分段 ref 校验（逐段）", () => {
  it("接受每段都符合复用字符集的类路径多分段 ref", () => {
    expect(isSafePackRef("packs/compaction-restore")).toBe(true);
    expect(isSafePackRef("compaction-restore")).toBe(true); // 单段仍有效。
    expect(isSafePackRef("a/b/c.d_e-f")).toBe(true);
  });

  for (const bad of [
    "../evil",                 // 父目录遍历分段
    "packs/../evil",           // ref 中间的遍历
    "packs/..",                // 尾部 ..
    "/abs/path",               // 绝对路径会产生空的首段
    "packs//nested",           // 中间空段
    "packs/",                  // 尾部空段
    "",                        // 空 ref
    ".",                       // 点分段
    "packs/.hidden",           // 分段未以允许的首字符开头
    "packs/na me",             // 空白字符，存在注入风险
    "packs/na:me",             // 冒号，存在 YAML/ID 注入风险
    "packs/na\nme",            // 换行符，存在 YAML 注入风险
    "packs/na\tme",            // 制表符
    `packs/${"x".repeat(65)}`, // 分段超过 64 字符上限
  ]) {
    it(`拒绝不安全 ref ${JSON.stringify(bad)}`, () => {
      expect(isSafePackRef(bad)).toBe(false);
      expect(() => assertSafePackRef(bad)).toThrow();
    });
  }

  it("assertSafePackRef 对有效 ref 不执行操作且不抛错", () => {
    expect(() => assertSafePackRef("packs/compaction-restore")).not.toThrow();
  });
});

describe("isSafePackVersion——有界且不含分隔符的版本 token（复用；R2 (a)/(b) 修复）", () => {
  it("接受有界版本 token", () => {
    expect(isSafePackVersion("1.0.0")).toBe(true);
    expect(isSafePackVersion("2026-08-04")).toBe(true);
    expect(isSafePackVersion("v1_2+build")).toBe(true);
  });

  for (const bad of [
    "x".repeat(300),   // R2 (a)：300 字符版本会让 `${name}-${version}.md` 触发 ENAMETOOLONG
    "1.0 0",           // 空白字符
    "1:0:0",           // 冒号会导致存储 ID 冲突（R2 (b)）
    "1/0",             // 分隔符
    "@1.0",            // 首字符不在允许字符集 / @
    "",                // 空值
  ]) {
    it(`拒绝不安全版本 ${JSON.stringify(bad.length > 20 ? bad.slice(0, 12) + "…" : bad)}`, () => {
      expect(isSafePackVersion(bad)).toBe(false);
    });
  }
});
