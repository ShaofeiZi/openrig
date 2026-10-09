import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

// S10（OPR.0.5.5.10）证明项 1——ACTIVATION、RED-FIRST。M1 gateway 组件发布时没有启动调用方
//（GATEWAY-M1-RECONCILIATION 第 3 项：已落地但未激活）。按修订后的 M1 §3 契约
//（daemon-subsystem；进程拆分在 founder R2 下退役），后台服务必须在启动时把 gateway 激活为
// 进程内子系统，不派生子进程，也不连接 connector。这些测试在当时 tip 上会失败，因为 createDaemon
// 从未构造该子系统；加入启动接线后转绿。这会固定“已落地但未激活”类别：未来若移除启动调用方，
// 本 suite 会按名称变红。

const cmuxFactory: CmuxTransportFactory = async () => {
  throw Object.assign(new Error("无 socket"), { code: "ENOENT" });
};
const tmuxExec: ExecFn = async () => "";

describe("S10 gateway 子系统激活（当时 tip 为 RED：无启动时子系统调用方）", () => {
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("createDaemon 在 AppDeps 上公开 ACTIVE gateway 子系统（后台服务启动时在进程内激活）", async () => {
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const subsystem = (deps as Record<string, unknown>).gatewaySubsystem as
        | { status: () => { state: string } }
        | undefined;
      expect(subsystem, "AppDeps.gatewaySubsystem 必须由 createDaemon（启动时调用方）构造").toBeDefined();
      expect(subsystem!.status().state, "子系统必须在启动后报告 ACTIVE").toBe("active");
    } finally {
      db.close();
    }
  }, 30000);

  it("可在真实 surface 上查看子系统健康状态：GET /api/health-summary/gateway", async () => {
    const { db, app } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const res = await app.request("/api/health-summary/gateway");
      expect(res.status, "gateway health 路由必须存在（404 表示无 surface）").toBe(200);
      const body = (await res.json()) as { state?: string };
      expect(body.state, "health surface 必须携带子系统状态").toBe("active");
    } finally {
      db.close();
    }
  }, 30000);

  it("人为触发的激活失败会如实报告（state=failed 且含原因），绝不静默留下死亡 gateway 或导致启动崩溃", async () => {
    // 动态 import，使此分支在当时 tip（模块缺失）按名称失败，且独立于分支 1–2。
    const mod = (await import("../src/domain/gateway/gateway-subsystem.js")) as {
      GatewaySubsystem: new (deps: {
        home: string;
        wire: () => { stop: () => void };
        log?: (m: string) => void;
      }) => {
        start: () => void;
        status: () => { state: string; reason?: string };
        stop: () => void;
      };
    };
    const home = mkdtempSync(join(tmpdir(), "s10-gw-"));
    try {
      const failing = new mod.GatewaySubsystem({
        home,
        wire: () => {
          throw new Error("人为触发的接线失败：slack transport 配置错误");
        },
      });
      // start() 不得向上抛错（损坏的 gateway 绝不能拖垮后台服务）……
      expect(() => failing.start()).not.toThrow();
      const s = failing.status();
      // ……也不得显示 active：必须真实失败并点明原因。
      expect(s.state, "人为触发的失败必须显示为 failed，绝不静默为 active").toBe("failed");
      expect(s.reason ?? "", "失败原因必须点明原因").toContain("人为触发的接线失败");
      failing.stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
