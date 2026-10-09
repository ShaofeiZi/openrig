// REGISTRY I4——socket "commands" OBSERVE 查询：同一注册表带 LIVE 可用性的
// 一个序列化投影。对等：socket 行 == 注册表条目 ==
// I2 dump 的数据契约（一源，派生表面）。
import { describe, it, expect } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createControlSocket } from "../src/socket-server.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { COMMAND_REGISTRY, serializeCommands } from "../src/commands/registry.js";

async function query(sockPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath, () => conn.write(line + "\n"));
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { conn.end(); resolve(JSON.parse(buf.slice(0, buf.indexOf("\n")))); }
    });
    conn.on("error", reject);
  });
}

describe("socket 命令查询（I4）", () => {
  it("返回带 live 可用性的完整 registry 投影；与唯一来源对等", async () => {
    const view = createViewState({ instanceId: "i4", getSnapshot: () => demoSnapshot() });
    const sockPath = path.join(os.tmpdir(), `t-i4-${process.pid}.sock`);
    const sock = await createControlSocket({ socketPath: sockPath, view });
    try {
      const res = (await query(sockPath, "commands")) as { ok: boolean; commands: Array<{ name: string; available: boolean; context: string }> };
      expect(res.ok).toBe(true);
      expect(res.commands.length).toBe(COMMAND_REGISTRY.length); // every entry, none hidden
      expect(res.commands.every((c) => typeof c.available === "boolean" && c.context.length > 0)).toBe(true);
      expect(res.commands.find((c) => c.name === "help")!.available).toBe(true); // always-context
      // 与序列化器对等（唯一投影——字节级相等）
      expect(res.commands).toEqual(JSON.parse(JSON.stringify(serializeCommands("standard"))));
    } finally {
      await sock.close();
    }
  });
});
