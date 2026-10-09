import { describe, it, expect } from "vitest";
import {
  BundleAuditWriter,
  BundleAuditReader,
  type BundleAuditFsOps,
  type BundleAuditRecord,
} from "../src/domain/bundle-audit.js";

// 条目 4 / slice-05 Checkpoint 5.1：bundle-audit 单元测试。
// 判别模式：任何断言 append + read 往返的测试，都必须在 writer.append
// 或 reader.list 损坏时失败。

function mockFs(): BundleAuditFsOps & { _state: Map<string, string>; _mkdirpCalls: string[] } {
  const state = new Map<string, string>();
  const mkdirpCalls: string[] = [];
  return {
    _state: state,
    _mkdirpCalls: mkdirpCalls,
    appendFile: (p: string, c: string) => {
      state.set(p, (state.get(p) ?? "") + c);
    },
    readFile: (p: string) => state.get(p) ?? "",
    exists: (p: string) => state.has(p),
    mkdirp: (p: string) => {
      mkdirpCalls.push(p);
    },
  };
}

const FIXTURE_PATH = "/test/.openrig/bundle-audit.jsonl";

function makeWriter(fs: BundleAuditFsOps) {
  return new BundleAuditWriter({ opts: { auditPath: FIXTURE_PATH }, fsOps: fs });
}

function makeReader(fs: BundleAuditFsOps) {
  return new BundleAuditReader({ opts: { auditPath: FIXTURE_PATH }, fsOps: fs });
}

function record(overrides?: Partial<BundleAuditRecord>): BundleAuditRecord {
  return {
    installedAt: "2026-05-18T12:00:00Z",
    bundlePath: "/tmp/test.rigbundle",
    archiveHash: "a".repeat(64),
    targetRigId: "01H000000000000000000001",
    targetRigName: "test-rig",
    sourceHost: "test-host.local",
    daemonVersion: "0.3.2",
    cliVersion: "0.3.2",
    outcome: "success",
    ...overrides,
  };
}

describe("BundleAuditWriter + BundleAuditReader", () => {
  // A1：空文件 → 空列表
  it("读取空审计文件时返回空数组", () => {
    const fs = mockFs();
    const reader = makeReader(fs);
    expect(reader.list()).toEqual([]);
  });

  // A2：append + read 单条记录往返
  it("append + list 可原样往返单条记录", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    const reader = makeReader(fs);
    const r = record();
    writer.append(r);
    const out = reader.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(r);
  });

  // A3：append 创建父目录
  it("首次 append 通过 mkdirp 创建父目录", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record());
    expect(fs._mkdirpCalls.length).toBeGreaterThan(0);
    expect(fs._mkdirpCalls[0]).toBe("/test/.openrig");
  });

  // A4：每条记录占一行 JSONL，并以换行符结尾
  it("每次 append 恰好写入一个 JSON 对象并追加换行符（JSONL 格式）", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ targetRigName: "rig-a" }));
    writer.append(record({ targetRigName: "rig-b" }));
    const raw = fs._state.get(FIXTURE_PATH)!;
    const lines = raw.split("\n");
    // 两条记录 → 两个非空行 + 一个由末尾 \n 产生的空行
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!).targetRigName).toBe("rig-a");
    expect(JSON.parse(lines[1]!).targetRigName).toBe("rig-b");
  });

  // A5：list 按 append 顺序返回记录
  it("list 按 append 顺序返回记录（最早的在前）", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z", targetRigName: "rig-a" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z", targetRigName: "rig-b" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z", targetRigName: "rig-c" }));
    const out = makeReader(fs).list();
    expect(out.map((r) => r.targetRigName)).toEqual(["rig-a", "rig-b", "rig-c"]);
  });

  // A6：rig 过滤器将范围限制到匹配记录
  it("rig 过滤器只返回 targetRigName 匹配的记录", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ targetRigName: "alpha" }));
    writer.append(record({ targetRigName: "beta" }));
    writer.append(record({ targetRigName: "alpha" }));
    const out = makeReader(fs).list({ rig: "alpha" });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.targetRigName === "alpha")).toBe(true);
  });

  // A7：since 过滤器将范围限制到截止时间及之后的记录
  it("since 过滤器只返回 installedAt 大于等于截止时间的记录", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z" }));
    const out = makeReader(fs).list({ since: "2026-05-18T11:00:00Z" });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.installedAt)).toEqual([
      "2026-05-18T11:00:00Z",
      "2026-05-18T12:00:00Z",
    ]);
  });

  // A8：组合 rig + since 过滤器
  it("rig + since 过滤器同时生效（AND 语义）", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z", targetRigName: "alpha" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z", targetRigName: "beta" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z", targetRigName: "alpha" }));
    const out = makeReader(fs).list({ rig: "alpha", since: "2026-05-18T11:00:00Z" });
    expect(out).toHaveLength(1);
    expect(out[0]!.installedAt).toBe("2026-05-18T12:00:00Z");
  });

  // A9：静默跳过格式错误的行（向前兼容）
  it("静默跳过格式错误的 JSONL 行，同时仍返回有效行", () => {
    const fs = mockFs();
    fs._state.set(FIXTURE_PATH, [
      JSON.stringify(record({ targetRigName: "a" })),
      "not-valid-json{",
      JSON.stringify(record({ targetRigName: "b" })),
    ].join("\n") + "\n");
    const out = makeReader(fs).list();
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.targetRigName)).toEqual(["a", "b"]);
  });

  // A10：原样保留 outcome 字段（success / failed / partial）
  it("outcome 字段的三个值均可往返", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ outcome: "success", targetRigName: "ok" }));
    writer.append(record({ outcome: "failed", targetRigName: "bad" }));
    writer.append(record({ outcome: "partial", targetRigName: "halfway" }));
    const out = makeReader(fs).list();
    expect(out.map((r) => r.outcome)).toEqual(["success", "failed", "partial"]);
  });
});
