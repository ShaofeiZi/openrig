// OPR.0.4.4.11——hosts-registry reader（共享 P3/P4 接口单元）。
//
// PARITY DISCIPLINE（scope-audit 双生模式，也是 slice-20 MISSION_BRIEF_HEADERS 遗漏所展示的精确漂移类型）：
// daemon reader 有意镜像 packages/cli/src/host-registry.ts（架构裁定 3——本切片不改 CLI 副本，也不统一）。
// 这些共享 fixture 会经过两个 validator，且每项结论都必须一致；此处若有差异，说明其中一个副本已漂移。

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostRegistry,
  validateHostRegistry as daemonValidate,
  resolveHost,
  resolvePlacementHost,
} from "../src/domain/hosts/hosts-registry-reader.js";
import { validateHostRegistry as cliValidate } from "../../cli/src/host-registry.js";

const SRC = "/fixture/hosts.yaml";

const SHARED_FIXTURES: Array<{ label: string; parsed: unknown; ok: boolean }> = [
  {
    label: "有效：一个 ssh + 一个 http（bearer_env）",
    parsed: { hosts: [
      { id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin" },
      { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" },
    ] },
    ok: true,
  },
  { label: "有效：带 bearer_file 的 http", parsed: { hosts: [{ id: "h", transport: "http", url: "http://h:7433", bearer_file: "/tmp/tok" }] }, ok: true },
  { label: "有效：空 hosts 数组", parsed: { hosts: [] }, ok: true },
  { label: "无效：不是对象", parsed: "nope", ok: false },
  { label: "无效：hosts 不是数组", parsed: { hosts: {} }, ok: false },
  { label: "无效：ID 重复", parsed: { hosts: [{ id: "x", transport: "ssh", target: "a" }, { id: "x", transport: "ssh", target: "b" }] }, ok: false },
  { label: "无效：未知 transport", parsed: { hosts: [{ id: "x", transport: "carrier-pigeon", target: "a" }] }, ok: false },
  { label: "无效：ssh 缺少 target", parsed: { hosts: [{ id: "x", transport: "ssh" }] }, ok: false },
  { label: "无效：http 缺少 url", parsed: { hosts: [{ id: "x", transport: "http", bearer_env: "T" }] }, ok: false },
  { label: "有效：http 不带 bearer（匿名/无 token daemon）", parsed: { hosts: [{ id: "x", transport: "http", url: "http://x" }] }, ok: true },
  { label: "无效：http 同时带两种 bearer（不得同时存在）", parsed: { hosts: [{ id: "x", transport: "http", url: "http://x", bearer_env: "T", bearer_file: "/f" }] }, ok: false },
  { label: "无效：空 ID", parsed: { hosts: [{ id: "  ", transport: "ssh", target: "a" }] }, ok: false },
  // OPR.0.4.6.MH1 FR-7——两个副本都拒绝保留 host ID。
  { label: "无效：保留 ID 'kernel'（与 human-seat 冲突）", parsed: { hosts: [{ id: "kernel", transport: "ssh", target: "a" }] }, ok: false },
  { label: "无效：保留 ID 'host'（与 human-seat 冲突）", parsed: { hosts: [{ id: "host", transport: "ssh", target: "a" }] }, ok: false },
  { label: "无效：保留 ID 'local'（遮蔽 LOCAL_HOST_ID）", parsed: { hosts: [{ id: "local", transport: "http", url: "http://x", bearer_env: "T" }] }, ok: false },
  // M1 A1——两个副本都保留 A2 virtual-domain token（名为 'external' 的 host 会与
  // <local>@external 分类器冲突）。来源为 VIRTUAL_DOMAIN_TOKENS。
  { label: "无效：保留 ID 'external'（M1 A1 virtual-domain token 冲突）", parsed: { hosts: [{ id: "external", transport: "ssh", target: "a" }] }, ok: false },
  // OPR.0.4.6.MH1 rev1-r2 B1——两个副本都拒绝包含路径的 ID
  //（ID 用于命名 credential 文件，配对 token 路径会嵌入该 ID）。
  { label: "无效：路径遍历 ID '../escape'", parsed: { hosts: [{ id: "../escape", transport: "ssh", target: "a" }] }, ok: false },
  { label: "无效：包含斜杠的 ID 'a/b'", parsed: { hosts: [{ id: "a/b", transport: "ssh", target: "a" }] }, ok: false },
  { label: "无效：以点开头的 ID '.hidden'", parsed: { hosts: [{ id: ".hidden", transport: "ssh", target: "a" }] }, ok: false },
  { label: "有效：hostname 形态的 ID 仍可工作", parsed: { hosts: [{ id: "vm-a.local", transport: "ssh", target: "a" }] }, ok: true },
  // Slice 14——可选 join key。只落到一个副本的 schema 修改不会被接受：
  // 这些 fixture 会强制 CLI validator 和 daemon reader 对其达成一致。
  { label: "有效：ssh 条目携带 hostId join key", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "host-84c37990" }] }, ok: true },
  { label: "有效：http 条目携带 hostId join key", parsed: { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", hostId: "host-deadbeef" }] }, ok: true },
  { label: "有效：条目不含 hostId（现有所有条目）", parsed: { hosts: [{ id: "legacy", transport: "http", url: "http://legacy:7433" }] }, ok: true },
  { label: "有效：hostname 形态的 hostId", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "mm2-openrig1.local" }] }, ok: true },
  { label: "无效：空 hostId", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "  " }] }, ok: false },
  { label: "无效：hostId 不是字符串", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: 42 }] }, ok: false },
  { label: "无效：hostId 包含路径 'a/b'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "a/b" }] }, ok: false },
  { label: "无效：hostId 以点开头 '.hidden'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: ".hidden" }] }, ok: false },
  // join key 标识真实机器自身的身份，因此绝不能是非机器 token 之一。首版只对 hostId 应用了格式正则，
  // 因而错误接受了 `local`。
  { label: "无效：保留 hostId 'local'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "local" }] }, ok: false },
  { label: "无效：保留 hostId 'kernel'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "kernel" }] }, ok: false },
  { label: "无效：保留 hostId 'host'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "host" }] }, ok: false },
  { label: "无效：保留 hostId 'external'", parsed: { hosts: [{ id: "vm-a", transport: "http", url: "http://x", hostId: "external" }] }, ok: false },
];

describe("hosts-registry reader——CLI/daemon validator 一致性（共享 fixture）", () => {
  for (const f of SHARED_FIXTURES) {
    it(`与 CLI validator 结论一致：${f.label}`, () => {
      const d = daemonValidate(f.parsed, SRC);
      const c = cliValidate(f.parsed, SRC);
      expect(d.ok).toBe(f.ok);
      expect(c.ok).toBe(f.ok); // 两个副本结论相同
      if (d.ok && c.ok) {
        expect(d.registry).toEqual(c.registry); // 且规范化后的结构相同
      }
    });
  }
});

describe("hosts-registry reader——daemon 行为", () => {
  it("文件缺失时返回规范的 what/why/fix 错误，绝不抛出异常", () => {
    const res = loadHostRegistry("/nonexistent/hosts.yaml");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("在 /nonexistent/hosts.yaml 未找到主机注册表");
  });

  it("从磁盘加载并校验真实文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-reg-"));
    const p = join(dir, "hosts.yaml");
    writeFileSync(p, "hosts:\n  - id: vps-1\n    transport: http\n    url: http://vps-1:7433\n    bearer_env: VPS1_TOKEN\n");
    const res = loadHostRegistry(p);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.registry.hosts[0]).toMatchObject({ id: "vps-1", transport: "http" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("未知 host ID 会指明该 ID 并列出已知 ID（FR-4 每条目消息）", () => {
    const reg = { hosts: [{ id: "a", transport: "ssh" as const, target: "a.local" }] };
    const res = resolveHost(reg, "nope");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("未知主机 ID 'nope'");
      expect(res.error).toContain("已知主机 ID：a");
    }
  });

  it("placement 解析使用 remote-up 修复消息拒绝 ssh-transport host（镜像 runRemoteHttpOp 的已发布拒绝逻辑，在校验时显现）", () => {
    const reg = {
      hosts: [
        { id: "ssh-host", transport: "ssh" as const, target: "x.local" },
        { id: "http-host", transport: "http" as const, url: "http://y:7433", bearer_env: "T" },
      ],
    };
    const sshRes = resolvePlacementHost(reg, "ssh-host");
    expect(sshRes.ok).toBe(false);
    if (!sshRes.ok) expect(sshRes.error).toContain("无法承载远程工作组启动");
    expect(resolvePlacementHost(reg, "http-host").ok).toBe(true);
  });
});
