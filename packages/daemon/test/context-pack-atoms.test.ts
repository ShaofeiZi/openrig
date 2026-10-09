// OPR.0.5.3.5 微需求 1（原子 2）——安装原子声明组合元数据。
// 针对锁定规范 + 摄取 schema 先写 RED 测试（DESIGN-INTAKE-ATOM-SCHEMA，
// dev-planner 2026-08-22）：原子是地址加元数据，绝不是新文件——原子位于 pack manifest
//（每个 profile-library 唯一的元数据归属地）中，每个原子引用已声明的 pack 文件
//（可通过原子 1 语法附加 #header-path），并携带：taxonomy（创始人词汇）、regions
//（世界结构）、situations（组合代数选择器）、purpose depth|width、runtime claude|codex|any
//（微需求 3）、order、requires、priority（预算受限时优先丢弃的内容，微需求 9）和 probe
//（微需求 2：已变更行为、单 harness 结构）。token 数量在组合时派生，绝不存储
//（摄取层的易变性规则）——schema 刻意不含 token 字段。

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";

const BASE = `
name: world-install
version: "1"
taxonomy: world
files:
  - { path: 04-ontology.md, role: world }
  - { path: what-you-can-do.md, role: world }
  - { path: probes.yaml, role: probes }
`;

function withAtoms(atomsYaml: string): string {
  return `${BASE}atoms:\n${atomsYaml}`;
}

const GOOD_ATOM = `
  - id: ontology-width
    address: "04-ontology.md#affordances"
    taxonomy: world
    regions: [affordances, terrain]
    situations: [fresh, post-compaction]
    purpose: width
    runtime: claude
    order: 10
    priority: core
    probe:
      prompt: "某个 seat 询问有哪些动词可用于联系同伴。"
      expect: "无需重新读取安装内容即可说出 rig send/capture。"
`;

describe("context-pack 原子——解析与往返（微需求 1）", () => {
  it("不含 atoms 的 manifest 仍可解析（atoms 可选）", () => {
    const m = parseManifest(BASE, "m.yaml");
    expect(m.atoms).toBeUndefined();
  });

  it("有效原子可往返保留每个 schema 字段", () => {
    const m = parseManifest(withAtoms(GOOD_ATOM), "m.yaml");
    expect(m.atoms).toHaveLength(1);
    const a = m.atoms![0]!;
    expect(a).toMatchObject({
      id: "ontology-width",
      address: "04-ontology.md#affordances",
      taxonomy: "world",
      regions: ["affordances", "terrain"],
      situations: ["fresh", "post-compaction"],
      purpose: "width",
      runtime: "claude",
      order: 10,
      priority: "core",
    });
    expect(a.probe).toEqual({
      prompt: "某个 seat 询问有哪些动词可用于联系同伴。",
      expect: "无需重新读取安装内容即可说出 rig send/capture。",
    });
  });

  it("默认值：runtime 为 'any'；regions/requires/probe 可选", () => {
    const m = parseManifest(withAtoms(`
  - id: minimal
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 20
    priority: recommended
`), "m.yaml");
    const a = m.atoms![0]!;
    expect(a.runtime).toBe("any");
    expect(a.regions).toBeUndefined();
    expect(a.requires).toBeUndefined();
    expect(a.probe).toBeUndefined();
  });

  it("整文件原子（无 #）可引用任一已声明文件；标题寻址要求 Markdown", () => {
    const whole = parseManifest(withAtoms(`
  - id: probes-file
    address: probes.yaml
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 30
    priority: optional
`), "m.yaml");
    expect(whole.atoms![0]!.address).toBe("probes.yaml");
    expect(() => parseManifest(withAtoms(`
  - id: bad
    address: "probes.yaml#some-header"
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 31
    priority: optional
`), "m.yaml")).toThrow(/header|markdown/i);
  });
});

describe("context-pack 原子——显式失败校验", () => {
  const stub = (over: string) => withAtoms(`
  - id: a1
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
${over}`);

  it("拒绝重复的原子 id", () => {
    expect(() => parseManifest(stub(`
  - id: a1
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
`), "m.yaml")).toThrow(/a1.*重复/i);
  });

  it("拒绝指向未声明原子的 requires 引用及自引用", () => {
    expect(() => parseManifest(stub(`
  - id: a2
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    requires: [ghost]
`), "m.yaml")).toThrow(/ghost/);
    expect(() => parseManifest(withAtoms(`
  - id: selfy
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    requires: [selfy]
`), "m.yaml")).toThrow(/自身/);
  });

  it("拒绝 requires 循环——子集 profile 永远无法对其形成闭包", () => {
    expect(() => parseManifest(withAtoms(`
  - id: a
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    requires: [b]
  - id: b
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    requires: [a]
`), "m.yaml")).toThrow(/环/);
  });

  it("原子 4a：带 TREE 前缀的地址（project:/seat:/mission:）在摄取时合法——已声明文件规则仅适用于库引用", () => {
    // Q2 修订 1(c)：可组合内容不必位于库中。seat 范围的回顾原子声明 seat: 地址；
    // 文件位于 SEAT TREE 而非 pack 中，因此不得触发已声明文件检查。结构规则仍然有效：
    // 拒绝路径穿越，标题路径要求 Markdown。
    const m = parseManifest(withAtoms(`
  - id: project-intent
    address: "project:SPEC.md"
    taxonomy: mission
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
  - id: recap
    address: "seat:RECAP.md#recent-decisions"
    taxonomy: lore
    situations: [handover]
    purpose: width
    order: 90
    priority: core
`), "m.yaml");
    expect(m.atoms!.map((atom) => atom.address)).toEqual(["project:SPEC.md", "seat:RECAP.md#recent-decisions"]);
    expect(() => parseManifest(withAtoms(`
  - id: sneaky
    address: "seat:../LEARNED.md"
    taxonomy: lore
    situations: [handover]
    purpose: width
    order: 91
    priority: core
`), "m.yaml")).toThrow(/遍历/);
    expect(() => parseManifest(withAtoms(`
  - id: notmd
    address: "mission:data.yaml#x"
    taxonomy: mission
    situations: [fresh]
    purpose: depth
    order: 92
    priority: core
`), "m.yaml")).toThrow(/markdown/i);
  });

  it("拒绝引用未声明 pack 文件的地址", () => {
    expect(() => parseManifest(withAtoms(`
  - id: stray
    address: "not-in-pack.md#x"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`), "m.yaml")).toThrow(/not-in-pack\.md/);
  });

  it("通过唯一语法拒绝格式错误的地址（显式失败，原子 1 规则）", () => {
    expect(() => parseManifest(withAtoms(`
  - id: bad
    address: "04-ontology.md#a#b"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`), "m.yaml")).toThrow(/#/);
  });

  // 超时根据实测高负载场景设定（主机负载 70 时为 12 秒），而非使用默认值：
  // 上限若等于高负载实测值，会成为不稳定测试的来源。
  it("r1 F1：深层 requires 链仍处于显式失败通道内——任何深度都不会逸出 RangeError", { timeout: 120_000 }, () => {
    // r1 的实测判别项：递归 visit() 在 n=5000 时栈溢出，RangeError 不含 atoms[i]、id
    // 或路径——绕过了模块头部承诺的通道。Pack 从 URL 安装（slice-07 R4），因此深度可由
    // 攻击者选择，任何阈值都不安全。
    const N = 8000;
    const entries: string[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(
        `  - id: a${i}\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${i}\n    priority: core${i < N - 1 ? `\n    requires: [a${i + 1}]` : ""}`,
      );
    }
    const m = parseManifest(withAtoms(entries.join("\n")), "m.yaml");
    expect(m.atoms).toHaveLength(N); // 解析成功——该链合法，只是很深
    // 同一深度的循环仍会通过正确通道被拒绝。
    const cyclic = entries.join("\n") + `\n  - id: z\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${N}\n    priority: core\n    requires: [z2]\n  - id: z2\n    address: 04-ontology.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    order: ${N + 1}\n    priority: core\n    requires: [z]`;
    expect(() => parseManifest(withAtoms(cyclic), "m.yaml")).toThrow(/环/i);
  });

  it("r1 F2：原子条目中的未知键会被明确拒绝——拼写错误绝不能静默丢弃元数据", () => {
    // r1 的实测判别项：`require:`（requires 的拼写错误）可正常解析，但依赖边静默消失——
    // 正是该字段意在防止、却未产生错误的故障。摄取层知道合法键集合。
    expect(() => parseManifest(stub(`
  - id: a2
    address: what-you-can-do.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    order: 2
    priority: core
    require: [a1]
`), "m.yaml")).toThrow(/未知字段 'require'/);
    expect(() => parseManifest(withAtoms(`
  - id: x
    address: 04-ontology.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
    probes: { prompt: p, expect: e }
`), "m.yaml")).toThrow(/未知字段 'probes'/);
  });

  it("拒绝错误枚举和结构：taxonomy、空 situations、purpose、runtime、order、priority、残缺 probe", () => {
    const cases: Array<[string, RegExp]> = [
      ["taxonomy: cosmos", /taxonomy/],
      ["situations: []", /situations/],
      ["purpose: girth", /purpose/],
      ["runtime: gemini", /runtime/],
      ["order: 1.5", /order/],
      ["priority: urgent", /priority/],
      ["probe: { prompt: only-half }", /probe/],
    ];
    for (const [line, want] of cases) {
      const good: Record<string, string> = {
        taxonomy: "taxonomy: world",
        situations: "situations: [fresh]",
        purpose: "purpose: depth",
        runtime: "",
        order: "order: 1",
        priority: "priority: core",
        probe: "",
      };
      const key = line.split(":")[0]!;
      good[key] = line;
      const yaml = withAtoms(`
  - id: x
    address: 04-ontology.md
    ${good["taxonomy"]}
    ${good["situations"]}
    ${good["purpose"]}
    ${good["runtime"]}
    ${good["order"]}
    ${good["priority"]}
    ${good["probe"]}
`);
      expect(() => parseManifest(yaml, "m.yaml"), `用例：${line}`).toThrow(want);
    }
  });
});
