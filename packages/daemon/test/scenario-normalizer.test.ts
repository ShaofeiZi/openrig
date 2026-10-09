import { describe, it, expect } from "vitest";
import {
  projectSurface,
  buildDeclarativeNormalizer,
  isEqualsMapping,
  rigOf,
  ProjectionError,
} from "./helpers/scenario-normalizer.js";
import { validateScenario } from "./helpers/scenario-schema.js";

// 51-03——声明式跨 surface mapping。A-N1：这是面向 scenario 的唯一形式，并降低到 runner 内部接缝。

describe("projectSurface——声明哪个字段承载共享事实", () => {
  it("从数组 surface 提取字段并去重排序（集合语义）", () => {
    const ps = [{ name: "b-rig" }, { name: "a-rig" }, { name: "a-rig" }];
    expect(projectSurface(ps, { pluck: "name" })).toEqual(["a-rig", "b-rig"]);
  });

  it("将 canonical session 名缩减为 rig——同一 rig 上的 N 个 qitem 合并为一个", () => {
    const queue = [
      { destinationSession: "dev-worker@scn-baton" },
      { destinationSession: "dev-qa@scn-baton" },
    ];
    expect(projectSurface(queue, { pluck: "destinationSession", rig: true })).toEqual(["scn-baton"]);
  });

  it("真正空输入返回空结果，但真实数据一无所获时抛错", () => {
    expect(projectSurface([], { pluck: "name" })).toEqual([]);
    expect(projectSurface(null, { pluck: "name" })).toEqual([]);
    // 非空输入且零提取项意味着声明损坏，并非达成一致。
    expect(() => projectSurface([{ other: 1 }], { pluck: "name" })).toThrow(ProjectionError);
  });

  it("投影前读取对象 surface 的嵌套路径", () => {
    expect(projectSurface({ state: { screen: "topology" } }, { path: "state.screen" })).toBe("topology");
  });

  it("rigOf 取最后一个 @ 后的部分，并原样传递裸名称", () => {
    expect(rigOf("dev-worker@scn-baton")).toBe("scn-baton");
    expect(rigOf("bare")).toBe("bare");
  });
});

describe("buildDeclarativeNormalizer——降低到接缝", () => {
  it("应用每个 surface 的声明投影，并原样传递未声明的 surface", () => {
    const n = buildDeclarativeNormalizer({
      ps: { pluck: "name" },
      queue: { pluck: "destinationSession", rig: true },
    });
    expect(n("ps", [{ name: "scn-baton" }])).toEqual(["scn-baton"]);
    expect(n("queue", [{ destinationSession: "dev-worker@scn-baton" }])).toEqual(["scn-baton"]);
    // 未声明投影的 surface 不会被静默清空。
    expect(n("stream", [{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it("区分声明式 mapping 与 legacy surface list", () => {
    expect(isEqualsMapping({ ps: { pluck: "name" } })).toBe(true);
    expect(isEqualsMapping(["tui_socket", "ps", "queue"])).toBe(false);
  });

  it("真正不一致的两个 surface 不会归一化为相等（固定项有效）", () => {
    const n = buildDeclarativeNormalizer({ ps: { pluck: "name" }, queue: { pluck: "destinationSession", rig: true } });
    expect(n("ps", [{ name: "scn-baton" }])).not.toEqual(n("queue", [{ destinationSession: "w@other-rig" }]));
  });
});

// a7b6b7c85 的守卫发现已在本地复现：单边证伪破坏一侧（name -> rigId）并正确失败，因此比较在
// 差异轴上对值敏感，但无法检测空值。证伪只能覆盖其扰动的轴；以下测试覆盖其他轴。
describe("单边证伪无法触及的轴", () => {
  it("对称空值：两边都提取缺失字段时必须明确失败，绝不能比较为相等", () => {
    const n = buildDeclarativeNormalizer({
      ps: { pluck: "nosuchfield" },
      queue: { pluck: "alsomissing" },
    });
    // 两个不同的非空 surface；修复前二者都会变成 [] 并通过。
    expect(() => n("ps", [{ name: "scn-baton" }])).toThrow(ProjectionError);
    expect(() => n("queue", [{ destinationSession: "w@scn-baton" }])).toThrow(ProjectionError);
    let msg = "";
    try { n("ps", [{ name: "scn-baton" }]); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("未从非空 surface");
    expect(msg).toContain("nosuchfield");
  });

  it("空输入得到空结果仍合法——surface 可以确实不含内容", () => {
    const n = buildDeclarativeNormalizer({ queue: { pluck: "destinationSession", rig: true } });
    expect(n("queue", [])).toEqual([]);
  });

  it("部分匹配的投影不抛错（提取到部分数据是真实答案）", () => {
    const n = buildDeclarativeNormalizer({ ps: { pluck: "name" } });
    expect(n("ps", [{ name: "a" }, { other: 1 }])).toEqual(["a"]);
  });
});

describe("加载时拒绝（TypeError 绝不能成为第一信号）", () => {
  const base = (equals: unknown) => ({
    scenario: "s", topology: "t.yaml",
    steps: [{ expect: { surface: "ps", equals } }],
  });
  const codes = (doc: unknown) => {
    const r = validateScenario(doc);
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it("拒绝单 surface equals——单边比较在结构上就是空洞的", () => {
    expect(codes(base({ ps: { pluck: "name" } }))).toContain("EQUALS_TOO_FEW_SURFACES");
  });

  it("拒绝空 equals mapping", () => {
    expect(codes(base({}))).toContain("EQUALS_TOO_FEW_SURFACES");
  });

  it("拒绝 LEGACY list 形式，并指出声明式形式", () => {
    expect(codes(base(["ps", "queue"]))).toContain("EQUALS_NOT_DECLARATIVE");
  });

  it("在加载时拒绝非字符串 path，而不是在 runtime 抛错", () => {
    expect(codes(base({ ps: { path: 123 }, queue: { pluck: "x" } }))).toContain("EQUALS_PROJECTION_INVALID");
  });

  it("接受结构良好的双 surface 声明式 mapping", () => {
    const r = validateScenario(base({ ps: { pluck: "name" }, queue: { pluck: "destinationSession", rig: true } }));
    expect(r.ok).toBe(true);
  });
});
