import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryQuery, extractKeywords, type ExecDep } from "../src/domain/history-query.js";

describe("HistoryQuery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "history-query-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("extractKeywords", () => {
    it("拆分问题、过滤停用词和短词，并转义正则字符", () => {
      const kw = extractKeywords("What is the deployment strategy?");
      // "What"、"is"、"the" 都是停用词。
      expect(kw).toContain("deployment");
      expect(kw).toContain("strategy");
      expect(kw).not.toContain("What");
      expect(kw).not.toContain("is");
      expect(kw).not.toContain("the");
    });

    it("过滤短于 3 个字符的词", () => {
      const kw = extractKeywords("go to db and fix it");
      // "go"、"to"、"db"、"it" 均为 2 个字符。
      // "and" 是停用词，"fix" 保留。
      expect(kw).toContain("fix");
      expect(kw).not.toContain("go");
      expect(kw).not.toContain("to");
      expect(kw).not.toContain("db");
    });

    it("转义正则特殊字符", () => {
      const kw = extractKeywords("search for file.ts and (pattern)");
      const escaped = kw.find((k) => k.includes("file"));
      expect(escaped).toBe("file\\.ts");
      const parenEscaped = kw.find((k) => k.includes("pattern"));
      expect(parenEscaped).toBe("\\(pattern\\)");
    });

    it("问题全部由停用词组成时返回空数组", () => {
      const kw = extractKeywords("what is the");
      expect(kw).toEqual([]);
    });

    it("对关键词去重", () => {
      const kw = extractKeywords("deploy deploy deploy strategy");
      const deployCount = kw.filter((k) => k === "deploy").length;
      expect(deployCount).toBe(1);
    });
  });

  describe("search", () => {
    it("使用 rg 后端搜索 transcript", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "dev-impl.log"), "line1 deployment started\nline2 nothing\nline3 deployment done\n");

      const exec: ExecDep = vi.fn(async (_cmd: string, _args: string[]) => ({
        stdout: "line1 deployment started\nline3 deployment done\n",
        exitCode: 0,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "what about deployment?");

      expect(result.backend).toBe("rg");
      expect(result.excerpts.length).toBeGreaterThan(0);
      expect(exec).toHaveBeenCalled();
      const call = (exec as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("rg");
    });

    it("rg 以 >=2 退出时（未找到）回退到 grep", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "test error handling\n");

      let callCount = 0;
      const exec: ExecDep = vi.fn(async (cmd: string, _args: string[]) => {
        callCount++;
        if (callCount === 1) {
          // rg 以错误码 2 失败。
          expect(cmd).toBe("rg");
          return { stdout: "", exitCode: 2 };
        }
        // grep 回退。
        expect(cmd).toBe("grep");
        return { stdout: "test error handling\n", exitCode: 0 };
      });

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "error handling");

      expect(result.backend).toBe("grep");
      expect(callCount).toBe(2);
    });

    it("rg 退出码为 1（无匹配）时不返回摘录", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "unrelated content\n");

      const exec: ExecDep = vi.fn(async () => ({
        stdout: "",
        exitCode: 1,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment strategy");

      expect(result.excerpts).toEqual([]);
      expect(result.insufficient).toBe(true);
    });

    it("关键词为空时返回 insufficient", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });

      const exec: ExecDep = vi.fn();

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "what is the");

      expect(result.insufficient).toBe(true);
      expect(result.excerpts).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it("transcript 目录不存在时返回 insufficient", async () => {
      const exec: ExecDep = vi.fn();

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("nonexistent-rig", "some query");

      expect(result.insufficient).toBe(true);
      expect(result.noTranscriptDir).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    });

    it("rg 与 grep 均失败（退出码 >=2）时返回错误", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "dev.log"), "some content\n");

      const exec: ExecDep = vi.fn(async () => ({ stdout: "", exitCode: 2 }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment strategy");

      expect(result.insufficient).toBe(true);
      expect(result.backend).toBe("none");
      expect(result.error).toContain("均失败");
    });

    it("从摘录中移除 ANSI", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "content\n");

      const exec: ExecDep = vi.fn(async () => ({
        stdout: "\x1b[1mdeployment\x1b[0m started\n\x1b[32mdeployment\x1b[0m finished\n",
        exitCode: 0,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment status");

      for (const excerpt of result.excerpts) {
        expect(excerpt).not.toContain("\x1b[");
      }
      expect(result.excerpts).toContain("deployment started");
      expect(result.excerpts).toContain("deployment finished");
    });
  });
});
