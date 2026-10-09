import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { executionContentLines, executionSliceStripLines } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot } from "../src/types.js";
import { strWidth } from "../src/text-width.js";

const REPO_BASIS = "no reachable repo context (no EC-3 worktree on the board)";

function sliceFromTerminalColumn(line: string, columns: number): string {
  let index = 0;
  let used = 0;
  for (const char of line) {
    if (used >= columns) break;
    used += strWidth(char);
    index += char.length;
  }
  return line.slice(index);
}

/** 形状如 live daemon 的投影：slice 1 被认领且工作中，slice 2
 *  空闲带 needs-input 标志与一行 parked，slice 3 折叠，其余
 *  built-or-unrecorded，build 之上阶梯因同一原因为 INDETERMINATE。 */
function executionFixture(count = 4): NonNullable<FleetSnapshot["execution"]> {
  const ids = Array.from({ length: count }, (_, index) => `OPR.0.5.8.${index + 1}`);
  const built = (index: number) => index % 2 === 0 ? { candidate_sha: `sha${index}00000000`, resolved_commit: "INDETERMINATE", basis: `candidate:* tag on row qitem-${index + 1}` } : { candidate_sha: "INDETERMINATE", basis: "no candidate:* tag on any row bound to this slice" };
  return {
    view: "execution",
    mission: "release-0.5.8",
    derived_at: "2026-09-01T21:00:00.000Z",
    sources: {
      queue_db: { asof: "2026-09-01T21:00:00.000Z", basis: "queue_items at read time" },
      arrangement: { manifest: "/work/mission.yaml", basis: "mission.yaml composition order" },
      git: { basis: "no reachable repo context" },
      build_info: { commit: "257f47e93bdc48b8142f32135cafdbc748fccc46" },
    },
    q1_lanes: ids.slice(0, 2).map((slice, index) => ({
      qitem_id: `qitem-${index + 1}`,
      slice,
      seat: `dev-${index + 1}@rig`,
      worktree_path: "INDETERMINATE",
      branch: "INDETERMINATE",
      head_sha: "INDETERMINATE",
      fragile_join: true,
      join_basis: "row/branch naming only (EC-3 field absent — legacy baton)",
      activity: {
        activity: index === 0 ? "working" : "idle-at-prompt",
        needs_input: { count: index === 1 ? 1 : 0, reason: index === 1 ? "permission prompt" : null },
        decided_by: index === 0 ? "自报" : "window-sampling",
        changed_at: "2026-09-01T20:58:12.000Z",
      },
      pickup: { state: index === 0 ? "working" : "parked" },
      source: { qitem_id: `qitem-${index + 1}` },
    })),
    q2_sequencing: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      depends_on: index === 3 ? [ids[2]] : [],
      blocked_on_rows: [],
      next_up: index < 2 ? false : index === 3 ? true : "INDETERMINATE",
      next_up_basis: index < 2 ? "already claimed in-progress" : index === 3 ? "deps met, unclaimed" : `own completion rung INDETERMINATE (${REPO_BASIS})`,
      next_up_rank: index === 3 ? 1 : null,
      source: { spec_path: `/work/${slice}/SPEC.md`, arrangement_path: `/work/${slice}/slice.yaml`, wave_map_row: "INDETERMINATE" },
    })),
    q3_care: ids.map((slice, index) => ({
      slice_id: slice,
      build_wave: index === 2 ? "foundation" : index === 3 ? "next-unlock" : "active-parallel",
      review_model: "INDETERMINATE",
      planning_dial: "INDETERMINATE",
    })),
    q4_ladder: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      locked: { value: false, basis: "no approved-spec-at in frontmatter" },
      built: index === 2 ? { candidate_sha: "fold000000", resolved_commit: "fold000000", basis: "candidate:* tag on row qitem-9" } : built(index),
      reviewed: index === 2
        ? { value: true, basis: "/proof/review.md", legs: [{ path: "/proof/review.md", verdict: "CLEAR", artifact_type: "rev1-r2", candidate_sha: "fold000000" }] }
        : { value: "INDETERMINATE", basis: REPO_BASIS, legs: [] },
      folded: index === 2 ? { value: true, basis: "git merge-base" } : { value: "INDETERMINATE", basis: REPO_BASIS },
      adopted: index === 2 ? { value: false, basis: "daemon build stamp differs" } : { value: "INDETERMINATE", basis: REPO_BASIS },
    })),
    q5_park: [
      { qitem_id: "qitem-1", pickup_state: "working", park_kind: "indeterminate", park_kind_basis: "no armed wake row", wake_target: null, age_minutes: 3, source: { qitem_id: "qitem-1" } },
      { qitem_id: "qitem-2", pickup_state: "parked", park_kind: "indeterminate", park_kind_basis: "no armed wake row", wake_target: null, age_minutes: 41, source: { qitem_id: "qitem-2" } },
    ],
    q6_parallelism: { lanes_live: 2, lanes_possible: 1, idle_seats_with_capacity: { value: 7, basis: "arbitrated idle-at-prompt" } },
  };
}

function executionScopes(count = 4, status: (index: number) => string = (index) => (index === 0 ? "active" : "done")): NonNullable<FleetSnapshot["scopes"]> {
  const template = demoSnapshot().scopes![0]!.slices[0]!;
  return [{
    mission: "release-0.5.8",
    slices: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `OPR.0.5.8.${index + 1}`,
      dirName: `${String(index + 1).padStart(2, "0")}-slice`,
      displayName: `Slice ${String(index + 1).padStart(2, "0")} — Readable Name ${index + 1}`,
      status: status(index),
      proof: { paired: index === 1 ? 0 : 4, total: index === 1 ? 0 : 4 },
    })),
  }];
}

/** 重新打开 slice 的已装 0.5.8 状态：每 slice 声明 done，无 live
 *  lane，无可达仓库——故 reviewed/merged/live 全为 INDETERMINATE。 */
function installedStateFixture(count = 20): { execution: NonNullable<FleetSnapshot["execution"]>; scopes: NonNullable<FleetSnapshot["scopes"]> } {
  const execution = executionFixture(count);
  execution.q1_lanes = [];
  execution.q5_park = [];
  for (const item of execution.q2_sequencing) {
    item["next_up"] = "INDETERMINATE";
    item["next_up_basis"] = `own completion rung INDETERMINATE (${REPO_BASIS})`;
    item["next_up_rank"] = null;
    item["blocked_on_rows"] = [];
  }
  for (const item of execution.q4_ladder) {
    item["reviewed"] = { value: "INDETERMINATE", basis: "no repo context to resolve candidate identity through", legs: [] };
    item["folded"] = { value: "INDETERMINATE", basis: REPO_BASIS };
    item["adopted"] = { value: "INDETERMINATE", basis: REPO_BASIS };
  }
  return { execution, scopes: executionScopes(count, () => "done") };
}

const GLYPH_BLOB = /[○✓?]{5}/;

function text(lines: ReturnType<typeof executionContentLines>): string {
  return lines.map((line) => line.text).join("\n");
}

function executionKeys(lines: ReturnType<typeof executionContentLines>): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    if (line.action?.type === "execution-open") keys.push(line.action.key);
    for (const zone of line.zones ?? []) if (zone.action.type === "execution-open") keys.push(zone.action.key);
  }
  return [...new Set(keys)];
}

describe("mission 执行叙事——shipped projections 上的可读行", () => {
  it("在窄宽下于 mission、wave、slice 页显示 authored 准入与部分接受及来源", () => {
    const fixture = executionFixture();
    fixture.planning_guidance = [
      { label: "Integration decision", text: "Alpha core accepted; full contract remains open.", source: "/work/mission.yaml#arrangement.source.rule" },
      { label: "Admission", text: "Implement alpha before beta; investigation may overlap.", source: "/work/mission.yaml#arrangement.waves[0].admission", wave: "active-parallel" },
      { label: "Review", text: "Independent review must precede merge.", source: "/work/mission.yaml#arrangement.waves[0].review", wave: "active-parallel" },
      { label: "Exit", text: "Full contracts still need the cumulative journey.", source: "/work/mission.yaml#arrangement.waves[0].exit", wave: "active-parallel" },
    ];
    const facts = JSON.stringify(fixture);
    for (const width of [58, 120]) for (const key of [null, "group:wave:active-parallel", "slice:OPR.0.5.8.1"]) {
      const lines = executionContentLines(fixture, executionScopes(), [], key, width);
      const body = text(lines).replace(/\s+/g, " ");
      expect(body).toContain("撰写指导");
      expect(body).toContain("Alpha core accepted; full contract remains open.");
      if (key) {
        expect(body).toContain("Implement alpha before beta; investigation may overlap.");
        expect(body).toContain("Full contracts still need the cumulative journey.");
      } else expect(executionKeys(lines)).toContain("group:wave:active-parallel");
      expect(body).toContain("/work/mission.yaml");
      if (key?.startsWith("group:")) expect(body).toContain("Independent review must precede merge.");
      // 完整 guidance 换行，而非消失在裁剪卡后。
      expect(lines.filter(line => line.text.includes("Alpha core") || line.text.includes("Implement alpha")).every(line => line.text.length <= width)).toBe(true);
    }
    expect(JSON.stringify(fixture)).toBe(facts);
  });

  it("渲染所选 JRN-03 mission grammar：glance 摘要、wave 图、结构化详情卡", () => {
    const overview = executionContentLines(executionFixture(), executionScopes(), [], null, 126);
    const body = text(overview);
    expect(body).toMatch(/现在\s+/);
    expect(body).toMatch(/需要人类\s+/);
    expect(body).toMatch(/进度\s+/);
    expect(body).toMatch(/下一个\s+/);
    expect(body).toMatch(/┌─ .*OPR\.0\.5\.8\.1/);
    expect(body).toContain("之后: OPR.0.5.8.3");
    expect(body).toContain("└");
    const firstSlice = overview.find((line) => line.zones?.some((zone) => zone.action.type === "execution-open"));
    expect(firstSlice).toBeDefined();

    const detail = text(executionContentLines(executionFixture(), executionScopes(), [], "slice:OPR.0.5.8.1", 126));
    for (const title of ["归属", "证据", "需要你", "类型化行", "依赖"])
      expect(detail).toContain(title);
  });

  it("窄宽下堆叠每个 mission 节点，溢出交给内容滚动条", () => {
    const lines = executionContentLines(executionFixture(12), executionScopes(12), [], null, 58);
    const body = text(lines);
    expect(body).toContain("波次");
    expect(body).not.toMatch(/\d+ below|\+\d+ more/);
    expect(executionKeys(lines).filter((key) => key.startsWith("slice:"))).toHaveLength(12);
    expect(body.split("\n").every((line) => line.length <= 58)).toBe(true);
  });

  it("REGRESSION (founder journey)：所有 slice 声明 done + 无 lane + 无仓库时不得渲染 WAITING 或字形团", () => {
    const { execution, scopes } = installedStateFixture();
    const lines = executionContentLines(execution, scopes, [], null, 110 - 32);
    const body = text(lines);
    expect(body).not.toMatch(/WAITING/);
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toMatch(/\bp\d+\/\d+\b/);
    expect(body).not.toContain("@—");
    expect(body).not.toMatch(/\?\?/);
    // 声明状态保留并归因；证据缺口是一个紧凑的 mission 级 drill
    expect(body).toContain("release-0.5.8 · 结果开放 · 20 个切片");
    expect(body).toContain("0/20 结果完成 · 0 工作中");
    const gap = lines.find((line) => line.text.includes("证据缺口"))!;
    expect(gap.text).toContain("来源");
    expect(gap.text).toContain("证据缺口");
    expect(gap.action).toEqual({ type: "execution-open", key: "evidence" });
    expect(body.split("证据缺口").length - 1).toBe(1);
    // 每个 wave 头只数声明词，绝不作投影未作的工作状态裁决
    const headers = lines.filter((l) => l.text.includes("波次 "));
    expect(headers.length).toBeGreaterThan(0);
    for (const line of headers) expect(line.text).toMatch(/\d+ 已声明完成/);
    // 缺口页命名依据并列出受影响 slice，每个是自己的 drill
    const page = executionContentLines(execution, scopes, [], "evidence", 160);
    expect(text(page)).toContain("Git：        no reachable repo context");
    // 每个盲点在首个未确认梯级命名一次，带自己的依据
    expect(text(page)).toContain("已构建未确认 · 10 个切片");
    expect(text(page)).toContain("依据：       no repo context to resolve candidate identity through");
    expect(text(page)).toContain("已构建未确认 · 10 个切片");
    expect(text(page)).toContain("依据：       no candidate:* tag on any row bound to this slice");
    expect(page.filter((line) => line.action?.type === "execution-open" && (line.action as { key: string }).key.startsWith("slice:")).length).toBe(20);
  });

  it("按 wave 顺序把每个 slice 显示一次，用普通词表达真实 assignment、evidence、proof、next", () => {
    const lines = executionContentLines(executionFixture(), executionScopes(), [], null, 160);
    const body = text(lines);
    expect(body).toContain("release-0.5.8 · 结果开放 · 4 个切片");
    expect(body).toContain("0/4 结果完成 · 1 工作中 · 1 等待");
    expect(body).toContain("波次 active-parallel · 2 个切片 · 1 工作中, 1 需要输入");
    expect(body).toContain("波次 foundation · 1 个切片 · 1 已声明完成");
    expect(body).toContain("波次 next-unlock · 1 个切片 · 1 已声明完成");
    for (const id of ["OPR.0.5.8.1", "OPR.0.5.8.2", "OPR.0.5.8.3", "OPR.0.5.8.4"]) {
      expect(body.split(`┌─ ${id}`).length - 1, id).toBe(1);
    }
    expect(body).toContain("● 工作中");
    expect(body).toContain("归属: dev-1");
    expect(body).toContain("◐ 需要输入");
    expect(body).toContain("归属: dev-2");
    expect(body).toContain("○ 已声明完成");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(executionKeys(lines).filter((key) => key.startsWith("slice:"))).toHaveLength(4);
  });

  it("release workflow 仍等待时对 slice 完成做限定", () => {
    const fixture = executionFixture();
    fixture.q1_lanes = [];
    fixture.lifecycle_instances = [{ instance_id: "WF", status: "waiting", frontier_packets: [] }];
    const body = text(executionContentLines(fixture, executionScopes(4, () => "done"), [], null, 160));
    expect(body).toContain("切片: 结果开放");
    expect(body).toContain("任务目标生命周期 · 等待");
  });

  it("渲染每个 lifecycle frontier 包、未解决 occurrence 与具名未知项", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{
      instance_id: "WF-LIFE",
      status: "active",
      operation_key: "release-op",
      frontier_packets: [
        { packet_id: "Q-LEFT", step_id: "left", owner: "left@rig", queue_state: "in-progress", blocked_on: null, targeted_action: "rig workflow project --instance WF-LIFE --current-packet Q-LEFT" },
        { packet_id: "Q-RIGHT", step_id: "right", owner: "right@rig", queue_state: "blocked", blocked_on: "gate-2", targeted_action: "rig workflow project --instance WF-LIFE --current-packet Q-RIGHT" },
      ],
      failure_occurrences: [
        { occurrence_id: "Q-FAILED", step_id: "build", status: "unresolved", failure_reason: "fixture red", targeted_action: "rig workflow resume WF-LIFE --occurrence Q-FAILED --actor-session <you>" },
      ],
      unknowns: ["frontier packet Q-GHOST has no queue row"],
    }];
    const overview = text(executionContentLines(fixture, executionScopes(), [], null, 200));
    expect(overview).toContain("工作流");
    expect(overview).toContain("left · in-progress · left@rig");
    expect(overview).toContain("right · blocked · right@rig");
    expect(overview).not.toContain("--current-packet");
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-LIFE", 200));
    expect(body).toContain("fixture red");
    expect(body).toContain("--occurrence Q-FAILED");
    expect(body).toContain("frontier packet Q-GHOST has no queue row");
    const work = text(executionContentLines(fixture, executionScopes(), [], "packet:Q-RIGHT", 200));
    expect(work).toContain("gate-2");
    expect(work).toContain("--current-packet Q-RIGHT");
  });

  it("在 frontier 到达前显示具名 project 边界与缺失 receipts", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{ instance_id: "WF-PROFILE", status: "active", operation_key: "release",
      graph_source: { mode: "project-profile", profileSource: "/project.yaml#lifecycle.profiles.release" },
      boundary_obligations: [
        { stepId: "exact-cut-substance", required: true, state: "pending", receiptState: "missing", receipt: null },
        { stepId: "record-shipped", required: true, state: "closed", receiptState: "recorded", receipt: { evidenceRef: "proof/ship.md", actorSession: "orch@rig" } },
      ],
    }];
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-PROFILE", 120));
    expect(body).toContain("project-profile");
    expect(body).toContain("exact cut substance · 必需 · 待处理 · 收据 缺失");
    expect(body).toContain("record shipped · 必需 · closed · 收据 已记录");
    expect(body).toContain("proof/ship.md");
    expect(body).toContain("orch@rig");
    expect(body).toContain("它不建立验收");
  });

  it("让 typed 接受动作在每个生产终端宽度下可用", () => {
    const fixture = executionFixture();
    const candidate = "0123456789abcdef0123456789abcdef01234567";
    const evidence = "missions/release-0.5.9/slices/06-project-release-lifecycle/proof/review50-r2-CLEAR-27354de779a9a7d4311b910e56115df33d26295e.md";
    fixture.lifecycle_instances = [{
      instance_id: "WF-ACCEPTANCE",
      status: "active",
      operation_key: "release-acceptance",
      frontier_packets: [{
        packet_id: "qitem-acceptance-packet",
        step_id: "accept",
        owner: "review50-r2@v-openrig-build",
        queue_state: "in-progress",
        blocked_on: null,
        targeted_action: `rig workflow project --instance WF-ACCEPTANCE --current-packet qitem-acceptance-packet --exit done --actor-session review50-r2@v-openrig-build --acceptance-candidate '${candidate}' --acceptance-verdict 'CLEAR' --acceptance-evidence-ref '${evidence}'`,
      }],
      failure_occurrences: [],
      unknowns: [],
    }];
    const snap = {
      ...demoSnapshot(),
      scopes: executionScopes(),
      execution: fixture,
      executionMission: fixture.mission,
      hydratedAt: "2026-09-03T20:00:00.000Z",
    };
    for (const size of [{ cols: 84, rows: 28 }, { cols: 120, rows: 34 }, { cols: 160, rows: 42 }]) {
      const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
      view.dispatch(parseCommand(":scopes"));
      view.dispatch({ type: "scopes-mission-open", mission: fixture.mission });
      view.dispatch({ type: "execution-open", key: "packet:qitem-acceptance-packet" });

      let screen = renderScreen(view.get(), snap, size);
      view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      let action: string | null = null;
      for (let offset = 0; offset <= screen.contentMaxOffset && action == null; offset++) {
        const tooWide = screen.lines.map((line, index) => ({ index, width: strWidth(line), line })).filter((item) => item.width > size.cols);
        expect(tooWide, `${size.cols}x${size.rows}`).toEqual([]);
        const content = screen.lines.map((line) => sliceFromTerminalColumn(line, screen.explorerWidth + 2).trimEnd());
        let cursor = content.findIndex((line) => line.trimStart().startsWith("动作 rig workflow project"));
        if (cursor >= 0) {
          let candidate = content[cursor]!.replace(/^\s*动作 /, "");
          while (candidate.endsWith("\\") && cursor + 1 < content.length && !content[cursor + 1]!.trimStart().startsWith("滚动 ")) {
            candidate += `\n${content[++cursor]!}`;
          }
          if (!candidate.endsWith("\\")) action = candidate;
        }
        if (action == null && offset < screen.contentMaxOffset) {
          view.dispatch({ type: "content-scroll", delta: 1 });
          screen = renderScreen(view.get(), snap, size);
        }
      }
      expect(action, `${size.cols}x${size.rows}: complete action is scroll-reachable`).not.toBeNull();
      const argv = execFileSync("/bin/sh", ["-c", `set -- ${action}\nprintf '%s\\0' "$@"`])
        .toString()
        .split("\0")
        .filter(Boolean);
      expect(argv, `${size.cols}x${size.rows}`).toEqual([
        "rig", "workflow", "project",
        "--instance", "WF-ACCEPTANCE",
        "--current-packet", "qitem-acceptance-packet",
        "--exit", "done",
        "--actor-session", "review50-r2@v-openrig-build",
        "--acceptance-candidate", candidate,
        "--acceptance-verdict", "CLEAR",
        "--acceptance-evidence-ref", evidence,
      ]);
      expect(action, `${size.cols}x${size.rows}`).not.toContain("…");
    }
  });

  it("按显示宽度换行 CJK 单引号参数，并保持 argv 字节相同", () => {
    const fixture = executionFixture();
    // 单引号内为长中文参数：窄列下必须由 splitQuotedWord 按显示宽度分块，
    // 且重构后交给真实 shell 切分得到的 argv 与原机器命令逐字一致。
    const cjkNote = "这是一段很长的中文验收说明，用于验证单引号内中文参数在窄列下按显示宽度折行，且 shell 参数切分逐字保持一致不会被破坏";
    fixture.lifecycle_instances = [{
      instance_id: "WF-CJK",
      status: "active",
      operation_key: "release-cjk",
      frontier_packets: [{
        packet_id: "qitem-cjk",
        step_id: "accept",
        owner: "review@v-openrig-build",
        queue_state: "in-progress",
        blocked_on: null,
        targeted_action: `rig workflow project --instance WF-CJK --current-packet qitem-cjk --note '${cjkNote}'`,
      }],
      failure_occurrences: [],
      unknowns: [],
    }];
    const snap = {
      ...demoSnapshot(),
      scopes: executionScopes(),
      execution: fixture,
      executionMission: fixture.mission,
      hydratedAt: "2026-10-08T20:00:00.000Z",
    };
    for (const size of [{ cols: 84, rows: 28 }, { cols: 120, rows: 34 }]) {
      const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
      view.dispatch(parseCommand(":scopes"));
      view.dispatch({ type: "scopes-mission-open", mission: fixture.mission });
      view.dispatch({ type: "execution-open", key: "packet:qitem-cjk" });
      let screen = renderScreen(view.get(), snap, size);
      view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      let action: string | null = null;
      for (let offset = 0; offset <= screen.contentMaxOffset && action == null; offset++) {
        const tooWide = screen.lines.map((line) => ({ width: strWidth(line) })).filter((i) => i.width > size.cols);
        expect(tooWide, `${size.cols}x${size.rows}`).toEqual([]);
        const content = screen.lines.map((line) => sliceFromTerminalColumn(line, screen.explorerWidth + 2).trimEnd());
        let cursor = content.findIndex((line) => line.trimStart().startsWith("动作 rig workflow project"));
        if (cursor >= 0) {
          let candidate = content[cursor]!.replace(/^\s*动作 /, "");
          while (candidate.endsWith("\\") && cursor + 1 < content.length && !content[cursor + 1]!.trimStart().startsWith("滚动 ")) {
            candidate += `\n${content[++cursor]!}`;
          }
          if (!candidate.endsWith("\\")) action = candidate;
        }
        if (action == null && offset < screen.contentMaxOffset) {
          view.dispatch({ type: "content-scroll", delta: 1 });
          screen = renderScreen(view.get(), snap, size);
        }
      }
      expect(action, `${size.cols}x${size.rows}: complete CJK action is scroll-reachable`).not.toBeNull();
      const argv = execFileSync("/bin/sh", ["-c", `set -- ${action}\nprintf '%s\\0' "$@"`])
        .toString()
        .split("\0")
        .filter(Boolean);
      expect(argv, `${size.cols}x${size.rows}`).toEqual([
        "rig", "workflow", "project",
        "--instance", "WF-CJK",
        "--current-packet", "qitem-cjk",
        "--note", cjkNote,
      ]);
      expect(action, `${size.cols}x${size.rows}`).not.toContain("…");
    }
  });

  it("保持 terminal 失败历史可见，不渲染不可能的 resume 命令", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{
      instance_id: "WF-ABORTED",
      status: "aborted",
      operation_key: "release-op",
      frontier_packets: [],
      failure_occurrences: [
        { occurrence_id: "Q-FAILED", step_id: "build", status: "unresolved", failure_reason: "historical failure", targeted_action: null },
      ],
      unknowns: [],
    }];
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-ABORTED", 200));
    expect(body).toContain("已中止");
    expect(body).toContain("Q-FAILED");
    expect(body).toContain("historical failure");
    expect(body).not.toContain("rig workflow resume");
  });

  it("在 110 与 160 列下让每个 graph drill 可操作项保持在界内", () => {
    for (const width of [110 - 32, 160 - 32]) {
      const lines = executionContentLines(executionFixture(), executionScopes(), [], null, width);
      const drillable = lines.filter((line) => line.action);
      expect(executionKeys(lines).length).toBeGreaterThan(4);
      for (const line of drillable) {
        expect(line.text.endsWith("(打开 ▸)")).toBe(true);
        expect(strWidth(line.text)).toBeLessThanOrEqual(width);
      }
      for (const line of lines) for (const zone of line.zones ?? []) {
        expect(zone.start).toBeGreaterThanOrEqual(0);
        expect(zone.end).toBeLessThanOrEqual(width);
      }
    }
    const narrow = text(executionContentLines(executionFixture(), executionScopes(), [], null, 110 - 32));
    expect(narrow).toContain("● 工作中");
    expect(narrow).toContain("归属: dev-1");
    expect(narrow).toContain("◐ 需要输入");
    expect(narrow).toContain("归属: dev-2");
    expect(narrow).toContain("证据缺口");
  });

  it("把结构化 blocker 渲染为词，blocker 居首，绝不 [object Object]", () => {
    const fixture = executionFixture();
    const blocked = fixture.q2_sequencing[3]!;
    blocked["next_up"] = false;
    blocked["next_up_basis"] = "blocked rows present (qitem-20260902074725-404326e1)";
    blocked["blocked_on_rows"] = [{ qitem_id: "qitem-20260902074725-404326e1", blocked_on: "qitem-20260902074704-b1a445fa" }];
    const body = text(executionContentLines(fixture, executionScopes(), [], null, 160));
    expect(body).toContain("需要人类 OPR.0.5.8.2");
    expect(body).not.toContain("需要人类 OPR.0.5.8.2, OPR.0.5.8.4");
    expect(body).toContain("已阻塞");
    expect(body).toContain("波次 next-unlock · 1 个切片 · 1 已阻塞");
    expect(body).not.toContain("[object Object]");
    const page = text(executionContentLines(fixture, [], [], "slice:OPR.0.5.8.4", 160));
    expect(page).toMatch(/已阻塞于:\s+qitem-20260902074725-404326e1 等待 qitem-20260902074704-b1a445fa/);
  });

  it("让大 wave 中每个 slice 可直接选中，无遗漏门", () => {
    const fixture = executionFixture(14);
    const overview = executionContentLines(fixture, executionScopes(14), [], null, 160);
    expect(text(overview)).not.toMatch(/\+\d+ more|\d+ below|open all \d+ rows/);
    expect(executionKeys(overview).filter((key) => key.startsWith("slice:"))).toHaveLength(14);
    const page = executionContentLines(fixture, executionScopes(14), [], "group:wave:active-parallel", 160);
    expect(text(page)).toContain("波次 active-parallel · 全部 12 行");
    expect(text(page)).not.toMatch(/\+\d+ more/);
    expect(executionKeys(page).filter((key) => key.startsWith("slice:"))).toHaveLength(12);
  });

  it("区分 pending、failed、served-empty 的 projection 读取", () => {
    const failure = text(executionContentLines(null, [], ["execution: daemon read failed: GET /api/views/execution → 500"], null, 100));
    expect(failure).toContain("执行投影不可用 — 执行: 后台服务读取失败");
    expect(text(executionContentLines(null, [], [], null, 100, true))).toContain("读取挂起");
    expect(text(executionContentLines(null, [], [], null, 100, false))).toContain("后台服务上未解析到活跃任务目标");
  });
});

describe("execution drill——源起单页，esc 返回", () => {
  it("slice 页显示 declared 与 evidence，每个 rung 用词表达其 basis、sequencing、proof 与 lane", () => {
    const body = text(executionContentLines(executionFixture(), executionScopes(), [], "slice:OPR.0.5.8.3", 100));
    expect(body).toContain("OPR.0.5.8.3 · Slice 03 — Readable Name 3");
    expect(body).toContain("证据 · 已声明完成 · 已合并");
    expect(body).toMatch(/已构建:\s+fold00000/);
    expect(body).toMatch(/已合并:\s+yes · git merge-base/);
    expect(body).toMatch(/活跃:\s+no · daemon build stamp differs/);
    expect(body).toMatch(/评审腿:\s+CLEAR · rev1-r2 · \/proof\/review.md/);
    expect(body).toMatch(/下一个:\s+未派生下一转换/);
    expect(body).toMatch(/规范:\s+\/work\/OPR\.0\.5\.8\.3\/SPEC\.md/);
    expect(body).toContain("依赖");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).toContain("Esc 返回");
  });

  it("lane 页命名 qitem、seat、activity oracle 与脆弱的 repo join", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-2", 100));
    expect(body).toContain("泳道 OPR.0.5.8.2 · dev-2@rig");
    expect(body).toContain("需要输入: 1");
    expect(body).toContain("permission prompt");
    expect(body).toContain("仓库关联 · 脆弱");
    expect(body).toContain("工作树"); expect(body).toContain("INDETERMINATE");
    expect(body).toContain("41 分钟前认领");
  });

  it("新快照已不再持有的已打开 key 会如此说明，而非留空", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-gone", 100));
    expect(body).toContain("lane:qitem-gone 不在当前快照");
    expect(body).toContain("Esc 返回");
  });

  it("slice 条保持 declared 与 evidence 分离，绝不伪造 assignment", () => {
    const { execution } = installedStateFixture(4);
    const strip = text(executionSliceStripLines(execution, "OPR.0.5.8.1", "01-slice", 200, "done"));
    expect(strip).toContain("执行 · 无认领泳道 · 波次 active-parallel");
    expect(strip).toContain("已声明    完成 (切片文件)");
    expect(strip).toContain("证据    已构建 sha000000 · 已评审 / 已合并 / 活跃 未确认 (no repo context to resolve candidate identity through)  (打开 ▸)");
    expect(strip).toContain("分配  无 — 无认领泳道");
    expect(strip).toContain("下一步      无 — 已声明完成");
    expect(strip).not.toMatch(/WAITING|[○✓?]{5}/);
    const live = text(executionSliceStripLines(executionFixture(), "OPR.0.5.8.1", "01-slice", 120, "active"));
    expect(live).toContain("执行 · 工作中 · 波次 active-parallel");
    expect(live).toContain("分配  dev-1@rig · 工作中 (自报)");
  });

  it("经 SCOPES mission 选择渲染，打开丰富 slice 详情，并保留源 drill", () => {
    const demo = demoSnapshot();
    const scopes = [...demo.scopes!, ...executionScopes()];
    const snap = { ...demo, scopes, execution: executionFixture(), executionMission: "release-0.5.8", hydratedAt: "2026-09-01T21:00:00.000Z" };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    let screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    let body = screen.lines.join("\n");
    expect(body).toContain("release-0.5.8 · 结果开放");
    expect(body).toContain("证据缺口");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toContain("WAITING");
    const target = screen.contentTargets.find((t) => t.action.type === "execution-open" && t.action.key === "slice:OPR.0.5.8.1")!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    body = screen.lines.join("\n");
    expect(body).toContain("01-slice · OPR.0.5.8.1 · release-0.5.8");
    expect(body).toContain("归属");
    expect(body).toContain("证据 · 已声明活跃");
    const reachable = [body];
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    while (view.get().contentOffset < screen.contentMaxOffset) {
      view.dispatch({ type: "content-scroll", delta: 16 });
      screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
      reachable.push(screen.lines.join("\n"));
    }
    body = reachable.join("\n");
    expect(body).toContain("── 意图 ");
    expect(body).toContain("── 证明 · 4/4 已配对");
    expect(body).toContain("类型化行");
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    const gap = screen.contentTargets.find((t) => (t.action as { key?: string }).key === "evidence")!;
    view.dispatch(gap.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("证据缺口 · 派生于");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("波次 active-parallel");
    expect(view.get().executionOpen).toBeNull();
  });
});


describe("常规执行路径中带归属的 proof 来源", () => {
  function judged(kind = "artifact", state = "accepted") {
    const execution = executionFixture(1);
    execution.q1_lanes = [];
    execution.q4_ladder[0]!["built"] = { candidate_sha: "INDETERMINATE", basis: "no candidate:* tag on any row bound to this slice" };
    execution.readiness = {
      revision: "mission-revision", state: state === "accepted" ? "ready" : "未知",
      slices: [{ scope: "01-slice", readiness: {
        configured: true, revision: "proof-revision", state: state === "accepted" ? "ready" : "未知",
        issues: [], history: [{ ref: "proof/judgments/00000001.md", id: "receipt-1", verdict: "accept", previous: null }],
        items: [{ id: "item-1", index: 1, text: "An attributed outcome", state,
          reason: state === "未知" ? "Evidence missing or changed; inspect the retained judgment" : "Observed outcome",
          judgment: { id: "receipt-1", actor: "judge@rig", at: "2026-09-09T05:00:00Z", verdict: "accept", previous: null,
            subject: { kind, ref: "outcome.md", ...(kind === "patch-equivalent" ? { comparison: "comparison.md" } : {}) },
            evidence: [{ ref: "outcome.md", sha256: "a".repeat(64) }] },
        }],
      } }],
    } as NonNullable<typeof execution.readiness>;
    return execution;
  }

  it.each(["artifact", "patch-equivalent", "commit"])("shows %s judgment from the execution revision without inventing code lineage", kind => {
    const execution = judged(kind);
    const overview = executionContentLines(execution, undefined, [], null, 100);
    expect(overview.find(line => line.text.includes("来源"))?.action).toEqual({ type: "execution-open", key: "evidence" });
    expect(text(overview)).not.toContain("evidence gap 1/1 unknown");
    const page = text(executionContentLines(execution, undefined, [], "evidence", 100));
    for (const value of ["proof-revision", "ACCEPTED", kind, "outcome.md", "judge@rig", "receipt-1", "a".repeat(64)]) expect(page).toContain(value);
    if (kind === "patch-equivalent") expect(page).toContain("comparison.md");
    const slice = text(executionContentLines(execution, undefined, [], "slice:OPR.0.5.8.1", 100));
    expect(slice).toContain("ACCEPTED");
    expect(slice).toContain("judge@rig");
    expect(slice).toContain("代码谱系");
    expect(slice).toContain("undetermined");
    expect(text(executionSliceStripLines(execution, "OPR.0.5.8.1", "01-slice", 100))).toContain("证明 就绪");
  });

  it.each(["withdrawn", "rejected", "未知"])("keeps %s disposition and retained receipt distinct from current acceptance", state => {
    const execution = judged("artifact", state);
    const body = text(executionContentLines(execution, undefined, [], "evidence", 100));
    expect(body).toContain(state.toUpperCase());
    expect(body).toContain("receipt-1");
    expect(body).not.toContain("ACCEPTED");
    if (state === "未知") expect(body).toContain("Evidence missing or changed");
  });

  it("保持已配置缺失判断、无效 journal 与遗留代码缺口可见", () => {
    const execution = judged();
    const proof = execution.readiness!.slices[0]!.readiness;
    proof.items = []; proof.state = "未知";
    (proof as typeof proof & { issues: string[] }).issues = ["journal_invalid: malformed or changed judgment"];
    const page = text(executionContentLines(execution, undefined, [], "evidence", 100));
    expect(page).toContain("journal_invalid");
    expect(page).toContain("未知");
    delete execution.readiness;
    expect(text(executionContentLines(execution, undefined, [], "evidence", 100))).toContain("已构建未确认");
  });
});
