// OPR.0.5.6.25——occupant 代际感知的 refocus 基线。hook 以 SEAT 名为键
// 并存前一 occupant 的 transcript 大小，故 transcript 更小的新
// occupant 永远算出零增长（线上 24.37MB 对 5.1MB 样本），并继承
// 前任的待处理投递。这些 fixture 钉住 occupant-identity 规则、两档缺席、
// 诊断哨兵的 episode 语义、到期前收缩即清、有界
// collision-stable keys, and legacy byte-preservation/non-import.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const SEAT = "dev50-driver@test-rig";
const SEAT_KEY = SEAT.replace(/[^A-Za-z0-9@._-]/g, "_");
const THRESHOLD = 1000;

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeHome(): { home: string; stateDir: string } {
  root = mkdtempSync(join(tmpdir(), "refocus-occupant-"));
  const home = join(root, "home");
  const stateDir = join(home, "refocus");
  mkdirSync(stateDir, { recursive: true });
  return { home, stateDir };
}

function writeTranscript(bytes: number): string {
  const t = join(root!, "transcript.jsonl");
  writeFileSync(t, "x".repeat(bytes), "utf8");
  return t;
}

function runHook(home: string, input: Record<string, unknown>, event = "UserPromptSubmit") {
  const res = spawnSync("node", [HOOK], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, ...input }),
    env: {
      ...process.env,
      OPENRIG_HOME: home,
      OPENRIG_SESSION_NAME: SEAT,
      OPENRIG_REFOCUS_BYTES: String(THRESHOLD),
      OPENRIG_REFOCUS_ENABLED: "1",
      OPENRIG_REFOCUS_NOW: "",
      OPENRIG_REFOCUS_CONTENT_REF: "",
    },
    timeout: 15_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const fired = (r: { stdout: string }) => r.stdout.includes("hookSpecificOutput");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stateFileFor = (stateDir: string, key: string) => join(stateDir, `${SEAT_KEY}__${key}.json`);
const SENTINEL = (stateDir: string) => join(stateDir, `${SEAT_KEY}#no-identity-sentinel.json`);

describe("refocus occupant-generation baseline", () => {
  it("a fresh occupant measures from its own baseline and never inherits the prior occupant's lastBytes (legacy bytes preserved)", () => {
    const { home, stateDir } = makeHome();
    const legacy = join(stateDir, `${SEAT_KEY}.json`);
    writeFileSync(legacy, JSON.stringify({ lastBytes: 90_000, firedAt: "2026-08-28T10:24:00Z" }));
    const legacyBefore = sha(legacy);

    const t = writeTranscript(500);
    const first = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(first), "first observation initializes the baseline, never fires").toBe(false);

    writeTranscript(500 + THRESHOLD + 500);
    const second = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(second), "threshold growth from the NEW occupant's own baseline fires").toBe(true);

    expect(sha(legacy), "legacy seat-keyed state is never rewritten").toBe(legacyBefore);
    const occState = JSON.parse(readFileSync(stateFileFor(stateDir, "occupant-two"), "utf8"));
    expect(occState.lastBytes).toBe(500 + THRESHOLD + 500);
  });

  it("a prior occupant's pending delivery never leaks to the new occupant", () => {
    const { home, stateDir } = makeHome();
    const legacy = join(stateDir, `${SEAT_KEY}.json`);
    writeFileSync(legacy, JSON.stringify({ lastBytes: 50, pendingOn: "Stop", pendingAt: "2026-08-28T10:00:00Z" }));
    const legacyBefore = sha(legacy);

    const t = writeTranscript(100);
    const run = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(run), "legacy pendingOn must not deliver to the new occupant").toBe(false);
    expect(sha(legacy)).toBe(legacyBefore);
    const occState = JSON.parse(readFileSync(stateFileFor(stateDir, "occupant-two"), "utf8"));
    expect(occState.pendingOn, "no pending imported from legacy").toBeUndefined();
  });

  it("shrink clears pending and resets the baseline BEFORE due computation; the reset emits nothing and later growth fires once", () => {
    const { home, stateDir } = makeHome();
    const occFile = stateFileFor(stateDir, "occupant-two");
    writeFileSync(occFile, JSON.stringify({ lastBytes: 5000, pendingOn: "Stop", pendingAt: "2026-08-28T10:00:00Z" }));

    const t = writeTranscript(2000);
    const resetRun = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(resetRun), "the reset itself emits no refocus and stale pending never rides through").toBe(false);
    const afterReset = JSON.parse(readFileSync(occFile, "utf8"));
    expect(afterReset.lastBytes).toBe(2000);
    expect(afterReset.pendingOn).toBeUndefined();
    expect(resetRun.stderr, "重置时只呈现一次提示").toMatch(/已重置基线/);

    const quiet = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(quiet), "sub-threshold growth after reset stays silent").toBe(false);
    expect(quiet.stderr, "没有新重置回合时不重复提示").not.toMatch(/已重置基线/);

    writeTranscript(2000 + THRESHOLD + 200);
    const growRun = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(growRun), "threshold growth measured from the reset point fires once").toBe(true);
  });

  it("same-occupant contract floor: init, threshold fire, Stop retains due state, UserPromptSubmit delivers, SessionStart never emits", () => {
    const { home, stateDir } = makeHome();
    const t = writeTranscript(300);
    const id = { session_id: "occupant-one", transcript_path: t };

    expect(fired(runHook(home, id))).toBe(false);
    writeTranscript(300 + THRESHOLD + 300);
    expect(fired(runHook(home, id)), "monotonic growth delivery unchanged").toBe(true);

    writeTranscript(300 + THRESHOLD + 300 + THRESHOLD + 300);
    const stopRun = runHook(home, id, "Stop");
    expect(stopRun.stdout, "Stop retains due state without emitting").toBe("");
    const state = JSON.parse(readFileSync(stateFileFor(stateDir, "occupant-one"), "utf8"));
    expect(state.pendingOn).toBe("Stop");

    expect(fired(runHook(home, id)), "pending delivers at the next UserPromptSubmit").toBe(true);

    const sessionStart = runHook(home, id, "SessionStart");
    expect(sessionStart.stdout).toBe("");
  });

  it("absence tier (i): no session identity with a present transcript measures at the transcript-keyed path", () => {
    const { home, stateDir } = makeHome();
    const t = writeTranscript(400);
    expect(fired(runHook(home, { transcript_path: t }))).toBe(false);
    const fallback = stateFileFor(stateDir, "transcript");
    expect(existsSync(fallback), "fallback state lives at its own transcript-keyed path").toBe(true);

    writeTranscript(400 + THRESHOLD + 100);
    expect(fired(runHook(home, { transcript_path: t })), "fallback path measures and fires").toBe(true);
    expect(existsSync(join(stateDir, `${SEAT_KEY}.json`)), "legacy seat-name path never written").toBe(false);
  });

  it("absence tier (ii): neither identity nor transcript writes ONLY the diagnostic sentinel with episode semantics — never a fire, never a measurement", () => {
    const { home, stateDir } = makeHome();

    const first = runHook(home, {});
    expect(fired(first)).toBe(false);
    expect(first.stderr, "首次身份缺失事件只呈现一次").toMatch(/没有会话身份/);
    const sentinel = SENTINEL(stateDir);
    expect(existsSync(sentinel)).toBe(true);
    const s1 = JSON.parse(readFileSync(sentinel, "utf8"));
    expect(s1.activeEpisode).toBe(true);
    expect(s1.lastBytes, "sentinel never stores a baseline").toBeUndefined();
    expect(s1.pendingOn, "sentinel never stores pending").toBeUndefined();
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".json")), "no measurement state written").toEqual(
      [`${SEAT_KEY}#no-identity-sentinel.json`],
    );

    const second = runHook(home, {});
    expect(fired(second)).toBe(false);
    expect(second.stderr, "重复缺失事件保持静默").not.toMatch(/没有会话身份/);

    const t = writeTranscript(100);
    const valid = runHook(home, { session_id: "occupant-two", transcript_path: t });
    expect(fired(valid)).toBe(false);
    expect(JSON.parse(readFileSync(sentinel, "utf8")).activeEpisode, "a valid-identity event clears the marker").toBe(false);

    const third = runHook(home, {});
    expect(third.stderr, "后续独立回合再次呈现一次").toMatch(/没有会话身份/);
    expect(JSON.parse(readFileSync(sentinel, "utf8")).activeEpisode).toBe(true);
  });

  it("hostile identities produce bounded, contained, collision-stable filenames", () => {
    const { home, stateDir } = makeHome();
    const t = writeTranscript(100);

    runHook(home, { session_id: "../../etc/passwd", transcript_path: t });
    const entriesAfterHostile = readdirSync(stateDir);
    expect(entriesAfterHostile.length, "hostile identity stays inside the state dir").toBe(1);
    expect(existsSync(join(home, "etc")), "no path escape").toBe(false);

    const longA = "A".repeat(80) + "X";
    const longB = "A".repeat(80) + "Y";
    runHook(home, { session_id: longA, transcript_path: t });
    runHook(home, { session_id: longB, transcript_path: t });
    const entries = readdirSync(stateDir).filter((f) => f.startsWith(`${SEAT_KEY}__A`));
    expect(entries.length, "truncation-colliding identities stay distinct via the stable suffix").toBe(2);
    for (const entry of entries) {
      expect(entry.length).toBeLessThan(SEAT_KEY.length + 2 + 64 + 2 + 8 + 6);
      expect(entry).toMatch(/^[A-Za-z0-9@._\-#]+(__[0-9a-f]{8})?\.json$/);
    }
  });
});
