// 已取代契约翻转（founder 根不变量 2026-08-27，原为 51-09 始终加后缀）：
// wrapSendBody 按收到的原样精确渲染发送者。来源三元组只在跨主机转发边界构造
//（send.ts runHttpHostSend / ssh executor 的 OPENRIG_SESSION_NAME），绝不在 wrapper 内构造。
// 与后台服务镜像保持字节一致（daemon/test/self-host-envelope-triple.test.ts 使用相同字面值）。
import { describe, it, expect } from "vitest";
import { wrapSendBody } from "../src/commands/send.js";

const SENDER = "dev50-driver@v-openrig-build";

describe("wrapSendBody——按收到原样处理的发送者", () => {
  it("在 From: 和回复提示中都渲染裸本地发送者（与后台服务镜像字节一致）", () => {
    const out = wrapSendBody(SENDER, "guard@my-rig", "hi");
    expect(out).toBe(
      'From: dev50-driver@v-openrig-build\nTo: guard@my-rig\n---\nhi\n---\n\u21a9 回复：zrig send dev50-driver@v-openrig-build "..."',
    );
  });

  it("边界构造的来源三元组逐字渲染", () => {
    const out = wrapSendBody(`${SENDER}@mm2-openrig1`, "guard@my-rig", "hi");
    expect(out).toContain(`From: ${SENDER}@mm2-openrig1`);
    expect(out).toContain(`\u21a9 回复：zrig send ${SENDER}@mm2-openrig1 "..."`);
  });

  it("未知发送者回退永远不添加后缀", () => {
    const out = wrapSendBody(undefined, "guard@my-rig", "hi");
    expect(out).toContain("From: <unknown sender>");
    expect(out).toContain('\u21a9 回复：zrig send <unknown sender> "..."');
  });
});
