import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";
import { buildAttentionResponse } from "../../daemon/src/routes/up.js";

const attentionNodes = [
  { logicalId: "dev.owner", sessionName: "dev-owner@first", reason: "update_gate", evidence: "Update available!" },
  { logicalId: "dev.checker", sessionName: "dev-checker@first", reason: "returned_to_shell", evidence: "$" },
];
function attentionBody() {
  const result = { rigId: "first", stages: [{ stage: "import_rig", status: "blocked",
    detail: { code: "attention_required", message: "2 members need attention.", attentionNodes } }] };
  return { ...result, ...buildAttentionResponse(result)! };
}

// 执行真实命令与后台服务响应构建器；注入 transport/lifecycle。
// 不启动 listener、后台服务、tmux 或 provider 进程。
async function render(data: Record<string, unknown>, status = 409, json = false) {
  const oldExit = process.exitCode;
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...s) => { out.push(s.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...s) => { err.push(s.join(" ")); });
  const forbidden = () => { throw new Error("unexpected lifecycle operation"); };
  const lifecycleDeps = {
    spawn: forbidden, kill: forbidden, writeFile: forbidden, removeFile: forbidden,
    mkdirp: forbidden, openForAppend: forbidden,
    fetch: async () => ({ ok: true }), isProcessAlive: () => true,
    exists: (p: string) => p === STATE_FILE,
    readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 12345, db: "mock", startedAt: "2000-01-01" }) : null,
  } as LifecycleDeps;
  const client = { get: vi.fn(async () => ({ status: 200, data: [] })),
    post: vi.fn(async () => ({ status, data })) };
  process.exitCode = undefined;
  try {
    const cmd = new Command().exitOverride().addCommand(upCommand({
      lifecycleDeps, clientFactory: () => client as unknown as DaemonClient,
      preflightExec: forbidden,
    }));
    await cmd.parseAsync(["node", "rig", "up", "first-project", ...(json ? ["--json"] : [])]);
    expect(client.post).toHaveBeenCalledTimes(1);
    return { out: out.join("\n"), err: err.join("\n"), exit: process.exitCode };
  } finally { process.exitCode = oldExit; log.mockRestore(); error.mockRestore(); }
}

describe("启动待关注指导", () => {
  it("渲染真实结构化响应及所有受影响成员，且不提供 spec 建议", async () => {
    const body = attentionBody();
    const r = await render(body);
    expect(r.err).toContain(`错误：${body.error.fact}`);
    expect(r.err).toContain(body.error.consequence);
    expect(r.err).toContain(body.error.action);
    for (const n of attentionNodes) {
      expect(r.err).toContain(n.logicalId);
      expect(r.err).toContain(n.sessionName);
      expect(r.err).toContain(n.reason);
    }
    expect(r.err).not.toMatch(/\[object Object\]|validate your spec|Sessions are running|answering it.*completes/);
    expect(r.out).toContain("import_rig: blocked");
    expect(r.exit).toBe(1);
  });
  it("后台服务指导不假定存在信任提示或实时运行时", () => {
    const { error } = attentionBody();
    expect(error.consequence).toContain("attention_required");
    expect(error.consequence).toContain("尚未被证明可交互");
    expect(error.action).toContain("检查");
    expect(error.action).not.toMatch(/回答.*提示|已停放会话/);
  });
  it.each([409, 500])("为 HTTP %i 保留精确 JSON 正文和退出码", async (status) => {
    const data = attentionBody();
    const r = await render(data, status, true);
    expect(r.out).toBe(JSON.stringify(data));
    expect(r.err).toBe("");
    expect(r.exit).toBe(status === 409 ? 1 : 2);
  });
  it.each([409, 500])("为 HTTP %i 保留字符串回退和退出码", async (status) => {
    const r = await render({ error: "agent_ref resolution failed", stages: [] }, status);
    expect(r.err).toContain(`启动失败：agent_ref resolution failed（HTTP ${status}）`);
    expect(r.err).toContain("local: agent_ref 路径相对于");
    expect(r.exit).toBe(status === 409 ? 1 : 2);
  });
});
