import { describe, expect, it } from "vitest";
import { strWidth, clipW, padEndW, dropW, columnIndex } from "../src/text-width.js";

// 显示宽度工具回归：中文双宽 + ANSI SGR 不占列。
// clipW 曾逐字符调用 strWidth，把 `\x1b[31m` 拆开逐字节计数并从中截断，
// 导致半个转义序列泄漏到终端。此处锁定：SGR 整段原样保留、CJK 不拆字。

describe("strWidth 基础", () => {
  it("ASCII 占 1 列，CJK 占 2 列，SGR 序列不计列", () => {
    expect(strWidth("abc")).toBe(3);
    expect(strWidth("你好")).toBe(4);
    expect(strWidth("\x1b[31m红\x1b[0m")).toBe(2);
  });
});

describe("clipW CJK 截断", () => {
  it("按显示宽度截断且不拆开 CJK 字符", () => {
    expect(clipW("你好世界", 3)).toBe("你…");
    expect(strWidth(clipW("你好世界", 3))).toBeLessThanOrEqual(3);
    expect(clipW("你好世界", 10)).toBe("你好世界"); // 未超宽原样
  });
});

describe("clipW SGR 转义", () => {
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";

  it("保留完整 SGR 序列且不从中截断", () => {
    const out = clipW(`${RED}你好世界${RESET}`, 5);
    // 开色序列必须完整出现
    expect(out.startsWith(RED)).toBe(true);
    // 绝不能残留半个转义序列（以 \x1b[ 开头但没有收尾 m）
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/);
    // 截断落在中文上，SGR 不可被计入宽度
    expect(out).toBe(`${RED}你好…`);
    expect(strWidth(out)).toBeLessThanOrEqual(5);
  });

  it("多个 SGR 序列都整段透传，不被截断拆坏", () => {
    const text = `${RED}甲${RESET}${RED}乙丙丁${RESET}`;
    const out = clipW(text, 3);
    // 每一处 \x1b 都必须是完整序列
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(out.length - stripped.length).toBeGreaterThan(0); // 确实透传了 SGR
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/); // 无截断到一半的转义
    expect(strWidth(out)).toBeLessThanOrEqual(3);
  });
});

describe("padEndW 对齐", () => {
  it("按显示宽度右补空格", () => {
    expect(padEndW("你", 4)).toBe("你  "); // 你=2 列，补 2 空格
    expect(padEndW("ab", 4)).toBe("ab  ");
  });
});

describe("dropW 开窗（无 SGR 路径须与旧行为逐字一致）", () => {
  it("按显示宽度丢弃前导列，双宽不拆", () => {
    expect(dropW("你好世界", 2)).toBe("好世界"); // 丢弃"你"=2列
    expect(dropW("你好世界", 1)).toBe("你好世界"); // 1列装不下"你"，不拆、保留
    expect(dropW("abcdef", 2)).toBe("cdef");
    expect(dropW("abc", 0)).toBe("abc"); // width<=0 原样
  });

  it("保留前导 SGR 颜色序列，不从中截断", () => {
    const out = dropW("\x1b[31m你好世界", 2);
    expect(out.startsWith("\x1b[31m")).toBe(true);
    expect(out).toBe("\x1b[31m好世界");
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/); // 无半个转义残留
  });
});

describe("clipW 边界（固化现状，不伪装为正确契约）", () => {
  it("width<=0 早返回/省略号行为按现状锁定", () => {
    expect(clipW("", 0)).toBe(""); // strWidth=0<=0 早返回
    expect(clipW("\x1b[31m", 0)).toBe("\x1b[31m"); // 纯 SGR 早返回原文
    expect(clipW("你好", 0)).toBe("…"); // 超宽且 width<=0：立即中断出省略号（输出占1列）
  });
});

describe("columnIndex 列定位", () => {
  it("col=0 恒返回 0（前导 ANSI 之前），符合 render 起始定位", () => {
    expect(columnIndex("\x1b[31m你好", 0)).toBe(0);
  });

  it("无 SGR：按显示列返回 UTF-16 索引", () => {
    expect(columnIndex("你好", 0)).toBe(0);
    expect(columnIndex("你好", 1)).toBe(1); // "你"占列0-1，列1落在其后(=好起点)
    expect(columnIndex("ab", 1)).toBe(1);
  });

  it("SGR 占索引不占列：列定位不被转义字节带偏", () => {
    // \x1b[31m=5码元 + 你(列0-1) + 好(列2-3)；列2 应落在"好"起点 = 6
    expect(columnIndex("\x1b[31m你好", 2)).toBe(6);
    expect(columnIndex("\x1b[31m你好", 5)).toBe(7); // 超出内容长度也只走到末尾
  });
});
