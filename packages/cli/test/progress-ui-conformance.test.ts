// OPR.0.4.0.33 FR-4——UI 契约符合性。脚手架模板和 `progress` 更新动词
// 必须写出 PROGRESS UI 数据源能解析的精确形态。本测试将真实脚手架及
// 真实动词输出交给真实 ProgressIndexer（作为纯读取器导入的后台服务解析器），
// 并断言解析后的树。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 后台服务的 PROGRESS indexer 是 UI 数据源。它只依赖 node:fs/node:path，
// 因此可作为独立纯读取器导入。
import { ProgressIndexer } from "../../daemon/src/domain/progress/progress-indexer.js";
import { renderMissionProgressTemplate, renderSliceProgressTemplate } from "../src/lib/scope/templates.js";
import { addProgressRow, setProgressRow } from "../src/lib/scope/progress-edit.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rig-ui-conf-"))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function indexerFor(): ProgressIndexer {
  return new ProgressIndexer({ roots: [{ name: "test", canonicalPath: root }], maxDepth: 8 });
}

describe("FR-4——脚手架输出解析为预期 UI 树", () => {
  it("任务目标脚手架：非空标题 + 验收标题 + 全部活动的复选框行", () => {
    const dir = path.join(root, "mission-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), renderMissionProgressTemplate("Mission A"), "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("mission-a"))!;
    expect(file).toBeDefined();
    expect(file.title).toBe("进度 — Mission A"); // 取自第一个 H1，而不是 frontmatter
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "验收")).toBe(true);
    expect(file.counts.total).toBe(4);
    expect(file.counts.active).toBe(4);
    expect(file.counts.done).toBe(0);
  });

  it("切片脚手架解析为非空标题和复选框行", () => {
    const dir = path.join(root, "slices", "01-x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), renderSliceProgressTemplate("Slice X"), "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("01-x"))!;
    expect(file.title).toBe("进度 — Slice X");
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "验收")).toBe(true);
    expect(file.counts.total).toBe(3);
  });
});

describe("FR-4——动词输出解析为预期 UI 树", () => {
  it("set→done 并添加 active/blocked 行后得到正确解析状态", () => {
    const dir = path.join(root, "slices", "02-updated");
    fs.mkdirSync(dir, { recursive: true });

    // 将真实动词逻辑应用于真实脚手架。
    let content = renderSliceProgressTemplate("Slice Updated");
    content = setProgressRow(content, { text: "实现完成", status: "done" }).content;
    content = addProgressRow(content, { section: "Rail", text: "Active thing", status: "active" }).content;
    content = addProgressRow(content, { section: "Rail", text: "Blocked thing", status: "blocked" }).content;
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), content, "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("02-updated"))!;
    expect(file.title).toBe("进度 — Slice Updated");

    const byText = (t: string) => file.rows.find((r) => r.kind === "checkbox" && r.text === t);
    expect(byText("实现完成")!.status).toBe("done");
    expect(byText("Active thing")!.status).toBe("active");
    expect(byText("Blocked thing")!.status).toBe("blocked");
    // 该动词创建了 `## Rail` 标题节点。
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "Rail")).toBe(true);
    expect(file.counts.done).toBe(1);
    expect(file.counts.blocked).toBe(1);
  });
});
