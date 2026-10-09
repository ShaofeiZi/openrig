import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CodexThreadIdResolver, lstartToMinTs } from "../src/domain/codex-thread-id.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity = "Sun Sep  6 23:52:32 2026";
const start = lstartToMinTs(identity)!;
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-first-turn-")); roots.push(home);
  fs.mkdirSync(path.join(home, ".codex"));
  const logs = new Database(path.join(home, ".codex/logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
  const state = new Database(path.join(home, ".codex/state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
  return {
    home,
    log: (id: string, ts = start + 1, pid = 60422) => logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)").run(ts, `pid:${pid}:native-process`, id),
    thread: (id: string, source = "cli") => state.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, source, `${home}/${id}.jsonl`),
    finish: () => { logs.close(); state.close(); return new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: () => home }); },
  };
}

describe("原生 conversation identity 排除同进程辅助 thread", () => {
  it("title 生成是最新日志活动时仍解析第一个原生 conversation", async () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation"); f.log("title", start + 2);
    expect(await f.finish().resolve(60422, identity)).toBe("conversation");
  });

  it.each(["无 conversation", "无关进程", "退役 pid", "有歧义的启动秒", "非 CLI thread", "两个 conversation"])("拒绝%s，而不选择最近 rollout", async kind => {
    const f = fixture();
    if (kind !== "无 conversation") f.thread("conversation", kind === "非 CLI thread" ? "exec" : "cli");
    f.log("conversation", kind === "退役 pid" ? start - 1 : kind === "有歧义的启动秒" ? start : start + 1,
      kind === "无关进程" ? 99999 : 60422);
    if (kind === "两个 conversation") { f.thread("second"); f.log("second", start + 2); }
    f.log("title", start + 3);
    expect(await f.finish().resolve(60422, identity)).toBeUndefined();
  });
});
