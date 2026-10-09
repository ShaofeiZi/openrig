// 已取代契约翻转（founder 根不变量 2026-08-27，原 51-09 增量 3 的 always-suffix）：信封会按
// 接收原样渲染发送方——本地保持裸名称，传入的 origin 三元组逐字保留。本文件继续承担其独特职责：
// 与 CLI 镜像保持逐字节一致的跨包 parity 锚点（cli/test/self-host-triple.test.ts 保存相同字面量）。
import { describe, it, expect } from "vitest";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

describe("wrapPaneEnvelope——按接收原样保留裸发送方（与 CLI 镜像逐字节一致）", () => {
  it("在 From: 和回复提示中渲染裸本地发送方（与 CLI 镜像预期字面量逐字节一致）", () => {
    const out = wrapPaneEnvelope("dev50-driver@v-openrig-build", "guard@my-rig", "hi");
    expect(out).toBe(
      'From: dev50-driver@v-openrig-build\nTo: guard@my-rig\n---\nhi\n---\n\u21a9 回复：zrig send dev50-driver@v-openrig-build "..."',
    );
  });

  it("逐字渲染传入的 ORIGIN 三元组（由跨主机边界构造，绝不重复盖章）", () => {
    const out = wrapPaneEnvelope("dev50-driver@v-openrig-build@mm2-openrig1", "guard@my-rig", "hi");
    expect(out).toContain("From: dev50-driver@v-openrig-build@mm2-openrig1");
    expect(out).toContain('\u21a9 回复：zrig send dev50-driver@v-openrig-build@mm2-openrig1 "..."');
  });
});
