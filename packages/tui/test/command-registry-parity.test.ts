// REGISTRY I1（ruling 64f1dbdf，PM pin 1）——对等套件：未注册的动作
// 不能存在。RED-first：本文件在注册表存在前就导入它。
import { describe, it, expect } from "vitest";
import { COMMAND_REGISTRY, type CommandEntry } from "../src/commands/registry.js";
import { parseCommand } from "../src/grammar.js";

describe("command registry——唯一来源（PM pin 1：引入时 parity 即让 CI 失败）", () => {
  it("每个 registry entry 经其 sample 调用都解析为非 error action", () => {
    for (const entry of COMMAND_REGISTRY) {
      const action = parseCommand(entry.sample);
      expect(action.type, `${entry.name} sample '${entry.sample}'`).not.toBe("error");
    }
  });

  it("每个 entry 带完整契约：name、aliases、args、description、context", () => {
    for (const e of COMMAND_REGISTRY) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(Array.isArray(e.aliases)).toBe(true);
      expect(typeof e.args).toBe("string");
      expect(e.description.length).toBeGreaterThan(0);
      expect(["standard", "always"]).toContain(e.context);
    }
  });

  it("alias 是一等：alias 解析到与规范名同一 action（逐字节相等）", () => {
    for (const e of COMMAND_REGISTRY) {
      for (const alias of e.aliases) {
        const aliasSample = e.sample.replace(new RegExp(`^${e.name}`), alias);
        expect(parseCommand(aliasSample), `${e.name} alias ${alias}`).toEqual(parseCommand(e.sample));
      }
    }
  });

  it("PARITY：grammar 接受的每个动词都是已注册命令（无未注册动词解析成功）", () => {
    // 注册表外的动词必产生 error 动作——构造即强制。
    expect(parseCommand("definitely-unregistered-verb x").type).toBe("error");
    // 注册表名搭 grammar 自身的错误列表（序列化，非手维护）。
    const err = parseCommand("definitely-unregistered-verb x");
    if (err.type === "error") {
      for (const e of COMMAND_REGISTRY.filter((x: CommandEntry) => !x.prefix)) {
        expect(err.message).toContain(e.name);
      }
    }
  });

  it("P10 teaching migrant：`graph` 是已注册命令，其 action 等于 `tab graph`", () => {
    const entry = COMMAND_REGISTRY.find((e: CommandEntry) => e.name === "graph");
    expect(entry).toBeDefined();
    expect(parseCommand("graph")).toEqual(parseCommand("tab graph"));
    expect(entry!.description).toContain("图形");
  });
});
