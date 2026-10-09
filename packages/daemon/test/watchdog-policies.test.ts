import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPoolReadyPolicy } from "../src/domain/policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "../src/domain/policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "../src/domain/policies/periodic-reminder.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

function makeJob(overrides: Partial<PolicyJob> & { context: Record<string, unknown> }): PolicyJob {
  return {
    jobId: "job-1",
    policy: "periodic-reminder",
    target: { session: "a@rig" },
    intervalSeconds: 60,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "ops@kernel",
    registeredAt: "2026-05-03T07:00:00.000Z",
    ...overrides,
  };
}

describe("periodicReminderPolicy（POC 契约）", () => {
  it("返回 send、target 对象及来自 job.message 的 message", async () => {
    const out = await periodicReminderPolicy.evaluate(
      makeJob({
        target: { session: "alice@rig" },
        message: "ping",
        context: {},
      }),
    );
    expect(out).toEqual({ action: "send", target: { session: "alice@rig" }, message: "ping" });
  });

  it("job.message 缺失时返回 send 和来自 context.message 的 message", async () => {
    const out = await periodicReminderPolicy.evaluate(
      makeJob({
        target: { session: "alice@rig" },
        context: { message: "ctx-ping" },
      }),
    );
    expect(out).toEqual({ action: "send", target: { session: "alice@rig" }, message: "ctx-ping" });
  });

  it("target.session 缺失时抛出 policy_spec_invalid", async () => {
    try {
      await periodicReminderPolicy.evaluate(
        makeJob({ target: { session: "" }, context: { message: "x" } }),
      );
      throw new Error("预期抛出异常");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("任何位置都没有 message 时抛出 policy_spec_invalid", async () => {
    try {
      await periodicReminderPolicy.evaluate(makeJob({ context: {} }));
      throw new Error("预期抛出异常");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });
});

describe("artifactPoolReadyPolicy（POC 契约）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `watchdog-pool-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("pool 为空时以 reason no_actionable_artifacts 跳过", async () => {
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });

  it("pool 中有可操作 artifact 时发送格式化消息", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: ready\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"] }],
          label: "things",
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toEqual({ session: "a@rig" });
    expect(out.message).toMatch(/things 有 2 个可处理产物/);
    expect(out.message).toContain("a.md");
    expect(out.message).toContain("b.md");
    // POC 尾部消息
    expect(out.message).toContain("请认领并处理下一个产物");
  });

  it("遵循 include_statuses 过滤器（排除 status 不匹配的 artifact）", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: draft\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/有 1 个可处理产物/);
    expect(out.message).toContain("a.md");
    expect(out.message).not.toContain("b.md");
  });

  it("遵循 max_items 上限（限制格式化项目符号列表）", async () => {
    for (const c of ["a", "b", "c", "d", "e", "f", "g"]) {
      writeFileSync(join(tmp, `${c}.md`), "---\nstatus: ready\n---\n");
    }
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"] }],
          max_items: 3,
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/有 7 个可处理产物/);
    const bulletCount = out.message
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.startsWith("- ..."))
      .length;
    expect(bulletCount).toBe(3);
    expect(out.message).toContain("- ... 另有 4 项");
  });

  it("pool 目录缺失时跳过（容忍 ENOENT）", async () => {
    rmSync(tmp, { recursive: true, force: true });
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });

  // R1 修复：POC scanner 一致性（guard blocker 3）。
  it("默认忽略 README.md（POC 一致性）", async () => {
    writeFileSync(join(tmp, "README.md"), "# Pool docs\n");
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("ready.md");
    expect(out.message).not.toContain("README.md");
  });

  it("默认忽略 .DS_Store（POC 一致性）", async () => {
    writeFileSync(join(tmp, ".DS_Store"), "binary-junk");
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).not.toContain(".DS_Store");
  });

  it("除非 include_malformed_frontmatter=true，否则排除 frontmatter 格式错误的 artifact", async () => {
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    writeFileSync(
      join(tmp, "malformed.md"),
      "---\nstatus: ready\nbroken: value: still broken\n---\n",
    );
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("ready.md");
    expect(out.message).not.toContain("malformed.md");
  });

  // R2 修复（guard blocker 2）：包含冒号的有效 YAML scalar（ISO 时间戳、URL）必须通过 `yaml` package
  // 正确解析，且必须包含该 artifact。R1 本地 parser 因内部冒号而将其错误排除为 "malformed"。
  it("包含 frontmatter 中带 ISO 时间戳的 ready artifact（POC YAML 一致性）", async () => {
    writeFileSync(
      join(tmp, "with-timestamp.md"),
      "---\nstatus: ready\nclaimed_at: 2026-05-03T05:15:25Z\n---\n# Body\n",
    );
    writeFileSync(
      join(tmp, "malformed.md"),
      "---\nstatus: ready\nbroken: value: still broken\n---\n",
    );
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("with-timestamp.md");
    expect(out.message).not.toContain("malformed.md");
    expect(out.message).toMatch(/有 1 个可处理产物/);
  });

  it("包含 frontmatter 中带 URL 的 ready artifact（POC YAML 一致性）", async () => {
    writeFileSync(
      join(tmp, "with-url.md"),
      "---\nstatus: ready\nsource_url: https://example.org/path\n---\n# Body\n",
    );
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("with-url.md");
  });

  it("包含 frontmatter 中带冒号引用字符串的 ready artifact", async () => {
    writeFileSync(
      join(tmp, "with-quoted-colon.md"),
      "---\nstatus: ready\ntitle: \"Phase C: things\"\n---\n",
    );
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("with-quoted-colon.md");
  });

  it("支持配置的 ignore_names（POC 一致性）", async () => {
    writeFileSync(join(tmp, "skip-me.md"), "---\nstatus: ready\n---\n");
    writeFileSync(join(tmp, "include-me.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"], ignore_names: ["skip-me.md"] }],
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("include-me.md");
    expect(out.message).not.toContain("skip-me.md");
  });

  it("recursive=true 时进入子目录", async () => {
    const sub = join(tmp, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested-ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"], recursive: true }],
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("nested-ready.md");
  });

  it("recursive 默认为 false 时排除子目录", async () => {
    const sub = join(tmp, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested-ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });
});

describe("edgeArtifactRequiredPolicy（POC 契约）", () => {
  let src: string;
  let tgt: string;
  beforeEach(() => {
    src = join(tmpdir(), `wd-edge-src-${Date.now()}-${Math.random()}`);
    tgt = join(tmpdir(), `wd-edge-tgt-${Date.now()}-${Math.random()}`);
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(tgt, { recursive: true, force: true });
  });

  // R1 修复（guard blocker 2）：POC 契约使用 context.source / context.target。
  it("下游原始内容引用 source key 时跳过（POC body-match）", async () => {
    writeFileSync(
      join(src, "x.md"),
      "---\nentry: coordination-stream-queue-view-intake-pilot-a-vertical\nstatus: shipped\n---\n# Pilot A\n",
    );
    writeFileSync(
      join(tgt, "old.md"),
      "---\nstatus: closed\n---\n# Old item\n\nThis item mentions agent-starter-v1-vertical only.\n",
    );
    writeFileSync(
      join(tgt, "new.md"),
      "---\nstatus: ready\n---\nLifecycle edge for coordination-stream-queue-view-intake-pilot-a-vertical.\n",
    );
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "delivery-orch-lead@openrig-velocity" },
        context: {
          edge_label: "delivery-to-lifecycle",
          source: { path: src, include_statuses: ["shipped"], key_field: "entry" },
          target: { path: tgt },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("下游原始内容未引用 source key 时发送（POC body-match）", async () => {
    writeFileSync(
      join(src, "x.md"),
      "---\nentry: coordination-stream-queue-view-intake-pilot-a-vertical\nstatus: shipped\n---\n# Pilot A\n",
    );
    writeFileSync(
      join(tgt, "old.md"),
      "---\nstatus: closed\n---\n# Old item\n\nThis item mentions agent-starter-v1-vertical only.\n",
    );
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "delivery-orch-lead@openrig-velocity" },
        context: {
          edge_label: "delivery-to-lifecycle",
          source: { path: src, include_statuses: ["shipped"], key_field: "entry" },
          target: { path: tgt },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toEqual({ session: "delivery-orch-lead@openrig-velocity" });
    expect(out.message).toContain("delivery-to-lifecycle");
    expect(out.message).toContain("coordination-stream-queue-view-intake-pilot-a-vertical");
    expect(out.message).toContain("Producer 循环负责创建缺失的下游 artifact");
  });

  it("frontmatter[key_field] 缺失时 source key 回退到不含 md 后缀的 basename", async () => {
    writeFileSync(join(src, "no-frontmatter-key.md"), "---\nstatus: ready\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          source: { path: src, include_statuses: ["ready"] },
          target: { path: tgt },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("no-frontmatter-key");
  });

  it("target 扫描忽略 source 的 include_statuses（POC override）", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: x\nstatus: ready\n---\n");
    // Target 正文包含匹配 key，但 status 不在列表中；仍视为匹配。
    writeFileSync(join(tgt, "x-down.md"), "---\nstatus: rejected\n---\nReferences x here.\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          source: { path: src, include_statuses: ["ready"] },
          target: { path: tgt, include_statuses: ["accepted"] },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("context.source 缺失时抛出 policy_spec_invalid", async () => {
    try {
      await edgeArtifactRequiredPolicy.evaluate(
        makeJob({
          target: { session: "a@rig" },
          context: { target: { path: tgt } },
        }),
      );
      throw new Error("预期抛出异常");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("context.target 缺失时抛出 policy_spec_invalid", async () => {
    try {
      await edgeArtifactRequiredPolicy.evaluate(
        makeJob({
          target: { session: "a@rig" },
          context: { source: { path: src } },
        }),
      );
      throw new Error("预期抛出异常");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });
});
