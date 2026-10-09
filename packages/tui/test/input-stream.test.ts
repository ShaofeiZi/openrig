import { describe, expect, it } from "vitest";
import { createInputDecoder, decodeInput, sgrClick } from "../src/input.js";

describe("有状态 stdin 解码", () => {
  it("在每个 chunk 切分下保留箭头、翻页与 SGR 鼠标", () => {
    const vectors = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[5~", "\x1b[6~", sgrClick(47, 12)];
    for (const vector of vectors) {
      const expected = decodeInput(vector);
      for (let split = 1; split < Buffer.byteLength(vector); split++) {
        const decoder = createInputDecoder();
        const bytes = Buffer.from(vector);
        const actual = [
          ...decoder.write(bytes.subarray(0, split)),
          ...decoder.write(bytes.subarray(split)),
        ];
        expect(actual, `${JSON.stringify(vector)} split ${split}`).toEqual(expected);
      }
    }
  });

  it("保留跨字节切分的 UTF-8 字符", () => {
    const bytes = Buffer.from("界");
    for (let split = 1; split < bytes.length; split++) {
      const decoder = createInputDecoder();
      expect(decoder.write(bytes.subarray(0, split))).toEqual([]);
      expect(decoder.write(bytes.subarray(split))).toEqual([{ type: "char", ch: "界" }]);
    }
  });

  it("保留裸 Esc（箭头/鼠标前缀）并报为 pending，供调用方作为按键刷新", () => {
    const decoder = createInputDecoder();
    expect(decoder.hasPending()).toBe(false);
    expect(decoder.write("\x1b")).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.flush()).toEqual([{ type: "key", key: "escape" }]);
    expect(decoder.hasPending()).toBe(false);
    // 下一个 chunk 到达的真实箭头仍解码为一键，绝非 Esc + 字节
    expect(decoder.write("\x1b")).toEqual([]);
    expect(decoder.write("[A")).toEqual([{ type: "key", key: "up", action: { type: "select", delta: -1 } }]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("为不完整 CSI 前缀定义 EOF 刷新", () => {
    const decoder = createInputDecoder();
    expect(decoder.write("\x1b[")).toEqual([]);
    expect(decoder.flush()).toEqual([
      { type: "key", key: "escape" },
      { type: "char", ch: "[" },
    ]);
  });
});
