import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";

// Slice-04（OPR.0.5.0.4）seam C1——codex-auth 磁盘上的 daemon-local、
// secret-safe 读取器
// contract ($CODEX_HOME||~/.codex : auth-profiles/*.json names + auth-seat-registry.tsv 6-col).
// daemon 不能 import packages/cli；此重读同一已记录格式。它仅读 profile
// 名称与 TSV——绝不读 profile 文件内容（其中含 token 类材料）。

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  fs.mkdirSync(path.join(dir, "auth-profiles"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, contents: unknown): void {
  fs.writeFileSync(path.join(dir, "auth-profiles", `${name}.json`), JSON.stringify(contents));
}
function writeRegistry(rows: string[][]): void {
  const header = ["seat", "rig", "runtime", "cwd", "auth_profile", "updated_ts"].join("\t");
  const body = rows.map((r) => r.join("\t")).join("\n");
  fs.writeFileSync(path.join(dir, "auth-seat-registry.tsv"), `${header}\n${body}\n`);
}

describe("readCodexAuthMetadata —— 后台服务本地且密钥安全", () => {
  it("列出并排序配置名称，解析 6 列席位注册表", () => {
    writeProfile("beta", { OPENAI_API_KEY: "sk-SECRET-TOKEN-must-never-surface" });
    writeProfile("alpha", { OPENAI_API_KEY: "sk-ANOTHER-SECRET" });
    writeRegistry([
      ["seat-1", "rig-a", "codex", "/w/a", "alpha", "2026-08-03T12:00:00.000Z"],
      ["seat-2", "rig-a", "codex", "/w/b", "beta", "2026-08-03T11:00:00.000Z"],
    ]);

    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    expect(meta.profiles).toEqual(["alpha", "beta"]); // sorted names, no .json
    expect(meta.seats).toHaveLength(2);
    const s1 = meta.seats.find((s) => s.seat === "seat-1");
    expect(s1).toMatchObject({ seat: "seat-1", rig: "rig-a", runtime: "codex", authProfile: "alpha", updatedTs: "2026-08-03T12:00:00.000Z" });
  });

  it("绝不呈现配置文件中的令牌类内容（只读取名称）", () => {
    writeProfile("alpha", { OPENAI_API_KEY: "sk-SECRET-TOKEN-must-never-surface", access_token: "tok-DEADBEEF" });
    writeRegistry([["seat-1", "rig-a", "codex", "/w/a", "alpha", "2026-08-03T12:00:00.000Z"]]);

    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("sk-SECRET-TOKEN");
    expect(serialized).not.toContain("tok-DEADBEEF");
    expect(serialized).not.toContain("access_token");
    expect(meta.profiles).toEqual(["alpha"]);
  });

  it("Codex home 或文件缺失时返回空结果且不抛错", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codexempty-"));
    try {
      const meta = readCodexAuthMetadata({ CODEX_HOME: empty } as NodeJS.ProcessEnv);
      expect(meta.profiles).toEqual([]);
      expect(meta.seats).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("跳过列数错误的畸形注册表记录，而不伪造字段", () => {
    fs.writeFileSync(
      path.join(dir, "auth-seat-registry.tsv"),
      ["seat\trig\truntime\tcwd\tauth_profile\tupdated_ts", "seat-1\trig-a\tcodex\t/w/a\talpha\t2026-08-03T12:00:00.000Z", "broken\trow", ""].join("\n"),
    );
    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    expect(meta.seats).toHaveLength(1);
    expect(meta.seats[0].seat).toBe("seat-1");
  });
});
