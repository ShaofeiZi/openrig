// OPR.0.4.1.11.2（FR-3）——CLI-medium 捕获。asciinema 不在此主机，故我们不伪造捕获，而是直接发出
// 文档化的 asciicast v2 格式（零依赖，按 impl-prd 的"或等价"）：一行 JSON 头，后接
// [time, "o", data] 输出事件行。二进制安装处真实的 `asciinema rec`
// 交互会话仍可用；此零依赖路径在所有地方覆盖命令输出捕获，且确定性
//（除非给出时间戳，否则无墙上时钟）。
import { describe, it, expect } from "vitest";
import { buildAsciicast, captureCommandCast } from "../twin/capture/asciicast.js";

describe("buildAsciicast (OPR.0.4.1.11.2 FR-3: zero-dep asciicast v2 CLI artifact)", () => {
  it("emits a valid asciicast v2 header line + output event lines", () => {
    const cast = buildAsciicast({
      width: 80,
      height: 24,
      events: [
        { time: 0, data: "hello\r\n" },
        { time: 0.5, data: "world\r\n" },
      ],
    });
    const lines = cast.trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(JSON.parse(lines[1])).toEqual([0, "o", "hello\r\n"]);
    expect(JSON.parse(lines[2])).toEqual([0.5, "o", "world\r\n"]);
  });

  it("is deterministic when no timestamp is provided (no wall-clock leaks into output)", () => {
    const a = buildAsciicast({ width: 80, height: 24, events: [{ time: 0, data: "x" }] });
    const b = buildAsciicast({ width: 80, height: 24, events: [{ time: 0, data: "x" }] });
    expect(a).toBe(b);
  });

  it("includes the timestamp in the header only when explicitly provided", () => {
    const withTs = buildAsciicast({ width: 80, height: 24, events: [], timestamp: 1700000000 });
    expect(JSON.parse(withTs.trim().split("\n")[0])).toMatchObject({ version: 2, timestamp: 1700000000 });
    const without = buildAsciicast({ width: 80, height: 24, events: [] });
    expect(JSON.parse(without.trim().split("\n")[0]).timestamp).toBeUndefined();
  });

  it("captureCommandCast wraps a real command's output into a valid cast (zero-dep capture path)", () => {
    const cast = captureCommandCast({
      command: process.execPath, // node — guaranteed present
      args: ["-e", "process.stdout.write('hello\\nworld\\n')"],
    });
    const lines = cast.trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2 });
    const event = JSON.parse(lines[1]);
    expect(event[1]).toBe("o");
    expect(event[2]).toContain("hello");
    expect(event[2]).toContain("world");
  });
});
