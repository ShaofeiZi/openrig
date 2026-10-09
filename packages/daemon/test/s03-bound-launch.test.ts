import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { seatLifecycleService } from "../src/routes/seat.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// 绝不运行 provider、shell、tmux 或 startup。操作系统隔离也会禁止这些操作。
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
// sandbox-exec 也会刻意拒绝执行权限。仅模拟该访问检查；路径解析、stat 和替换使用私有真实文件。
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, accessSync: (file: string) => { if (!(fs.statSync(file).mode & 0o111)) throw Error("不可执行"); } };
});
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
const fsOps = { readFile: () => { throw Error("禁止投影"); }, writeFile: () => { throw Error("禁止投影"); },
  exists: () => false, mkdirp: () => { throw Error("禁止投影"); }, copyFile: () => { throw Error("禁止投影"); } };
const help = '--permission-mode <mode> (choices: "acceptEdits", "auto", "default")';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "s03-bound-")));
  const cwd = path.join(root, "seat 的 workspace"); mkdirSync(path.join(cwd, "bin"), { recursive: true });
  const executable = path.join(cwd, "bin", "claude"); writeFileSync(executable, "静态模拟可执行文件"); chmodSync(executable, 0o700);
  const daemonBin = path.join(root, "daemon-bin"); mkdirSync(daemonBin); writeFileSync(path.join(daemonBin, "claude"), "另一个 daemon 可执行文件"); chmodSync(path.join(daemonBin, "claude"), 0o700);
  const db = new Database(":memory:"); open.push(db);
  // 最小表集合，并非迁移或 daemon fixture。
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
    CREATE TABLE node_permission_selections(node_id TEXT PRIMARY KEY, runtime TEXT, mode TEXT, actor TEXT, reason TEXT, updated_at TEXT);
    CREATE TABLE events(payload TEXT);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const env: Record<string,string> = { PATH: "./bin:" + daemonBin, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: "./config",
    ANTHROPIC_API_KEY: "synthetic-secret-never-in-command", OPENRIG_HOME: path.join(root, "instance") };
  const renderer = {};
  const managed = new ClaudeManagedLaunch(db, env, renderer);
  const calls: string[] = [];
  const tmux = { sendShellCommand: vi.fn(async (_target: string, command: string, check: () => void) => { check(); calls.push(command); return { ok: true as const }; }),
    sendText: vi.fn(async (_target: string, command: string) => { calls.push(command); return { ok: true as const }; }),
    sendKeys: vi.fn(async () => ({ ok: true as const })), getPaneCommand: async () => "claude", capturePaneContent: async () => "Claude Code\n>" } as unknown as TmuxAdapter;
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, claudeManagedLaunch: managed, sessionIdFactory: () => "fresh-id" });
  const binding: NodeBinding = { id: "binding", nodeId: "node", cwd, attachmentType: "tmux", tmuxSession: "seat", tmuxPane: "%1",
    tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", permissionMode: "auto", model: "model's choice" };
  const eventBus = { db, persistWithinTransaction: (event: unknown) => { db.prepare("INSERT INTO events VALUES (?)").run(JSON.stringify(event)); return event; }, notifySubscribers: vi.fn() };
  const deps: Record<string,unknown> = { rigRepo: { db }, sessionRegistry: { db }, eventBus, tmuxAdapter: tmux, runtimeAdapters: { "claude-code": adapter } };
  // 使用生产路由构造器及其真实 adapter/service 接线。
  const service = seatLifecycleService({ get: key => deps[key] });
  vi.spyOn(service as any, "resolveSeat").mockReturnValue({ nodeId: "node", entry: { runtime: "claude-code", cwd } });
  vi.spyOn(service as any, "describe").mockReturnValue({ nodeId: "node", rigId: "rig", logicalId: "owner", rigName: "rig" });
  vi.mocked(execFile).mockImplementation(((file: string, _args: string[], options: any, done: any) => {
    expect(file).toBe(executable); expect(options.cwd).toBe(cwd); expect(options.env.PATH).toBe(path.join(cwd,"bin") + ":" + daemonBin);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined(); done(null, help);
  }) as any);
  return { root, cwd, executable, daemonBin, db, env, managed, tmux, calls, adapter, binding, service, eventBus };
}
const input = { seatRef: "owner@rig", mode: "auto", actor: "operator", reason: "主动选择" };

describe("S03 生产环境托管能力选择", () => {
  it("通过生产服务/适配器接缝进行选择与审计，不启动进程，也不复制密钥", async () => {
    const f = fixture(); vi.stubEnv("PATH", f.daemonBin);
    expect(await f.service.setPermissions(input)).toEqual(expect.objectContaining({ ok: true, changed: true, to: { runtime: "claude-code", mode: "auto" } }));
    expect(f.db.prepare("SELECT mode FROM node_permission_selections").get()).toEqual({ mode: "auto" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 }); expect(f.calls).toEqual([]);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM events").all())).not.toContain(f.env.ANTHROPIC_API_KEY);
  });
  it("不会仅因 daemon 可执行文件的词汇更新就尝试使用它", async () => {
    const f = fixture(); vi.stubEnv("PATH", f.daemonBin);
    vi.mocked(execFile).mockImplementation(((file: string, _args: string[], _options: any, done: any) => {
      done(null, file === f.executable ? '--permission-mode <mode> (choices: "acceptEdits")' : help);
    }) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledOnce(); expect(f.db.prepare("SELECT * FROM node_permission_selections").all()).toEqual([]);
  });
  it.each(["generation", "binding", "cwd", "environment", "binary", "symlink"])("help 期间发生 %s 替换时拒绝，且无选择/审计副作用", async kind => {
    const f = fixture();
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: any, done: any) => {
      if (kind === "generation") f.db.exec("INSERT INTO occupant_tenures VALUES ('node','generation-2',2)");
      if (kind === "binding") f.db.exec("UPDATE bindings SET tmux_pane='%2'");
      if (kind === "cwd") f.db.prepare("UPDATE nodes SET cwd=?").run(f.root);
      if (kind === "environment") f.env.CLAUDE_CONFIG_DIR = "./elsewhere";
      if (kind === "binary") writeFileSync(f.executable, "changed executable bytes");
      if (kind === "symlink") { renameSync(f.executable, f.executable + ".retained"); symlinkSync(path.join(f.daemonBin, "claude"), f.executable); }
      done(null, help);
    }) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledOnce();
    expect(f.db.prepare("SELECT * FROM node_permission_selections").all()).toEqual([]); expect(f.db.prepare("SELECT * FROM events").all()).toEqual([]);
  });
  it.each(["timeout", "malformed", "missing"])("拒绝 %s 支持且不回退", async kind => {
    const f = fixture();
    if (kind === "missing") f.env.PATH = "/intentionally/missing";
    else vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => done(kind === "timeout" ? Error("timeout") : null, "no vocabulary")) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false }); expect(f.db.prepare("SELECT * FROM events").all()).toEqual([]);
  });
  it("保留 floor/full_bypass/inherit 且不探测", async () => {
    const f = fixture(); for (const mode of ["floor", "full_bypass", "inherit"]) expect(await f.service.setPermissions({ ...input, mode })).toMatchObject({ ok: true });
    expect(execFile).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it("help 尚未返回时冻结选择意图", async () => {
    const f = fixture(); const request = { ...input };
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => { request.mode = "full_bypass"; request.actor = "changed"; done(null, help); }) as any);
    expect(await f.service.setPermissions(request)).toMatchObject({ ok: true, to: { mode: "auto" } });
    expect(f.db.prepare("SELECT mode,actor FROM node_permission_selections").get()).toEqual({ mode: "auto", actor: "operator" });
  });
});

describe("S03 跨现有路径的绑定启动", () => {
  it.each(["fresh", "resume", "fork", "legacy"])("在 %s 路径使用相同上下文，并引用每个参数", async kind => {
    const f = fixture(); vi.spyOn(f.adapter as any, "pollForResumeToken").mockResolvedValue("fork-id");
    vi.spyOn(f.adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    const resume = new ClaudeResumeAdapter(f.tmux, { claudeManagedLaunch: f.managed });
    vi.spyOn(resume as any, "verifyResume").mockResolvedValue({ ok: true });
    const token = "history's id; literal";
    const result = kind === "legacy" ? await resume.resume("seat", "claude_id", token, f.cwd, "floor", f.binding.model, "auto", "node")
      : await f.adapter.launchHarness(f.binding, { name: "seat; literal", ...(kind === "resume" ? { resumeToken: token } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } } : {}) });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, appliedLaunch: { reason: "emitted_launch_arguments" } });
    expect(f.calls).toHaveLength(1); const cmd = f.calls[0]!;
    expect(cmd).toContain("/usr/bin/env -i"); expect(cmd).toContain("'--permission-mode' 'auto'");
    expect(cmd).toContain("'OPENRIG_OCCUPANT_GENERATION=generation-1'"); expect(cmd).toContain("'model'\"'\"'s choice'");
    expect(cmd).toContain('"ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}"'); expect(cmd).not.toContain(f.env.ANTHROPIC_API_KEY);
    expect(cmd).toContain("'" + f.executable.replaceAll("'", "'\"'\"'") + "'");
    if (kind !== "fresh") expect(cmd).toContain("'history'\"'\"'s id; literal'");
    expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled(); expect(execFile).toHaveBeenCalledOnce();
  });
  it("重新检查后续 generation 支持，而不是复用成功的选择证据", async () => {
    const f = fixture(); expect(await f.service.setPermissions(input)).toMatchObject({ ok: true });
    f.db.exec("INSERT INTO occupant_tenures VALUES ('node','generation-2',2)");
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => done(null, '--permission-mode <mode> (choices: "acceptEdits")')) as any);
    expect(await f.adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledTimes(2); expect(f.calls).toEqual([]);
    expect(f.db.prepare("SELECT mode FROM node_permission_selections").get()).toEqual({ mode: "auto" });
  });
  it("绑定后继的预留 generation，同时守卫尚未提交的当前任期", async () => {
    const f = fixture(); await f.adapter.launchHarness({ ...f.binding, launchGeneration: "reserved-next" }, { name: "seat" });
    expect(f.calls[0]).toContain("'OPENRIG_OCCUPANT_GENERATION=reserved-next'");
    expect(f.db.prepare("SELECT generation_uuid FROM occupant_tenures").get()).toEqual({ generation_uuid: "generation-1" });
  });
  it("仅从绑定的配置根捕获 fork token，并保留调用入口参数", async () => {
    const f = fixture(); const reads: string[] = [];
    const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, claudeManagedLaunch: f.managed, fsOps: { ...fsOps,
      homedir: "/different/daemon/home", exists: p => p === path.join(f.cwd,"config","sessions"), readdir: () => ["token.json"],
      readFile: p => { reads.push(p); return JSON.stringify({ name: "original", sessionId: "new-fork-token" }); } } });
    const opts = { name: "original", forkSource: { kind: "native_id" as const, value: "original-parent" } };
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => {
      f.binding.tmuxSession = "other-seat"; f.binding.model = "other-model"; f.binding.permissionMode = "bypassPermissions";
      opts.name = "changed"; opts.forkSource.value = "other-history"; done(null, help);
    }) as any);
    expect(await adapter.launchHarness(f.binding, opts)).toMatchObject({ ok: true, resumeToken: "new-fork-token" });
    expect(reads).toEqual([path.join(f.cwd,"config","sessions","token.json")]);
    expect(f.calls[0]).toContain("'--resume' 'original-parent'"); expect(f.calls[0]).toContain("'--name' 'original'");
    expect(f.calls[0]).not.toContain("other-history"); expect(f.calls[0]).not.toContain("other-model");
  });
  it.each(["pane", "generation"])("在 help 或输入前拒绝缺失的 %s", async missing => {
    const f = fixture(); f.db.exec(missing === "pane" ? "UPDATE bindings SET tmux_pane=NULL" : "DELETE FROM occupant_tenures");
    expect(await f.adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(execFile).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it.each(["payload-generation", "buffer-generation", "payload-binary", "buffer-environment"])("在粘贴或按 Enter 前，于实际 TmuxAdapter %s await 处重新校验", async condition => {
    const f = fixture(); const commands: string[] = []; let writes = 0;
    const [phase, kind] = condition.split("-");
    const change = () => { if (kind === "binary") writeFileSync(f.executable, "replacement bytes");
      else if (kind === "environment") f.env.HOME = "/different/managed/home";
      else f.db.exec("UPDATE occupant_tenures SET generation_uuid='changed'"); };
    const t = new TmuxAdapter(async cmd => { commands.push(cmd); if (phase === "buffer" && cmd.includes("load-buffer")) change(); return ""; }, {
      tmpName: () => path.join(f.root, `script-${writes}`), bufferName: () => "private",
      writeFile: async () => { writes++; if (phase === "payload" && writes === 2) change(); }, unlink: async () => {} });
    const adapter = new ClaudeCodeAdapter({ tmux: t, fsOps, claudeManagedLaunch: f.managed });
    expect(await adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(commands.some(cmd => cmd.includes("paste-buffer") || cmd.includes("send-keys"))).toBe(false);
  });
  it("生产 startup 向两个适配器提供同一个辅助对象，而无需调用 startup", () => {
    const startup = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain("new ClaudeManagedLaunch(db, { ...launchSessionEnv, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },");
    expect(startup).toContain("new ClaudeResumeAdapter(tmuxAdapter, { claudeManagedLaunch })");
    expect(startup).toContain("new ClaudeCodeAdapter({ tmux: tmuxAdapter, claudeManagedLaunch,");
  });
  it("有效粘贴后若上下文变化则不提交；保留部分输入语义", async () => {
    const f = fixture(); const commands: string[] = [];
    const t = new TmuxAdapter(async cmd => { commands.push(cmd); if (cmd.includes("paste-buffer")) f.env.CLAUDE_CONFIG_DIR = "./changed"; return ""; }, {
      tmpName: () => path.join(f.root,"inert-script"), bufferName: () => "private", writeFile: async () => {}, unlink: async () => {} });
    const result = await new ClaudeCodeAdapter({ tmux: t, fsOps, claudeManagedLaunch: f.managed }).launchHarness(f.binding, { name: "seat" });
    expect(result).toMatchObject({ ok: false }); expect(commands.some(c => c.includes("paste-buffer"))).toBe(true);
    expect(commands.some(c => c.includes("send-keys") && c.includes("Enter"))).toBe(false);
  });
});
