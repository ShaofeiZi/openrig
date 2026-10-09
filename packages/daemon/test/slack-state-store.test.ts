import { describe, it, expect } from "vitest";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";

// 内存 FS fake——模拟 append/write/read + 固定时钟，无真实磁盘。
function memFs(): StateFsOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync(p: string) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p)!;
    },
    appendFileSync(p: string, d: string) {
      files.set(p, (files.get(p) ?? "") + d);
    },
    writeFileSync(p: string, d: string) {
      files.set(p, d);
    },
    rename(from: string, to: string) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp() {
      /* 内存中 no-op */
    },
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");

describe("Slice-11 SeenStore——持久 delivery-dedup（item 2）", () => {
  it("文件不存在时 load() 为空", () => {
    const fsx = memFs();
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().size).toBe(0);
  });

  it("mark() 后 load() 看到 id；SURVIVE 重启（新实例，同一 fs）", () => {
    const fsx = memFs();
    new SeenStore("/s/seen.jsonl", fsx, clock).mark("qitem-1", "posted");
    // 新实例 == process/daemon 重启；读同一持久文件
    const reloaded = new SeenStore("/s/seen.jsonl", fsx, clock).load();
    expect(reloaded.has("qitem-1")).toBe(true);
    expect(reloaded.size).toBe(1);
  });

  it("在 load() 中对重复 id 去重（byte 一致的 re-append 坍缩为一）", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    s.mark("qitem-1", "posted");
    s.mark("qitem-1", "posted"); // crash 窗口重复 re-delivery，byte 一致
    expect(s.load().size).toBe(1);
    // 两行 byte 一致（同 id、同固定时钟、同 status）
    const lines = fsx.files.get("/s/seen.jsonl")!.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(lines[1]);
  });

  it("容忍撕裂的末行（append 中途崩）而不掉好记录", () => {
    const fsx = memFs();
    fsx.files.set("/s/seen.jsonl", JSON.stringify({ id: "ok", ts: "t", status: "posted" }) + "\n" + '{"id":"tor');
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().has("ok")).toBe(true);
  });

  it("seed() 把 id 标为 history 而无副作用（item 9 backlog，零 replay 风暴）", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    expect(s.seed(["a", "b", "c"])).toBe(3);
    const set = s.load();
    expect(set.has("a") && set.has("b") && set.has("c")).toBe(true);
    expect(fsx.files.get("/s/seen.jsonl")!.includes('"status":"seeded"')).toBe(true);
  });
});

describe("Slice-11 DeadLetterStore——入站 never-drop、中断安全（item 8，B2）", () => {
  it("append() 持久化 attempt 计数条目，跨重启存活", () => {
    const fsx = memFs();
    new DeadLetterStore("/s/dead.jsonl", fsx, clock).append({ ts: "1.1" }, 1);
    const all = new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.attempts).toBe(1);
    expect((all[0]!.ev as { ts: string }).ts).toBe("1.1");
  });

  it("B2：readAll() 非破坏性——read 后 replaceAll 前崩溃不掉任何东西", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    const before = fsx.files.get("/s/dead.jsonl");
    const read = d.readAll(); // 开始一轮 retry…
    expect(read).toHaveLength(1);
    // …在此模拟 process 中断（不 replaceAll）。持久文件未动：
    expect(fsx.files.get("/s/dead.jsonl")).toBe(before);
    // 新实例（重启）仍恢复条目——recoverableAfterInterruption = 1，不是 0
    expect(new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll()).toHaveLength(1);
  });

  it("replaceAll() 原子地只留下仍失败集合（temp-write + rename）", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "a" }, 1);
    d.append({ ts: "b" }, 1);
    const all = d.readAll();
    // 假设 "a" 落地，"b" 仍失败 → 只留 b 且 attempts+1
    d.replaceAll([{ ev: all[1]!.ev, at: all[1]!.at, attempts: all[1]!.attempts + 1 }]);
    const remaining = d.readAll();
    expect(remaining).toHaveLength(1);
    expect((remaining[0]!.ev as { ts: string }).ts).toBe("b");
    expect(remaining[0]!.attempts).toBe(2);
    expect(fsx.files.has("/s/dead.jsonl.tmp")).toBe(false); // temp 已 rename 走，无垃圾
  });

  it("跨多次失败 retry 零丢（read → replaceAll 带 attempts+1）", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    for (let round = 0; round < 5; round++) {
      const entries = d.readAll();
      expect(entries).toHaveLength(1); // 从不丢
      d.replaceAll(entries.map((e) => ({ ev: e.ev, at: e.at, attempts: e.attempts + 1 })));
    }
    const final = d.readAll();
    expect(final).toHaveLength(1);
    expect(final[0]!.attempts).toBe(6); // 1 初始 + 5 retry，attempt 计数
  });

  it("对缺失文件 readAll()/replaceAll() 安全（不崩）", () => {
    const d = new DeadLetterStore("/s/none.jsonl", memFs(), clock);
    expect(d.readAll()).toEqual([]);
    d.replaceAll([]); // no-op，不 throw
    expect(d.readAll()).toEqual([]);
  });
});
