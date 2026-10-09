// OPR.0.4.1.09——压缩后恢复 prompt 绝不能注入其他席位的补充内容（post-compact-extra）。
// 2026-06-20 缺陷：唯一的全局 post-compact-extra.md 保存 advisor-lead@kernel 状态，
// delivery 席位和 pm 席位却都被要求读取它。修复：为当前席位解析补充内容，优先逐席位文件；
// 拒绝明确声明其他席位的全局文件。仍允许通用或未声明席位的补充内容（适用于任意席位）；
// 仅拒绝明确的席位不匹配。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";

function makeSettingsStore(policy: ClaudeCompactionPolicy): SettingsStore {
  return { resolveClaudeCompactionPolicy: vi.fn(() => policy) } as unknown as SettingsStore;
}
function makeSessionTransport() {
  const send = vi.fn(async () => ({ ok: true }));
  return { transport: { send } as unknown as SessionTransport, send };
}
function policyWithExtra(messageFilePath: string): ClaudeCompactionPolicy {
  return {
    enabled: true, thresholdPercent: 80,
    preCompactInstruction: "prep", compactInstruction: "",
    messageInline: "", messageFilePath,
    postRestoreAuditInstruction: "audit",
  };
}
function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "opr0419-")); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } });

// 驱动 prep → /compact → turn_boundary → restore_prompt，并返回恢复 prompt 文本。
async function restorePromptFor(messageFilePath: string, seat: string): Promise<string> {
  const settings = makeSettingsStore(policyWithExtra(messageFilePath));
  const { transport, send } = makeSessionTransport();
  const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
    dedupWindowMs: 60_000, postCompactRestoreCooldownMs: 0, openrigHome: home,
  });
  let now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 90 }); // prep
  now += 61_000;
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 95 }); // /compact
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/t.jsonl" }); // turn_boundary
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/t.jsonl" }); // restore_prompt
  return send.mock.calls[send.mock.calls.length - 1]![1] as string;
}

describe("OPR.0.4.1.09——席位作用域的压缩后补充内容（绝不注入错误席位状态）", () => {
  it("拒绝声明其他席位的全局补充内容（2026-06-20 缺陷）", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n---\nAdvisor restore map: read X, Y, Z.");
    const prompt = await restorePromptFor(globalPath, "dev2-driver@openrig-delivery");
    // 不注入错误席位的文件路径……
    expect(prompt).not.toContain(globalPath);
    expect(prompt).not.toContain("附加压缩后指令文件");
    // ……并告知席位该文件已被忽略。
    expect(prompt).toContain("声明不同席位");
    expect(prompt).toContain("现已忽略");
  });

  it("优先注入逐席位补充内容 compaction/post-compact-extra/<seat>.md，而非全局内容", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: someone-else@rig\n---\nnot mine");
    const seat = "dev2-driver@openrig-delivery";
    const perSeatPath = path.join(home, "compaction", "post-compact-extra", `${seat}.md`);
    writeFile(perSeatPath, "my own restore extra");
    const prompt = await restorePromptFor(globalPath, seat);
    expect(prompt).toContain(perSeatPath);
    expect(prompt).not.toContain(globalPath); // the wrong-seat global is not used
  });

  it("允许未声明席位的通用全局补充内容（适用于任意席位）", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "Generic operator note for all seats: prefer rig queue list --as you.");
    const prompt = await restorePromptFor(globalPath, "dev2-driver@openrig-delivery");
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("附加压缩后指令文件");
  });

  it("允许声明当前席位的全局补充内容", async () => {
    const seat = "dev2-driver@openrig-delivery";
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, `---\ntarget_seat: ${seat}\n---\nmine`);
    const prompt = await restorePromptFor(globalPath, seat);
    expect(prompt).toContain(globalPath);
  });
});

// rev1-r2（42654c58 blocker）：只有格式正确、以 `---` 开启并闭合的前置 frontmatter
// 中的席位声明才具权威性。正文绝不扫描，因此 `---` fence 损坏或只在正文提及 "seat:"
// 的通用操作人员补充内容仍必须注入，不能误判为其他席位声明并在恢复路径中静默抑制。
// 对格式正确的其他席位声明仍保持拒绝。
describe("OPR.0.4.1.09——rev1-r2 回归：仅格式正确的 frontmatter 可声明席位", () => {
  const SEAT = "dev2-driver@openrig-delivery";

  it("(1) 注入 frontmatter 畸形（以 `---` 开头但未闭合）且正文含疑似其他席位 seat: 行的补充内容", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    // frontmatter 已开启但没有闭合 `---`，因此格式不正确，按通用内容注入。
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n# missing closing delimiter\nGeneric restore instructions for any seat.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("附加压缩后指令文件");
    expect(prompt).not.toContain("现已忽略");
    expect(prompt).not.toContain("声明不同席位");
  });

  it("(2) 注入正文含 'seat:' 行但无 frontmatter 的通用补充内容（绝不扫描正文）", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "Operator note for all seats: ask the seat: advisor-lead@kernel for the dashboard link.\nGeneric guidance.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("附加压缩后指令文件");
    expect(prompt).not.toContain("现已忽略");
    expect(prompt).not.toContain("声明不同席位");
  });

  it("(3) 拒绝格式正确但声明其他席位的 frontmatter（保留防污染约束）", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n---\nNot this seat's state.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).not.toContain(globalPath);
    expect(prompt).not.toContain("附加压缩后指令文件");
    expect(prompt).toContain("声明不同席位");
    expect(prompt).toContain("现已忽略");
  });

  it("(4) 注入格式正确且声明当前席位的 frontmatter", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, `---\ntarget_seat: ${SEAT}\n---\nmine`);
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("附加压缩后指令文件");
    expect(prompt).not.toContain("现已忽略");
  });
});
