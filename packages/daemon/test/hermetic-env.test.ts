import { describe, it, expect } from "vitest";
import {
  DAEMON_TARGET_ENV_VARS,
  detectForeignDaemonTarget,
  assertNoForeignDaemon,
  HermeticEnvError,
} from "./helpers/hermetic-env.js";

// Slice 51-02——hermetic env 纪律 helper 的 FAIL-CLOSED guard（proof item 4，安全基石）。若环境中
// 存在 helper 未创建的 live-daemon target，runner 必须以点名 foreign target 的硬错误拒绝，并向其
// 发送零流量——绝不静默回退到环境 daemon。
describe("hermetic-env fail-closed guard", () => {
  it("环境中存在 OPENRIG_URL 时，以具名 HermeticEnvError 拒绝", () => {
    const env = { OPENRIG_URL: "http://foreign-daemon:9999" };
    expect(() => assertNoForeignDaemon(env)).toThrow(HermeticEnvError);
    let msg = "";
    try {
      assertNoForeignDaemon(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    // 错误必须点名 foreign target（变量 + 值），使操作员可以看到。
    expect(msg).toContain("OPENRIG_URL");
    expect(msg).toContain("http://foreign-daemon:9999");
  });

  it("将每个继承的 daemon-target 变量点名为 foreign target", () => {
    for (const v of DAEMON_TARGET_ENV_VARS) {
      const hit = detectForeignDaemonTarget({ [v]: "some-value" });
      expect(hit).not.toBeNull();
      expect(hit!.name).toBe(v);
      expect(() => assertNoForeignDaemon({ [v]: "some-value" })).toThrow(
        new RegExp(v),
      );
    }
  });

  it("报告找到的第一个 foreign target（确定、有序）", () => {
    const env = { OPENRIG_PORT: "7433", OPENRIG_URL: "http://x:1" };
    const hit = detectForeignDaemonTarget(env);
    // DAEMON_TARGET_ENV_VARS 顺序即检测顺序——URL 先于 PORT。
    expect(hit!.name).toBe("OPENRIG_URL");
  });

  it("无 foreign daemon target 的干净 env 可通过", () => {
    expect(detectForeignDaemonTarget({ HOME: "/x", PATH: "/y" })).toBeNull();
    expect(() => assertNoForeignDaemon({ HOME: "/x", PATH: "/y" })).not.toThrow();
  });

  it("忽略空字符串 daemon-target 变量（等同未设置）", () => {
    // 已 export 但为空的变量不指向 daemon；视为缺失。
    expect(detectForeignDaemonTarget({ OPENRIG_URL: "" })).toBeNull();
    expect(() => assertNoForeignDaemon({ OPENRIG_URL: "" })).not.toThrow();
  });
});
