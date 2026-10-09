// S10 CUTOVER，CLI 侧——relay runner 已退役，必须以教学拒绝（绝
// 静默 no-op，绝不起第二条投递路径）：successor 取代 predecessor。admin
// 动词（enable/disable）路由至 daemon，seeding 规则在 wire
// 上线前执行。setup/status 经 daemon-home config 表面不变。
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackCommand, type SlackDeps } from "../src/commands/slack.js";
import { buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES } from "@openrig/daemon/gateway-slack";
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

function run(cmd: ReturnType<typeof slackCommand>, argv: string[]): Promise<void> {
  return cmd.parseAsync(["node", "slack", ...argv]).then(() => {});
}

function makeDeps(overrides: Partial<SlackDeps> = {}): { deps: SlackDeps; logs: string[]; posts: { path: string }[] } {
  const logs: string[] = [];
  const posts: { path: string }[] = [];
  const cfg = {
    enabled: false, inboundDestination: "operator-agent@kernel",
    outboundDestinations: [], sourceLabel: "vm", channel: "C1", requiredScopes: ["chat:write"],
    secretsEnvFile: null, queueUrl: null, minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT",
  };
  const deps: SlackDeps = {
    home: (() => { const home = mkdtempSync(join(tmpdir(), "slack-verb-")); homes.push(home); return home; })(),
    log: (m) => logs.push(m),
    surface: async () => ({
      loadConfig: () => ({ ...cfg }),
      saveConfig: () => "/tmp/slack-connector.json",
      staticReadiness: () => [],
      resolveSecret: () => null,
      checkEnvFilePermissions: () => null,
      verifyScopes: async () => ({ ok: true, granted: [], missing: [] }),
      verifyChannelMembership: async () => ({ ok: true, isMember: true }),
      buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES,
    }),
    clientFactory: () => ({
      post: async <T>(path: string) => {
        posts.push({ path });
        return { status: 200, data: { ok: true, seeded: 2, onlineStatus: "slack outbound ENABLED at enable-time: 2 pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver." } as T };
      },
    }),
    ...overrides,
  };
  return { deps, logs, posts };
}

describe("S10 CLI cutover — retired relay runners refuse with teaching", () => {
  it("`rig slack outbound` REFUSES (exit 1) and teaches the subsystem path — it does not sweep", async () => {
    const { deps, logs } = makeDeps();
    process.exitCode = 0;
    await run(slackCommand(deps), ["outbound"]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("已退役");
    expect(out).toContain("后台服务内");
    expect(out).toContain("rig slack status");
    process.exitCode = 0;
  });

  it("`rig slack inbound` REFUSES (exit 1) with the same teaching — it does not open a socket loop", async () => {
    const { deps, logs } = makeDeps();
    process.exitCode = 0;
    await run(slackCommand(deps), ["inbound"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("已退役");
    process.exitCode = 0;
  });
});

describe("S10 CLI cutover — admin verbs route to the daemon", () => {
  it.each(["enable", "disable"])("%s reports an HTTP refusal without claiming the effect", async (verb) => {
    const { deps, logs } = makeDeps({ clientFactory: () => ({ post: async <T>() => ({ status: 503, data: { error: "gateway_admin_unavailable" } as T }) }) });
    await run(slackCommand(deps), [verb, "--reason", "fixture operation"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("HTTP 503");
    process.exitCode = 0;
  });
  it("refuses a shutdown without a reason before contacting the daemon", async () => {
    const { deps, posts } = makeDeps();
    const cmd = slackCommand(deps);
    cmd.commands.find((command) => command.name() === "disable")!.exitOverride();
    await expect(run(cmd, ["disable"])).rejects.toThrow(/reason/);
    expect(posts).toHaveLength(0);
  });

  it("records unavailable verification honestly with no credential value", async () => {
    const { deps } = makeDeps();
    await run(slackCommand(deps), ["verify", "--json"]);
    const rows = readFileSync(join(deps.home!, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ action: "verify", effect: "observed", after: { ready: null }, provenance: "claimed:v1" });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
  it("`rig slack enable` POSTs /api/gateway/slack/enable and prints the honest online-status", async () => {
    const { deps, logs, posts } = makeDeps();
    await run(slackCommand(deps), ["enable"]);
    expect(posts.map((p) => p.path)).toEqual(["/api/gateway/slack/enable"]);
    expect(logs.join("\n")).toMatch(/ENABLED at enable-time: 2 pre-existing/);
  });

  it("`rig slack disable` POSTs /api/gateway/slack/disable", async () => {
    const { deps, posts } = makeDeps();
    await run(slackCommand(deps), ["disable", "--reason", "maintenance"]);
    expect(posts.map((p) => p.path)).toEqual(["/api/gateway/slack/disable"]);
  });

  it("`rig slack enable` against a DOWN daemon fails VISIBLY (exit 1), never silently", async () => {
    const { deps, logs } = makeDeps({
      clientFactory: () => ({ post: async () => { throw new Error("daemon unreachable"); } }),
    });
    process.exitCode = 0;
    await run(slackCommand(deps), ["enable"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("enable 失败");
    process.exitCode = 0;
  });
});

describe("S10 CLI cutover — config surfaces survive on the daemon-homed modules", () => {
  it("retires the legacy alert-tag setup knob", () => {
    const { deps } = makeDeps();
    const setup = slackCommand(deps).commands.find((command) => command.name() === "setup");
    expect(setup?.options.map((option) => option.long)).not.toContain("--alert-tag");
  });

  it("`rig slack status` renders readiness from the surface (and names the in-daemon path)", async () => {
    const { deps, logs } = makeDeps();
    await run(slackCommand(deps), ["status"]);
    expect(logs.join("\n")).toContain("后台服务内运行");
  });
});
