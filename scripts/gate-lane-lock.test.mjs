import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";

// F1 gate-lane（arch d6a6c1db；机制 (B) 绑定 localhost 端口，桌面侧已同意）：一个机器级互斥锁，
// 进程死亡时由内核释放。非阻塞获取；闸门对闸门争用时硬拒绝并点名持锁者（pid/started-at）；
// 端口上有外来进程、却没有 holder-info 文件时失败关闭（"foreign-holder"，load-115）。
// flock(2) 是匿名的 → 无论哪种机制都需要一个 holder-info 文件。
const info = () => join(mkdtempSync(join(tmpdir(), "gl-")), "holder.json");

test("acquires the lane on a free port + writes holder-info (pid, started-at)", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45871, holderInfoPath: p });
  assert.equal(a.ok, true);
  assert.ok(existsSync(p));
  const h = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(h.pid, process.pid);
  assert.match(h.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
  assert.equal(existsSync(p), false); // release unlinks the holder-info
});

test("gate-vs-gate contention → HARD-REFUSE naming the holder (pid/started-at), non-blocking", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45872, holderInfoPath: p });
  assert.equal(a.ok, true);
  const b = await acquireGateLane({ port: 45872, holderInfoPath: p });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "gate-holder");
  assert.equal(b.holder.pid, process.pid);
  assert.match(b.holder.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
});

test("FOREIGN process on the port + NO holder-info → FAIL-CLOSED 'foreign-holder' (load-115)", async () => {
  const p = info(); // holder-info absent
  const foreign = net.createServer();
  await new Promise((r) => foreign.listen(45873, "127.0.0.1", r));
  try {
    const b = await acquireGateLane({ port: 45873, holderInfoPath: p });
    assert.equal(b.ok, false);
    assert.equal(b.reason, "foreign-holder");
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("P2 exclusivity (no SO_REUSEPORT): a second CONCURRENT bind on the same port MUST fail", async () => {
  // 承重断言：若带 SO_REUSEPORT，两次 bind 都会成功，互斥锁会静默消失。
  const s1 = net.createServer();
  await new Promise((r) => s1.listen(45875, "127.0.0.1", r));
  const s2 = net.createServer();
  const err = await new Promise((resolve) => {
    s2.once("error", resolve);
    s2.listen(45875, "127.0.0.1", () => resolve(null));
  });
  try {
    assert.ok(err, "second concurrent bind must fail — exclusivity IS the mutex");
    assert.equal(err.code, "EADDRINUSE");
  } finally {
    await new Promise((r) => s1.close(r));
    if (!err) await new Promise((r) => s2.close(r));
  }
});

test("P3: GATE_LANE_PORT is the ONE named lock (numeric, valid range, env-overridable)", () => {
  assert.equal(typeof GATE_LANE_PORT, "number");
  assert.ok(GATE_LANE_PORT > 0 && GATE_LANE_PORT < 65536);
  // 注意：这个测试绝不能获取默认端口——GATE_LANE_PORT 是真实的机器锁，一个正在运行的闸门
  // （它正是通过 test:repo 跑这套测试的）已经占着它；在这里再获取会与父闸门 EADDRINUSE。
  // “acquire 用的是传入端口”已由上面显式传端口的测试覆盖。
});

test("P4 best-effort: a failed holder-info write does NOT lose the already-held lane (bind is the lock)", async () => {
  // 父路径是一个文件，所以 holder-info 的 mkdir/write 会失败——但端口 bind 仍然占着 lane。
  const f = join(mkdtempSync(join(tmpdir(), "gl-")), "notadir");
  writeFileSync(f, "x");
  const a = await acquireGateLane({ port: 45876, holderInfoPath: join(f, "holder.json") });
  assert.equal(a.ok, true); // lane held despite the failed naming-only write
  await a.release();
});

test("release frees the lane (kernel-released) so a subsequent acquire succeeds", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45874, holderInfoPath: p });
  assert.equal(a.ok, true);
  await a.release();
  const b = await acquireGateLane({ port: 45874, holderInfoPath: p });
  assert.equal(b.ok, true);
  await b.release();
});
