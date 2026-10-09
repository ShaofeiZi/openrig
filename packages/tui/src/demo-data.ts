// 演示夹具（清晰标记）：§4.A 读取水合的形状，带测试存根
// 值 + `zrig-tui --demo` 手动运行。绝不使用，除非
// 传递 --demo；真实路径是后台服务读取（Phase 2 绑定）。
import type { FleetSnapshot } from "./types.js";

export function demoSnapshot(): FleetSnapshot {
  return {
    hosts: [
      {
        name: "vm-host",
        reachable: true,
        rigs: [
          {
            name: "openrig-build",
            hasLiveAgents: true,
            pods: [
              {
                name: "dev50",
                agents: [
                  { name: "dev50.driver", runtime: "claude-code", model: "fable-5.1", spec: "driver-agent", context: 62, tokens: "118k", status: "active", live: true, canRun: false, session: "dev50-driver@openrig-build", attach: "tmux attach -t dev50-driver@openrig-build" },
                  { name: "dev50.guard", runtime: "codex", model: "gpt-5.6", spec: "guard-agent", context: 31, tokens: "54k", status: "idle", live: true, canRun: false, session: "dev50-guard@openrig-build" },
                  { name: "dev50.qa", runtime: "codex", model: "gpt-5.6", spec: "qa-agent", context: null, tokens: null, status: "unknown", live: false, canRun: true, session: "dev50-qa@openrig-build" },
                ],
              },
              {
                name: "orch",
                agents: [
                  { name: "orch.lead", runtime: "codex", model: "gpt-5.6", spec: "lead-agent", context: 88, tokens: "203k", status: "needs-attention", live: true, canRun: false, session: "orch-lead@openrig-build" },
                ],
              },
            ],
          },
        ],
      },
      { name: "remote-host", reachable: false, rigs: [] },
    ],
    specs: [
      { name: "openrig-build-rig", kind: "rig", agentRefs: ["driver-agent", "guard-agent", "qa-agent", "lead-agent"] },
      { name: "driver-agent", kind: "agent", runtime: "claude-code", usedByRigs: ["openrig-build-rig"] },
      { name: "guard-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "qa-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "lead-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
    ],
    needs: [
      // 形状如服务端 composeNeedsYou 派生项：kind + summary/evidence 原文
      { source: "derived", kind: "stuck", target: "dev50-guard@openrig-build", detail: "dev50.guard 看起来卡住——空闲 42 分 >= 30 分默认 · 持有 1" },
    ],
    humanQueueProbed: true,
    // PULSE ▲ 需要你来源——形状如已发布的待关注读取（后台服务
    // 已返回 exactly 面向人员的集合）。
    scopes: [
      {
        mission: "release-0.5.2",
        slices: [
          {
            dirName: "gateway-m1", id: "OPR.0.5.2.9", displayName: "gateway-m1", status: "spec", stage: "building",
            locks: { spec: { by: "pm-openrig@openrig-pm", at: "2026-08-06T10:00:00.000Z" }, delivery: null },
            proof: { paired: 2, total: 9 },
            intent: '"里程碑切割：我们今天需要的功能——Slack 到创建者——在我们保留的骨架上。"',
            miniRequirements: [
              "后台服务通过域类准入将 @外部 地址解析到网关路径；未注册域响亮地弹回。",
              "人员规格每人一个文件；注册表是生成的投影。",
            ],
            proofContract: [
              { index: 1, text: "在已发布中继路径上演示的投递后确认修复。", paired: true, drops: [{ file: "qa-relay.md", artifactType: "qa", verdict: "PASS", media: ["relay-repair-e2e.txt"] }] },
              { index: 2, text: "已注册实体从 Slack 冷 DM，它完全如今天一样入队。", paired: false, drops: [] },
              { index: 3, text: "未注册域响亮地弹回并带教学错误。", paired: true, drops: [{ file: "guard-bounce.md", artifactType: "guard", verdict: "CLEAR", media: [] }] },
            ],
            narrative: "- 启动：A1 构建中\n- A2 等待架构咨询",
            specShaShort: "fe92ffa9",
            prdExists: true,
          },
          {
            dirName: "crash-cart", id: "OPR.0.5.2.5", displayName: "crash-cart", status: "done", stage: "established",
            locks: { spec: { by: "pm-openrig@openrig-pm", at: "2026-08-05T10:00:00.000Z" }, delivery: { by: "pm-openrig@openrig-pm", at: "2026-08-06T20:00:00.000Z" } },
            proof: { paired: 4, total: 4 },
            intent: "后台服务降级座舱。",
            miniRequirements: ["一次按键恢复。"],
            proofContract: [
              { index: 1, text: "全部恢复工作。", paired: true, drops: [{ file: "qa1.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 2, text: "仅后台服务启动工作。", paired: true, drops: [{ file: "qa2.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 3, text: "检查工作。", paired: true, drops: [{ file: "qa3.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 4, text: "入门菜单在此。", paired: true, drops: [{ file: "qa4.md", artifactType: "qa", verdict: "PASS", media: [] }] },
            ],
            narrative: null,
            specShaShort: "0a1b2c3d",
            prdExists: true,
          },
        ],
      },
    ],
    // 真实 `--demo` 旅程的代表性执行投影。
    // 它由此夹具的其余部分以 --demo 门控，绝不进入
    // 后台服务水合路径。
    executionMission: "release-0.5.2",
    execution: {
      view: "execution",
      mission: "release-0.5.2",
      derived_at: "2026-08-06T12:00:00.000Z",
      sources: {
        queue_db: { asof: "2026-08-06T12:00:00.000Z", basis: "演示队列行" },
        arrangement: { manifest: "/demo/release-0.5.2/mission.yaml", basis: "演示组合顺序" },
        git: { basis: "演示候选映射" },
        build_info: { commit: "51209941a" },
      },
      q1_lanes: [{
        qitem_id: "qitem-20260806-drv0aa11",
        slice: "OPR.0.5.2.9",
        seat: "dev50-driver@openrig-build",
        worktree_path: "/demo/openrig",
        branch: "release-0.5.2-gateway",
        head_sha: "fe92ffa9a",
        fragile_join: false,
        join_basis: "类型化演示工作节点",
        activity: { activity: "working", needs_input: { count: 0, reason: null }, decided_by: "活动 oracle", changed_at: "2026-08-06T11:58:30.000Z" },
        pickup: { state: "working" },
        source: { qitem_id: "qitem-20260806-drv0aa11" },
      }],
      q2_sequencing: [
        { slice_id: "OPR.0.5.2.5", dir: "crash-cart", depends_on: [], blocked_on_rows: [], next_up: false, next_up_basis: "声明完成", next_up_rank: null, source: { spec_path: "/demo/crash-cart/SPEC.md", arrangement_path: "/demo/crash-cart/slice.yaml", wave_map_row: "foundation" } },
        { slice_id: "OPR.0.5.2.9", dir: "gateway-m1", depends_on: ["OPR.0.5.2.5"], blocked_on_rows: [], next_up: false, next_up_basis: "认领进行中", next_up_rank: null, source: { spec_path: "/demo/gateway-m1/SPEC.md", arrangement_path: "/demo/gateway-m1/slice.yaml", wave_map_row: "active" } },
      ],
      q3_care: [
        { slice_id: "OPR.0.5.2.5", build_wave: "foundation", review_model: "independent", planning_dial: "P2" },
        { slice_id: "OPR.0.5.2.9", build_wave: "active", review_model: "independent", planning_dial: "P2" },
      ],
      q4_ladder: [
        {
          slice_id: "OPR.0.5.2.5", dir: "crash-cart",
          locked: { value: true, basis: "演示规格锁" },
          built: { candidate_sha: "0a1b2c3d4", resolved_commit: "0a1b2c3d4", basis: "演示候选" },
          reviewed: { value: true, basis: "演示评审证明", legs: [{ path: "/demo/crash-cart/proof/qa.md", verdict: "PASS", artifact_type: "qa", candidate_sha: "0a1b2c3d4" }] },
          folded: { value: true, basis: "演示 main 包含候选" },
          adopted: { value: true, basis: "演示后台服务构建" },
        },
        {
          slice_id: "OPR.0.5.2.9", dir: "gateway-m1",
          locked: { value: true, basis: "演示规格锁" },
          built: { candidate_sha: "fe92ffa9a", resolved_commit: "fe92ffa9a", basis: "演示候选" },
          reviewed: { value: false, basis: "评审待处理", legs: [] },
          folded: { value: false, basis: "不在演示 main 上" },
          adopted: { value: false, basis: "候选未上线" },
        },
      ],
      q5_park: [],
      q6_parallelism: { lanes_live: 1, lanes_possible: 1, idle_seats_with_capacity: { value: 2, basis: "演示活动" } },
    },
    attention: [
      { qitemId: "q1", state: "in-progress", destinationSession: "human-yeah@kernel", blockedOn: null, handedOffTo: null, tier: "human-gate", tags: null, summary: "0.5.0 切割包就绪 · 等待你", body: "", claimedAt: "2026-08-05T09:38:00.000Z", tsUpdated: "2026-08-05T09:38:00.000Z" },
      { qitemId: "q2", state: "pending", destinationSession: "human-yeah@kernel", blockedOn: null, handedOffTo: null, tier: "human-gate", tags: null, summary: "slice-20 路由像素 · 等待你", body: "", claimedAt: "2026-08-05T07:00:00.000Z", tsUpdated: "2026-08-05T07:00:00.000Z" },
    ],
    // PULSE ⧗ 被阻塞来源——形状如已发布 state=blocked 读取（所有
    // 被阻塞 qitem）。b1 是真实的智能体阻塞：blockedOn 是 qitem 指针
    // 且 blockerSession 携带已解析所有者（阻塞智能体——水合
    // 通过 GET /:qitemId 实时解析）。渲染排除人类阻塞的
    // （b2，blockedOn 中的会话）——它已出现在需要你下。
    blocked: [
      { qitemId: "b1", state: "blocked", destinationSession: "dev50-driver@openrig-build", blockedOn: "qitem-20260805-review", blockerSession: "review-r1@openrig-build", handedOffTo: null, tier: null, tags: ["mission:release-0.5.2", "slice:OPR.0.5.2.4"], summary: "51209941 的终端裁决", body: "", claimedAt: "2026-08-05T09:00:00.000Z", tsUpdated: "2026-08-05T09:00:00.000Z" },
      { qitemId: "b2", state: "blocked", destinationSession: "dev50-qa@openrig-build", blockedOn: "human-yeah@kernel", blockerSession: null, handedOffTo: null, tier: null, tags: ["mission:release-0.5.2", "slice:OPR.0.5.2.9"], summary: "等待人工签收", body: "", claimedAt: "2026-08-05T08:00:00.000Z", tsUpdated: "2026-08-05T08:00:00.000Z" },
    ],
    // PULSE ◌ 持棒暂停 + ● 现在来源——形状如已发布
    // state=in-progress 读取。guard qitem 是真实的暂停持棒（所有者
    // 空闲——见 seatActivity——无交接）。driver/planner/r1/lead qitem
    // 由活动席位拥有 → 它们出现在现在（有工作的运行席位），
    // 而非暂停。
    inProgress: [
      { qitemId: "qitem-20260806-8f3a1b2c", state: "in-progress", destinationSession: "dev50-guard@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: ["mission:release-0.5.2", "slice:OPR.0.5.2.6"], summary: "slice 51-06 D2 原子", body: "", claimedAt: "2026-08-06T10:50:00.000Z", tsUpdated: "2026-08-06T11:13:00.000Z" },
      { qitemId: "qitem-20260806-drv0aa11", state: "in-progress", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: ["mission:release-0.5.2", "slice:OPR.0.5.2.4"], summary: "pulse-view 增量构建", body: "", claimedAt: "2026-08-06T11:40:00.000Z", tsUpdated: "2026-08-06T11:58:00.000Z" },
      { qitemId: "qitem-20260806-pln0b220", state: "in-progress", destinationSession: "dev50-planner@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "IMPL-PLAN 增量-4 钻取", body: "", claimedAt: "2026-08-06T11:30:00.000Z", tsUpdated: "2026-08-06T11:57:00.000Z" },
      { qitemId: "qitem-20260806-r10c331", state: "in-progress", destinationSession: "review50-r1@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "评审增量-3 泳道", body: "", claimedAt: "2026-08-06T11:45:00.000Z", tsUpdated: "2026-08-06T11:59:00.000Z" },
      { qitemId: "qitem-20260806-led0d442", state: "in-progress", destinationSession: "orch-lead@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: ["mission:release-0.5.2", "slice:OPR.0.5.2.20"], summary: "折叠收据 0.5.2", body: "", claimedAt: "2026-08-06T11:50:00.000Z", tsUpdated: "2026-08-06T11:59:30.000Z" },
    ],
    // 每席位 ps/活动——现在 + 暂停连接的右侧（terminalActive
    // 空闲布尔 + 原始 lastActivityAt）。driver/planner/r1/lead 活动 → 现在；
    // guard 空闲（12:00 演示时钟前 47 分）→ 暂停；qa 无信号
    // （分离 → null，诚实未知 ≠ 空闲 → 两个泳道都不显示）。
    seatActivity: [
      { session: "dev50-driver@openrig-build", logicalId: "dev50.driver", terminalActive: true, lastActivityAt: "2026-08-06T11:58:30.000Z" },
      { session: "dev50-planner@openrig-build", logicalId: "dev50.planner", terminalActive: true, lastActivityAt: "2026-08-06T11:59:10.000Z" },
      { session: "review50-r1@openrig-build", logicalId: "review50.r1", terminalActive: true, lastActivityAt: "2026-08-06T11:59:20.000Z" },
      { session: "orch-lead@openrig-build", logicalId: "orch.lead", terminalActive: true, lastActivityAt: "2026-08-06T11:59:40.000Z" },
      { session: "dev50-guard@openrig-build", logicalId: "dev50.guard", terminalActive: false, lastActivityAt: "2026-08-06T11:13:00.000Z" },
      { session: "dev50-qa@openrig-build", logicalId: "dev50.qa", terminalActive: null, lastActivityAt: null },
    ],
    // PULSE ○ 下一个来源——形状如已发布 state=pending 读取
    //（未认领积压，服务 ts_created DESC → 原文携带）。六项
    // 练习显示上限溢出：视图渲染前四项 + "…"
    // 标记，头计数为真实总数（6）。
    pending: [
      { qitemId: "qitem-20260806-up000001", state: "pending", destinationSession: "orch-lead@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "RM 仪式 0.5.2", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:55:00.000Z" },
      { qitemId: "qitem-20260806-up000002", state: "pending", destinationSession: "dev50-qa@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "51-02 场景运行器", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:50:00.000Z" },
      { qitemId: "qitem-20260806-up000003", state: "pending", destinationSession: "dev50-qa@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "51-03 种子场景", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:45:00.000Z" },
      { qitemId: "qitem-20260806-up000004", state: "pending", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "增量-4 钻取 + 选择对等", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:40:00.000Z" },
      { qitemId: "qitem-20260806-up000005", state: "pending", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "增量-5 实时刷新接缝", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:35:00.000Z" },
      { qitemId: "qitem-20260806-up000006", state: "pending", destinationSession: "dev50-planner@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "文档清扫 sdlc-conventions", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:30:00.000Z" },
    ],
    // PULSE ✓ 刚完成来源——形状如已发布 state=done,handed-off
    // 读取（有界最近窗口）。以 ts_created 顺序服务；视图重新排序
    // 以 tsUpdated DESC（完成时间）→ 最新完成优先。
    recentlyFinished: [
      { qitemId: "qitem-20260806-fin00001", state: "done", destinationSession: "dev50-guard@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "slice-03 收尾", body: "", claimedAt: "2026-08-06T11:20:00.000Z", tsUpdated: "2026-08-06T11:44:00.000Z" },
      { qitemId: "qitem-20260806-fin00002", state: "handed-off", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: "review50-r1@openrig-build", tier: null, tags: null, summary: "现场折叠收据", body: "", claimedAt: "2026-08-06T10:40:00.000Z", tsUpdated: "2026-08-06T11:20:00.000Z" },
      { qitemId: "qitem-20260806-fin00003", state: "done", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "终端 CLEAR 51209941", body: "", claimedAt: "2026-08-06T10:20:00.000Z", tsUpdated: "2026-08-06T10:58:00.000Z" },
    ],
    // 此演示快照"水合"时——12:00 演示时钟前 2 秒，使
    // PULSE 页脚确定性地渲染"2 秒前更新"。
    hydratedAt: "2026-08-06T11:59:58.000Z",
    // 主机降级在旁组合（绝不投影到项形状中）
    hostsDown: [{ hostId: "remote-host", status: "unreachable", error: "读取超时" }],
    stream: [
      { tsEmitted: "2026-08-02T10:00:00.000Z", sourceSession: "dev50-guard@v-openrig-build", body: "网关已清除：slice-11 spike 裁决 PASS" },
      { tsEmitted: "2026-08-02T10:05:00.000Z", sourceSession: "orch-lead@v-openrig-build", body: "提供商重新认证在 mm2 上完成" },
    ],
    readErrors: [],
  };
}
