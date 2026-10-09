// OPR.0.4.1.29——泄漏狩猎基石：秘密边界门测试。
//
// 在秘密可能存在的每一处植入哨兵 "token"：活动 auth 文件、有效的已保存
// profile、畸形已保存 profile（JSON.parse 错误路径），以及 PATH 上一个在
// stdout 与 stderr 都响亮输出哨兵的假 `codex` shim。随后以 DEFAULT loginStatus
// 经真实命令运行每个 `rig auth` 动词（演练真实的 spawnSync stdio:"ignore" 路径，
// 而非桩），同时捕获 console.log、console.error 及任何抛出的错误/堆栈。
// 对任何动词，哨兵都不得出现在任何输出中——stdout、stderr 或异常。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { authCommand } from "../src/commands/auth.js";
import { resolveCodexHome, authSave, authSwitch, copyOntoFresh } from "../src/lib/codex-auth.js";

// 独特、抗 grep：若此串落入命令输出，秘密边界即告破。
const SENTINEL = "SENTINEL_TOKEN_LEAK_a1b2c3d4_DO_NOT_PRINT";
const NOW = () => "2026-06-26T00:00:00Z";

let home: string;
let binDir: string;
let origPath: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-leak-"));

  // 带哨兵 token 的活动 auth 文件（0600）。
  const active = path.join(home, "auth.json");
  fs.writeFileSync(active, JSON.stringify({ OPENAI_API_KEY: SENTINEL, tokens: { access_token: SENTINEL } }), { mode: 0o600 });
  fs.chmodSync(active, 0o600);

  // 已保存 profile 目录（0700），含一个有效 profile 与一个畸形 profile——二者都带哨兵。
  const profileDir = path.join(home, "auth-profiles");
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const work = path.join(profileDir, "work.json");
  fs.writeFileSync(work, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode: 0o600 });
  fs.chmodSync(work, 0o600);
  const broken = path.join(profileDir, "broken.json");
  // Invalid JSON that still contains the sentinel — exercises the parse-error path (must not echo content).
  fs.writeFileSync(broken, `{ "OPENAI_API_KEY": "${SENTINEL}", this is not json`, { mode: 0o600 });
  fs.chmodSync(broken, 0o600);

  // PATH 上的假 `codex`，在 stdout 与 stderr 都输出哨兵，非零退出。
  // defaultLoginStatus spawns it with stdio:"ignore" → both streams discarded → no leak path.
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-bin-"));
  const shim = path.join(binDir, "codex");
  fs.writeFileSync(shim, `#!/bin/sh\necho "${SENTINEL}"\necho "${SENTINEL}" 1>&2\nexit 3\n`, { mode: 0o755 });
  fs.chmodSync(shim, 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = origPath;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

// Run one `rig auth` invocation through the real command, capturing stdout + stderr + thrown errors.
async function runVerb(subArgs: string[]): Promise<string> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  try {
    // DEFAULT loginStatus on purpose: only inject env so CODEX_HOME points at the fixture; the real
    // spawnSync("codex", ["login","status"], {stdio:"ignore"}) path runs against the leaky shim.
    const cmd = authCommand({ env: { CODEX_HOME: home, HOME: home, PATH: process.env.PATH }, now: NOW });
    await cmd.parseAsync(subArgs, { from: "user" });
  } catch (err) {
    // Every error/exception path is in scope: a thrown error/stack must not carry the secret either.
    chunks.push(String(err));
    if (err instanceof Error && err.stack) chunks.push(err.stack);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit; // a verb's failure sets exitCode=1; never poison the test runner
  }
  return chunks.join("\n");
}

describe("rig auth LEAK-HUNT keystone (OPR.0.4.1.29)", () => {
  it("harness can actually fail: the sentinel really is planted in files + emitted by the shim", () => {
    expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toContain(SENTINEL);
    expect(fs.readFileSync(path.join(home, "auth-profiles", "work.json"), "utf8")).toContain(SENTINEL);
    expect(fs.readFileSync(path.join(home, "auth-profiles", "broken.json"), "utf8")).toContain(SENTINEL);
    // The shim leaks on BOTH streams when captured — proving stdio:"ignore" is what protects us.
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    expect(`${probe.stdout}${probe.stderr}`).toContain(SENTINEL);
  });

  it("no sentinel in ANY verb's stdout, stderr, or error path", async () => {
    // Order matters: save/switch mutate auth state; seats set must precede list/show/report.
    const verbs: string[][] = [
      ["status"], // runs the real codex shim via default loginStatus (stdio:"ignore")
      ["list"],
      ["save", "snapshot"], // copies the sentinel-bearing active auth into a new profile
      ["switch", "work"], // copies the sentinel-bearing profile onto active auth
      ["validate", "work"], // valid JSON path
      ["validate", "broken"], // MALFORMED → must report a fixed reason, never the file content
      ["validate", "missing-one"], // missing → fixed reason
      ["seats", "set", "--seat", "dev1@rig", "--rig", "rig", "--cwd", "/x", "--profile", "work"],
      ["seats", "list"],
      ["seats", "show", "dev1@rig"],
      ["seats", "report"],
    ];
    let all = "";
    for (const v of verbs) {
      const out = await runVerb(v);
      all += `\n## rig auth ${v.join(" ")}\n${out}`;
    }
    expect(all).not.toContain(SENTINEL);
    // Sanity: we actually captured real output (not silently empty), so the assertion is meaningful.
    expect(all).toContain("Codex 主目录：");
    expect(all).toContain("已保存档案：");
    expect(all).toContain("malformed_json");
  });
});

// rev1-r2 adversarial finding: the file-level symlink guard missed HARDLINKS (a regular non-symlink
// file whose inode lives outside CODEX_HOME) and SYMLINKED PARENT DIRS (an auth-profiles symlink). Both
// let save/switch write secret bytes outside the boundary. Each case must refuse with unsafe_path AND
// leave zero secret bytes outside CODEX_HOME.
describe("rig auth LEAK-HUNT — hardlink + symlinked-parent escapes (rev1-r2)", () => {
  function fixture() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-esc-"));
    const p = resolveCodexHome({ CODEX_HOME: h });
    fs.writeFileSync(p.activeAuth, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode: 0o600 });
    fs.chmodSync(p.activeAuth, 0o600);
    fs.mkdirSync(p.profileDir, { recursive: true });
    fs.chmodSync(p.profileDir, 0o700);
    return { h, p };
  }

  it("authSave refuses a HARDLINK to an inode OUTSIDE CODEX_HOME; the outside inode keeps no secret", () => {
    const { h, p } = fixture();
    // The hardlink target must live in a root that is genuinely NOT under CODEX_HOME, so this proves
    // the real outside-CODEX_HOME boundary (same filesystem under os.tmpdir() so linkSync can succeed).
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outroot-"));
    expect(outsideRoot.startsWith(h + path.sep)).toBe(false);
    const outside = path.join(outsideRoot, "outside-hardlink.json");
    fs.writeFileSync(outside, "ORIGINAL", { mode: 0o600 });
    fs.linkSync(outside, path.join(p.profileDir, "work.json")); // hardlink an OUTSIDE inode in (nlink=2)
    expect(authSave(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.readFileSync(outside, "utf8")).toBe("ORIGINAL");
    expect(fs.readFileSync(outside, "utf8")).not.toContain(SENTINEL);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("authSwitch refuses a HARDLINKED active auth pointing OUTSIDE CODEX_HOME; the outside inode keeps no secret", () => {
    const { h, p } = fixture();
    authSave(p, "work"); // a real saved profile carrying the secret
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outroot-"));
    expect(outsideRoot.startsWith(h + path.sep)).toBe(false);
    const outside = path.join(outsideRoot, "outside-active-hardlink.json");
    fs.writeFileSync(outside, "ORIGINAL", { mode: 0o600 });
    fs.rmSync(p.activeAuth);
    fs.linkSync(outside, p.activeAuth); // active auth is a hardlink to an OUTSIDE inode (nlink=2)
    expect(authSwitch(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.readFileSync(outside, "utf8")).toBe("ORIGINAL");
    expect(fs.readFileSync(outside, "utf8")).not.toContain(SENTINEL);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("authSave refuses a SYMLINKED auth-profiles parent; no secret written outside CODEX_HOME", () => {
    const { h, p } = fixture();
    fs.rmSync(p.profileDir, { recursive: true, force: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-outdir-"));
    expect(outsideDir.startsWith(h + path.sep)).toBe(false); // genuinely outside CODEX_HOME
    fs.symlinkSync(outsideDir, p.profileDir); // auth-profiles -> /outside/dir
    expect(authSave(p, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    const leaked = fs.readdirSync(outsideDir).some((f) => {
      try {
        return fs.readFileSync(path.join(outsideDir, f), "utf8").includes(SENTINEL);
      } catch {
        return false;
      }
    });
    expect(leaked).toBe(false);
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

// OPR.0.4.3.23——secret 边界 B1：先检查后使用的间隙。0.4.1 的守卫是基于路径的
// 预检，随后的复制会重新解析源路径；窗口内的 swap/crash/并发合法 rig 可能重定向
// 读取、复制撕裂的文件，或短暂暴露比 0600 更宽的临时文件（CERT FIO45-C）。
// copyOntoFresh 现在打开源、在 FD 上校验（O_NOFOLLOW + fstat：常规、nlink===1、
// dev/ino），从 fd 读取，以 O_EXCL 在 0600 创建目标临时文件，fsync，并以 rename
// 作为唯一原子发布。这些测试直接演练 fd 层（位于路径预检之后），并证明在
// crash / 部分写入 / swap 路径上没有 secret 泄漏。
describe("rig auth LEAK-HUNT — fd-first check-then-use / crash-safety (OPR.0.4.3.23)", () => {
  let root: string;
  const orphans = (dir: string, base: string): string[] =>
    fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.tmp-`));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-fdfirst-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a SYMLINK source via O_NOFOLLOW at the fd (not just the path pre-check); no read through the swap target", () => {
    const secret = path.join(root, "secret.json");
    fs.writeFileSync(secret, JSON.stringify({ k: SENTINEL }), { mode: 0o600 });
    const srcLink = path.join(root, "source-link.json"); // a symlink swapped in where a regular file was expected
    fs.symlinkSync(secret, srcLink);
    const dest = path.join(root, "dest.json");
    expect(copyOntoFresh(srcLink, dest)).toBe(false); // O_NOFOLLOW fails the open of a symlink final component
    expect(fs.existsSync(dest)).toBe(false); // nothing published
    expect(orphans(root, "dest.json")).toEqual([]); // no orphan temp left behind
  });

  it("refuses a HARDLINKED source (nlink>1) via the fstat-on-fd check (the opened inode may live outside the boundary)", () => {
    const real = path.join(root, "real.json");
    fs.writeFileSync(real, JSON.stringify({ k: SENTINEL }), { mode: 0o600 });
    const hard = path.join(root, "hard.json");
    fs.linkSync(real, hard); // nlink === 2 on the shared inode
    const dest = path.join(root, "dest.json");
    expect(copyOntoFresh(hard, dest)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    expect(orphans(root, "dest.json")).toEqual([]);
  });

  it("refuses when the opened fd's dev/ino no longer matches the caller's earlier lstat (inode swapped in the window)", () => {
    const src = path.join(root, "src.json");
    fs.writeFileSync(src, JSON.stringify({ k: SENTINEL }), { mode: 0o600 });
    const before = fs.lstatSync(src);
    // Simulate a swap in the check-then-use window: same path, a different inode now.
    fs.rmSync(src);
    fs.writeFileSync(src, JSON.stringify({ k: "IMPOSTER" }), { mode: 0o600 });
    const dest = path.join(root, "dest.json");
    expect(copyOntoFresh(src, dest, { dev: before.dev, ino: before.ino })).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("happy path: temp is 0600 AT creation and the published dest is 0600 + byte-identical; no orphan temp", () => {
    const src = path.join(root, "src.json");
    const body = JSON.stringify({ k: SENTINEL });
    fs.writeFileSync(src, body, { mode: 0o600 });
    const dest = path.join(root, "dest.json");
    expect(copyOntoFresh(src, dest, { dev: fs.lstatSync(src).dev, ino: fs.lstatSync(src).ino })).toBe(true);
    expect(fs.lstatSync(dest).mode & 0o777).toBe(0o600); // 0600, set at open — no create-then-chmod window
    expect(fs.readFileSync(dest, "utf8")).toBe(body); // fd read+write reproduces the bytes exactly
    expect(orphans(root, "dest.json")).toEqual([]);
  });

  it("a pre-existing dest inode is NOT written through — the fresh O_EXCL temp + rename gives dest a new inode", () => {
    const src = path.join(root, "src.json");
    fs.writeFileSync(src, JSON.stringify({ k: SENTINEL }), { mode: 0o600 });
    const dest = path.join(root, "dest.json");
    fs.writeFileSync(dest, "OLD", { mode: 0o600 });
    const alias = path.join(root, "alias.json");
    fs.linkSync(dest, alias); // alias shares dest's ORIGINAL inode
    expect(copyOntoFresh(src, dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain(SENTINEL); // dest points at a fresh inode
    expect(fs.readFileSync(alias, "utf8")).toBe("OLD"); // the old inode was unlinked from dest, never written
    expect(fs.readFileSync(alias, "utf8")).not.toContain(SENTINEL);
  });

  it("a failed copy (source vanished) leaves the prior dest byte-intact and leaves no orphan temp", () => {
    const dest = path.join(root, "dest.json");
    fs.writeFileSync(dest, "PRIOR", { mode: 0o600 });
    const gone = path.join(root, "gone.json"); // never created
    expect(copyOntoFresh(gone, dest)).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("PRIOR"); // crash-before-rename → prior dest intact
    expect(orphans(root, "dest.json")).toEqual([]);
  });

  it("a rename failure AFTER the temp is written cleans up the temp so no orphan carries the secret", () => {
    const src = path.join(root, "src.json");
    fs.writeFileSync(src, JSON.stringify({ k: SENTINEL }), { mode: 0o600 });
    // dest 是非空目录 → 临时文件被创建并写入，但 renameSync(tmp, dest) 失败。
    const dest = path.join(root, "dest-dir");
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "occupant"), "x");
    expect(copyOntoFresh(src, dest)).toBe(false);
    expect(orphans(root, "dest-dir")).toEqual([]); // the finally cleanup removed the secret-bearing temp
    // No sibling file anywhere in root outside dest carries the sentinel (the temp was scrubbed away).
    const leaked = fs
      .readdirSync(root)
      .filter((n) => n !== "src.json" && n !== "dest-dir")
      .some((n) => {
        try {
          return fs.readFileSync(path.join(root, n), "utf8").includes(SENTINEL);
        } catch {
          return false;
        }
      });
    expect(leaked).toBe(false);
  });

  it("repeated copyOntoFresh publishes each land a valid 0600 file, never a partial; last write wins", () => {
    const a = path.join(root, "a.json");
    const b = path.join(root, "b.json");
    fs.writeFileSync(a, JSON.stringify({ v: "AAA" }), { mode: 0o600 });
    fs.writeFileSync(b, JSON.stringify({ v: "BBB" }), { mode: 0o600 });
    const dest = path.join(root, "dest.json");
    expect(copyOntoFresh(a, dest)).toBe(true);
    expect(copyOntoFresh(b, dest)).toBe(true); // second atomic publish over the first
    expect(fs.lstatSync(dest).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(dest, "utf8")).toBe(JSON.stringify({ v: "BBB" })); // full, not a partial
    expect(orphans(root, "dest.json")).toEqual([]);
  });

  it("end-to-end save + switch through the public API leave no secret-bearing orphan temp in the auth home", () => {
    const p = resolveCodexHome({ CODEX_HOME: root });
    fs.writeFileSync(p.activeAuth, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode: 0o600 });
    fs.chmodSync(p.activeAuth, 0o600);
    fs.mkdirSync(p.profileDir, { recursive: true });
    fs.chmodSync(p.profileDir, 0o700);
    expect(authSave(p, "work")).toMatchObject({ ok: true, mode: "600" });
    expect(authSwitch(p, "work")).toMatchObject({ ok: true, mode: "600" });
    // Scan both the codex home and the profile dir for any lingering *.tmp-* temp files.
    const scan = (dir: string) =>
      fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(scan(root)).toEqual([]);
    expect(scan(p.profileDir)).toEqual([]);
    // The published files are 0600 and carry the secret only inside the boundary.
    expect(fs.lstatSync(p.activeAuth).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(path.join(p.profileDir, "work.json")).mode & 0o777).toBe(0o600);
  });
});
