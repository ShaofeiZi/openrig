// OPR.0.4.4.11——topology-manifest parse/validate（FR-1：封闭 key set）。
//
// rejection 分支是这里的关键测试：key set 封闭本身就是 thin-manifest 强制规则（arch R11-1）；
// edge/routing rejection 必须点名 founder 批准的 non-goal。静默忽略未知 key 会暗中重新开放它。

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateTopologyManifest,
  loadTopologyManifest,
  hasTopLevelRigsList,
  yamlTextHasTopLevelRigsList,
} from "../src/domain/topology/topology-manifest.js";

const SRC = "/fixture/factory.rigtopology";

function errorsOf(res: ReturnType<typeof validateTopologyManifest>): string[] {
  return res.ok ? [] : res.errors;
}

describe("topology-manifest——有效结构", () => {
  it("最小单工作组 manifest 规范化为 concurrency 1（默认串行）", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "factory.yaml" }] }, SRC);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest).toEqual({ rigs: [{ source: "factory.yaml" }], concurrency: 1 });
    }
  });

  it("多工作组 manifest 支持逐 entry 主机放置与显式 concurrency，并保留顺序", () => {
    const res = validateTopologyManifest(
      {
        rigs: [
          { source: "./orch.yaml" },
          { source: "./workers/rig.yaml", host: "vps-b" },
          { source: "specs/watch.yaml" },
        ],
        concurrency: 2,
      },
      SRC,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.concurrency).toBe(2);
      expect(res.manifest.rigs.map((r) => r.source)).toEqual(["./orch.yaml", "./workers/rig.yaml", "specs/watch.yaml"]);
      expect(res.manifest.rigs[1].host).toBe("vps-b");
      expect(res.manifest.rigs[0].host).toBeUndefined();
    }
  });

  it("无扩展名 PATH 形式 spec entry 仍有效；spec path 无需扩展名，裸 NAME 才被拒绝", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "specs/myrig" }] }, SRC);
    expect(res.ok).toBe(true);
  });
});

describe("topology-manifest——封闭 key set（FR-1 rejection 分支）", () => {
  it("以 what/why/fix 结构拒绝非 object 文档", () => {
    const res = validateTopologyManifest("nope", SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("必须是顶层包含 'rigs' 列表的 YAML 对象");
  });

  it("分别拒绝缺失、非 list 或空 rigs", () => {
    expect(errorsOf(validateTopologyManifest({}, SRC))[0]).toContain("'rigs' 必须是");
    expect(errorsOf(validateTopologyManifest({ rigs: {} }, SRC))[0]).toContain("'rigs' 必须是");
    expect(errorsOf(validateTopologyManifest({ rigs: [] }, SRC))[0]).toContain("'rigs' 为空");
  });

  it("拒绝未知 MANIFEST 级 key，并点名封闭集合", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], banner: "x" }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("未知键 'banner'");
    expect(errorsOf(res)[0]).toContain("键集合封闭");
  });

  it("拒绝未知 ENTRY 级 key，并点名封闭 entry 集合", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml", retries: 3 }] }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("rigs[0]");
    expect(errorsOf(res)[0]).toContain("未知键 'retries'");
  });

  it("在 manifest 级拒绝跨工作组 edge/routing key，并点名 founder 批准的 non-goal", () => {
    for (const key of ["edges", "routing", "depends_on"]) {
      const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], [key]: [] }, SRC);
      expect(res.ok).toBe(false);
      const msg = errorsOf(res).find((e) => e.includes(`'${key}'`));
      expect(msg).toBeDefined();
      expect(msg).toContain("创建者批准的非目标");
      expect(msg).toContain("topology-Q1");
    }
  });

  it("在 ENTRY 级以相同 non-goal 消息拒绝 edge/routing key", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml", needs: ["b"] }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0];
    expect(msg).toContain("rigs[0]");
    expect(msg).toContain("'needs'");
    expect(msg).toContain("创建者批准的非目标");
  });

  it("以 v0 已移除 stop-on-failure 的消息拒绝 'on_failure'", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], on_failure: "continue" }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("v0 已移除 'on_failure'");
    expect(errorsOf(res)[0]).toContain("失败即停止");
  });

  it("逐 entry 拒绝错误 source/host 结构", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "  " }, { host: "h" }, { source: "ok.yaml", host: "" }, "not-an-object"] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.find((e) => e.includes("rigs[0].source"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[1].source"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[2].host"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[3]") && e.includes("必须是") && e.includes("对象"))).toBeDefined();
  });

  it("单次收集全部结构错误，逐 entry 报告而非 fail-fast", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "" }, { source: "b.yaml", extra: 1 }], concurrency: 0, edges: [] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.length).toBe(4); // edges + concurrency + rigs[0].source + rigs[1].extra
  });

  it("拒绝非正整数 concurrency 值", () => {
    for (const bad of [0, -1, 1.5, "2"]) {
      const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], concurrency: bad }, SRC);
      expect(res.ok).toBe(false);
      expect(errorsOf(res)[0]).toContain("'concurrency' 必须是正整数");
    }
  });
});

describe("topology-manifest——v0 source-form 边界（2026-07-05 架构裁定：只接受 SPEC PATH，parse-time）", () => {
  it(".rigbundle entry 拒绝时点名 v0 边界和直接单工作组启动 workaround（固定 FR-1 措辞）", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "./workers.rigbundle" }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0]!;
    expect(msg).toContain("rigs[0].source");
    expect(msg).toContain("只允许 SPEC PATH");
    expect(msg).toContain("逐条 targetRoot");
    expect(msg).toContain("直接启动该工作组；单工作组命令 'zrig up ./workers.rigbundle'");
  });

  it("裸 library/rig-name entry 拒绝时点名延期项和逐工作组启动 workaround", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "orchestrator" }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0]!;
    expect(msg).toContain("'orchestrator' 是裸库/工作组名称");
    expect(msg).toContain("只允许 SPEC PATH");
    expect(msg).toContain("zrig up orchestrator");
  });

  it("嵌套 .rigtopology entry 在 parse 时拒绝", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "./inner.rigtopology" }] }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("不支持嵌套拓扑 manifest");
  });

  it("form rejection 逐 entry 记录，并与其他错误一起收集而非 fail-fast", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "good.yaml" }, { source: "bad.rigbundle" }, { source: "barename" }] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.length).toBe(2);
    expect(errs[0]).toContain("rigs[1].source");
    expect(errs[1]).toContain("rigs[2].source");
  });
});

describe("topology-manifest——文件加载", () => {
  it("文件缺失时返回 canonical what/why/fix 错误，绝不抛出", () => {
    const res = loadTopologyManifest("/nonexistent/factory.rigtopology");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("在 /nonexistent/factory.rigtopology 未找到拓扑 manifest");
  });

  it("从磁盘加载并验证真实文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "topo-manifest-"));
    const p = join(dir, "factory.rigtopology");
    writeFileSync(p, "rigs:\n  - source: ./orch.yaml\n  - source: ./workers/rig.yaml\n    host: vps-b\nconcurrency: 2\n");
    const res = loadTopologyManifest(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.rigs).toHaveLength(2);
      expect(res.manifest.rigs[1]).toEqual({ source: "./workers/rig.yaml", host: "vps-b" });
      expect(res.manifest.concurrency).toBe(2);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("无法解析的 YAML 作为 topology 报错；已声明 kind 会绑定，不回落到 rig-spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "topo-manifest-"));
    const p = join(dir, "broken.rigtopology");
    writeFileSync(p, "rigs: [unclosed\n  - :::\n");
    const res = loadTopologyManifest(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("拓扑 manifest YAML 失败");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("topology-manifest——探测 sniff（router G-1 契约）", () => {
  it("hasTopLevelRigsList：只对顶层 rigs LIST 返回 true", () => {
    expect(hasTopLevelRigsList({ rigs: [] })).toBe(true);
    expect(hasTopLevelRigsList({ rigs: [{ source: "a" }], concurrency: 2 })).toBe(true);
    expect(hasTopLevelRigsList({ rigs: {} })).toBe(false); // not a list — extension is the escape hatch
    expect(hasTopLevelRigsList({ name: "factory", pods: [] })).toBe(false); // rig-spec shape
    expect(hasTopLevelRigsList(null)).toBe(false);
    expect(hasTopLevelRigsList([])).toBe(false);
    expect(hasTopLevelRigsList("rigs")).toBe(false);
  });

  it("yamlTextHasTopLevelRigsList：sniff 原始文本；无法解析的文本返回 false 并流向现有处理", () => {
    expect(yamlTextHasTopLevelRigsList("rigs:\n  - source: a\n")).toBe(true);
    expect(yamlTextHasTopLevelRigsList("name: factory\npods: []\n")).toBe(false);
    expect(yamlTextHasTopLevelRigsList("rigs: [unclosed\n  - :::\n")).toBe(false);
  });
});
