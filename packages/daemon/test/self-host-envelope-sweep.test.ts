import { describe, it, expect } from "vitest";
import { parseSessionName } from "../src/domain/session-name.js";

/**
 * 51-09 增量 5——信封消费者清查（risk-2 义务）。
 *
 * 枚举（已在 51-09 tip 的源头验证）：检查 `From:` / `↩ Reply:` 发送者格式的每个
 * 消费者，以及三段式 `member@rig@host` 签名是否会破坏它。没有消费者假定恰好两个
 * `@` 段，因此始终带后缀的三段式在整个集群中安全。本套件是枚举 + 对照
 *（解析器按设计及增量 1—4 防护本就支持三段式），不是行为变更。
 *
 * 解析器（消费发送者/目标字符串）：
 *  - domain/session-name.ts parseSessionName——FR-8 原型：贪婪折叠（member 截止到第一个
 *    '@'，rig 为其余部分）。`a@b@c` → member 'a'，rig 'b@c'。从不抛出异常，也不
 *    假定两个段。（daemon/cli/ui 副本字节完全一致——C3 防护；51-09 未改变。）
 *  - cli/commands/queue.ts resolveQueueHostDestination——atCount>=2 分支使用
 *    lastIndexOf('@') 拆分 member@rig | host。感知三段式（MH-3 寻址）。
 *  - cli/cross-host-target.ts resolveCrossHostTarget——对三段式目标执行自身 id 去除 +
 *    注册表去除（增量 3）；回复提示通过它完成往返。
 *
 * 防护（检测已有三段式，由 51-09 添加；全部感知三段式）：
 *  - cli/send.ts:49,509 + lib/pane-envelope.ts:45 — `split('@').length < 3`
 *    （渲染/转发防护：已有三段式原样保留，绝不重新标记——不伪造来源。）
 *  - domain/queue-repository.ts stampSelfHostSuffix — `split('@').length !== 2`
 *    （仅标记裸 member@rig；三段式保持不变。）
 *
 * 仅渲染（发出发送者格式，不解析——无内容可被破坏）：
 *  - cli/send.ts + lib/pane-envelope.ts 的 `From:`/`↩ Reply:` 渲染三段式。
 *  - 队列发送者接口渲染已存 source_session（已是三段式）。
 *
 * 随附示例已更新为新格式：技能 cross-host-rig-commands（规范版 + specs 物化版）——
 * 教导“发送者不携带 @host 后缀”的“发送者身份不对称”区块，已被始终添加后缀规则取代。
 *（openrig-user 的 `--from` 行已指明来源。）
 *
 * C5 诚实范围：三段式结构安全且提供指导；D10 两段式同名静默创建由信封 + 发送方去除
 *（增量 3）+ 指导性拒绝（增量 4b）封堵，而不是由此处任何字符串内解析变更封堵。
 */
describe("51-09 信封消费者清查——没有消费者假定两个 @ 段", () => {
  it("parseSessionName 贪婪折叠三段式发送者签名且不会失败", () => {
    // 始终带后缀的 From: 为 member@rig@originHost。parseSessionName 是原型消费者
    //（BR-1：工作组查找未命中 → 如实拒绝，绝不抛出异常）。
    const p = parseSessionName("orch@rig-a@host-origin");
    expect(p.kind).toBe("canonical");
    expect(p.member).toBe("orch");
    expect(p.rig).toBe("rig-a@host-origin"); // greedy fold — 2-segment NOT assumed
  });

  it("裸两段式发送者仍按当前方式解析（无回归）", () => {
    const p = parseSessionName("orch@rig-a");
    expect(p).toMatchObject({ kind: "canonical", member: "orch", rig: "rig-a" });
  });

  it("自身后缀三段式得到不同且不抛出异常的解析结果（rig 携带 host）", () => {
    // 后台服务不去除后缀（增量 4b C4）：先贪婪解析，再拒绝并提供指导。
    const p = parseSessionName("orch@rig-a@self-host");
    expect(p.kind).toBe("canonical");
    expect(p.rig).toBe("rig-a@self-host");
  });
});
