// B1 ROUND 2——restore 生命周期 RENDER。HIGH-4 判别器：done 视图把每个 need 放它
// 自己的 triage 行（经发布的 renderTriage），故精确 need 与 not_attempted remediation
// 完整在场——r2 探针发现二者在挤入一个宽度裁剪 footer 时皆缺席。
import { describe, it, expect } from "vitest";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { renderRestoreLifecycleView } from "../src/crash-cart/render-crash-cart.js";

function frame(over: Partial<RestoreFrame>): RestoreFrame {
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "done",
    done: over.done ?? true,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "mixed",
    rollup: over.rollup ?? { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
  };
}

describe("renderRestoreLifecycleView——done", () => {
  it("HIGH-4：确切 attention need 与 not_attempted remediation 各自独立成行渲染（不截断）", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "done",
        verdict: "mixed",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
          sequence: [
            { rigId: "kernel", outcome: "fully_restored" },
            { rigId: "beta", outcome: "not_attempted", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" },
          ],
          attention_required: [
            { rigId: "kernel", seat: "dev.guard", need: "original session not resumable and no --fresh — choose fresh-prime or skip" },
          ],
        },
      }),
    );
    const lines = renderRestoreLifecycleView(vm);
    const body = lines.map((l) => l.text).join("\n");
    expect(body).toContain("舰队恢复：mixed");
    expect(body).toContain("待关注 (2)"); // one attention seat + one not_attempted rig
    expect(body).toContain("dev.guard@kernel");
    expect(body).toContain("choose fresh-prime or skip"); // the exact need, in full
    expect(body).toContain("take a snapshot"); // the not_attempted remediation, in full
    // 且每个 need 在它自己的行（非挤一个 footer）
    const needLine = lines.find((l) => l.text.includes("choose fresh-prime or skip"))!;
    const remedLine = lines.find((l) => l.text.includes("take a snapshot"))!;
    expect(needLine).not.toBe(remedLine);
  });

  it("all-clean done → triage 全干净行，无 NEEDS ATTENTION", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        verdict: "all_fully_restored",
        rollup: { counts: { fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
      }),
    );
    const body = renderRestoreLifecycleView(vm).map((l) => l.text).join("\n");
    expect(body).toContain("所有席位已干净恢复");
    expect(body).not.toContain("待关注");
  });
});

describe("renderRestoreLifecycleView——detached (HIGH-1：诚实、可操作、绝不冻结)", () => {
  it("命名 attempt，说明恢复在 daemon 上继续，并提供 reattach + cancel", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "detached",
        done: false,
        verdict: "none_attempted",
        rollup: {
          counts: { fully_restored: 2, partially_restored: 0, failed: 0, not_attempted: 0 },
          sequence: [
            { rigId: "kernel", outcome: "fully_restored" },
            { rigId: "alpha", outcome: "fully_restored" },
          ],
          attention_required: [],
        },
      }),
    );
    const body = renderRestoreLifecycleView(vm).map((l) => l.text).join("\n");
    expect(body).toContain("仍在后台服务上运行");
    expect(body).toContain("fleet-1"); // the retained attempt id (from the frame default)
    expect(body).toContain("在后台服务上继续"); // r1's keeper: detached ≠ stopped
    expect(body).toContain("r 重新附着");
    expect(body).toContain("c 取消");
    expect(body).not.toMatch(/RESTORING FLEET\b/); // not the running header
  });
});

describe("renderRestoreLifecycleView——done 头字形匹配 verdict (BLOCKER 2)", () => {
  const header = (verdict: string) =>
    renderRestoreLifecycleView(
      buildRestoreLifecycleVM(
        frame({ phase: "done", done: true, verdict, rollup: { counts: { fully_restored: 0, partially_restored: 0, failed: 1, not_attempted: 0 }, sequence: [], attention_required: [] } }),
      ),
    )[0]!.text;

  it("all_failed 不戴成功 ✓——显示 ✗", () => {
    const h = header("all_failed");
    expect(h).toContain("舰队恢复：all_failed");
    expect(h).not.toContain("✓");
    expect(h).toContain("✗");
  });

  it("none_attempted 与 mixed 戴警告，绝不 ✓", () => {
    for (const v of ["none_attempted", "mixed"]) {
      const h = header(v);
      expect(h, `${v} header`).not.toContain("✓");
      expect(h, `${v} header`).toContain("⚠");
    }
  });

  it("all_fully_restored 仍戴成功 ✓", () => {
    expect(header("all_fully_restored")).toContain("✓ 舰队恢复：all_fully_restored");
  });
});

describe("renderRestoreLifecycleView——running（运行中进度帧）", () => {
  it("运行中显示每 rig 进度列表 + cancel 可操作项", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "running",
        done: false,
        verdict: "none_attempted",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 },
          sequence: [{ rigId: "kernel", outcome: "fully_restored" }],
          attention_required: [],
        },
      }),
    );
    const body = renderRestoreLifecycleView(vm).map((l) => l.text).join("\n");
    expect(body).toContain("正在恢复舰队");
    expect(body).toContain("kernel");
    expect(body).toContain("c 取消");
    expect(body).not.toContain("待关注"); // triage only on the done view
  });
});
