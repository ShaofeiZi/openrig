// OPR.0.4.6.MH1 rev1-r1 B（fixback）——`rig host select` 命令
// 本身：registry 校验、唯一一次 daemon 写入、结构化
// unknown-id 错误（不持久化任何东西）、select-local 与
// daemon 宕机表面。读 helper 在
// host-selection.test.ts 覆盖；此处钉住该动词的 write+validation 路径
//（FR-1 AC）作为回归。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand } from "../src/commands/host.js";
import { addHostEntry } from "../src/host-registry.js";

describe("rig host select (OPR.0.4.6.MH1 FR-1 command path)", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;
  let server: http.Server;
  let port: number;
  let writes: Array<{ method: string; url: string; body: string }>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostselect-"));
    savedEnv = {};
    for (const k of ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST_SELECTED"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.OPENRIG_HOME = dir;

    writes = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        writes.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    process.env.OPENRIG_URL = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
    return new Promise(async (resolve) => {
      const out: string[] = []; const err: string[] = [];
      const ol = console.log; const oe = console.error; const oc = process.exitCode;
      process.exitCode = undefined;
      console.log = (...a: unknown[]) => out.push(a.join(" "));
      console.error = (...a: unknown[]) => err.push(a.join(" "));
      try { await fn(); } finally { console.log = ol; console.error = oe; }
      const exitCode = process.exitCode as number | undefined;
      process.exitCode = oc;
      resolve({ out, err, exitCode });
    });
  }

  function run(argv: string[]) {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    return prog.parseAsync(["node", "rig", "host", ...argv]);
  }

  function seedRegistry() {
    expect(addHostEntry({ id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "VPS_A_TOKEN" }).ok).toBe(true);
  }

  it("selects a registered id: validates against the registry, then ONE daemon config write", async () => {
    seedRegistry();
    const { out, exitCode } = await capture(() => run(["select", "vps-a"]));
    expect(exitCode).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("POST");
    expect(writes[0]!.url).toBe("/api/config/host.selected");
    expect(JSON.parse(writes[0]!.body)).toEqual({ value: "vps-a" });
    expect(out.join("\n")).toContain("已选主机：vps-a");
  });

  it("select <unknown> is a structured error naming the registered ids — and persists NOTHING", async () => {
    seedRegistry();
    const { err, exitCode } = await capture(() => run(["select", "nope"]));
    expect(exitCode).toBe(1);
    const errStr = err.join("\n");
    expect(errStr).toContain("无法选择 'nope'");
    expect(errStr).toContain("vps-a");
    expect(writes).toHaveLength(0);
  });

  it("select with no registry at all fails loud and teaches the add path — no write", async () => {
    const { err, exitCode } = await capture(() => run(["select", "vps-a"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("没有已登记主机");
    expect(writes).toHaveLength(0);
  });

  it("select local is always legal (no registry needed) and writes 'local' through the same path", async () => {
    const { out, exitCode } = await capture(() => run(["select", "local"]));
    expect(exitCode).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body)).toEqual({ value: "local" });
    expect(out.join("\n")).toContain("local（本机）");
  });

  it("daemon down surfaces the connection error (the PRD-named trade), exit 1", async () => {
    seedRegistry();
    // Point at the fixture server's port AFTER closing it: guaranteed dead.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { err, exitCode } = await capture(() => run(["select", "vps-a"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n").length).toBeGreaterThan(0);
  });
});
