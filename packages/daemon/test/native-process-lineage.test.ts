import { describe, expect, it, vi } from "vitest";
import { findExactNativeResumeProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const token = "00000000-0000-7000-8000-000000000001";
const startedAt = "Sat Jan  1 12:00:00 2000";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `/opt/native/codex -p resume resume --add-dir /tmp/state ${token}`, startedAt },
  ];
}
const check = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyCodexPaneProcess({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: token, requireResume: true, ...overrides,
});

describe("已连接的 native Codex identity", () => {
  it("选择唯一 native process，而非其 Node wrapper", async () => {
    expect((await check(rows))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(rows(), 10, "codex", token)?.pid).toBe(13);
  });
  it("证明 direct-native resume", async () => {
    expect((await check(() => [{ ...rows()[3]!, pid: 10, ppid: 1 }]))?.process.pid).toBe(10);
  });
  it("区分 fresh/non-strict runtime proof 与 exact resume", async () => {
    const fresh = () => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex -m model" } : r);
    expect(await check(fresh)).toBeNull();
    expect(await check(fresh, { requireResume: false })).not.toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(rows, { requireResume: true, expectedToken: null })).toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: null })).toBeNull();
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex resume --last" } : r), { requireResume: false, expectedToken: null })).toBeNull();
  });
  const controls: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["错误 UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume other" } : x)],
    ["缺少 UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume" } : x)],
    ["token 仅在 prompt 中", r => r.map(x => x.pid === 13 ? { ...x, command: `/opt/native/codex resume other ${token}` } : x)],
    ["错误 OS executable", r => r.map(x => x.pid === 13 ? { ...x, executableName: "printf" } : x)],
    ["仅 argv 中含 executable", r => r.map(x => x.pid === 13 ? { ...x, command: `/bin/echo codex resume ${token}` } : x)],
    ["无关 descendant", r => r.map(x => x.pid === 13 ? { ...x, ppid: 999 } : x)],
    ["后台 native process", r => r.map(x => x.pid === 13 ? { ...x, pgid: 99 } : x)],
    ["冲突 foreground", r => r.map(x => x.pid === 13 ? { ...x, tpgid: 99 } : x)],
    ["缺少 root", r => r.slice(1)],
    ["缺少 ancestry", r => r.filter(x => x.pid !== 11)],
    ["循环 ancestry", r => r.map(x => x.pid === 11 ? { ...x, ppid: 13 } : x)],
    ["多个 native candidate", r => [...r, { ...r[3]!, pid: 14 }]],
    ["重复 PID", r => [...r, r[3]!]],
    ["缺少 start time", r => r.map(x => ({ ...x, startedAt: undefined }))],
    ["缺少 group", r => r.map(x => ({ ...x, tpgid: undefined }))],
    ["已退出 native process", r => r.filter(x => x.pid !== 13)],
  ];
  it.each(controls)("拒绝 %s", async (_name, mutate) => {
    expect(await check(() => mutate(rows()))).toBeNull();
  });
  it.each(["startedAt", "command", "ppid", "pgid"] as const)("拒绝两次 observation 之间变化的 native %s", async (field) => {
    const changed = rows().map(r => r.pid === 13 ? { ...r, [field]: field === "startedAt" ? "Sat Jan  1 12:00:01 2000" : field === "command" ? r.command + " --verbose" : 99 } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("即使 native PID 未变，也拒绝复用的 pane PID", async () => {
    const changed = rows().map(r => r.pid === 10 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("拒绝已变化或缺失的 pane，以及 process observation failure", async () => {
    expect(await check(rows, { tmux: { getPanePid: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11) } })).toBeNull();
    expect(await check(rows, { tmux: { getPanePid: async () => null } })).toBeNull();
    expect(await check(async () => { throw new Error("ps failed"); })).toBeNull();
  });
  it("保留既有 Claude exact-token contract", () => {
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: `claude --resume ${token}` }], 10, "claude-code", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: "claude --resume wrong" }], 10, "claude-code", token)).toBeNull();
  });
});
