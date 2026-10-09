import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { routeSkills, type SkillsRouterFsOps, type RouteSkillsInput } from "../src/domain/bundle-skills-router.js";

// 第 6 项 / slice-05 Checkpoint 7.2：bundle-skills-router 纯函数测试。

function mockFs(initialFiles: Record<string, string> = {}): SkillsRouterFsOps & { _written: Map<string, string>; _mkdirpCalls: string[] } {
  const written = new Map<string, string>(Object.entries(initialFiles));
  const mkdirpCalls: string[] = [];
  return {
    _written: written,
    _mkdirpCalls: mkdirpCalls,
    exists: (p: string) => written.has(p),
    readFile: (p: string) => {
      const v = written.get(p);
      if (v === undefined) throw new Error(`mock 中未找到文件：${p}`);
      return v;
    },
    writeFile: (p: string, c: string) => { written.set(p, c); },
    mkdirp: (p: string) => { mkdirpCalls.push(p); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/skills";

function makeInput(overrides?: Partial<RouteSkillsInput>): RouteSkillsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredSkills: [],
    targetSkillsDir: TARGET,
    ...overrides,
  };
}

describe("routeSkills", () => {
  // R1：空 skills list 产生空 records，并仍会创建目标目录。
  it("空 declaredSkills 产生空 records，但仍创建目标目录", () => {
    const fs = mockFs();
    const result = routeSkills(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // R2：端到端路由一个 skill。
  it("路由一个 skill：源文件复制到目标且填充 installedAt", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/foo/SKILL.md`]: "# foo skill body",
    });
    const result = routeSkills(makeInput({ declaredSkills: ["skills/foo/SKILL.md"] }), fs);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/foo/SKILL.md`);
    expect(fs._written.get(`${TARGET}/foo/SKILL.md`)).toBe("# foo skill body");
  });

  // R3：路由多个 skill，并保留目录布局。
  it("路由多个 skill，并在目标下保留各 skill 的目录布局", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/foo/SKILL.md`]: "foo",
      [`${BUNDLE_ROOT}/skills/bar/SKILL.md`]: "bar",
      [`${BUNDLE_ROOT}/skills/bar/helper.md`]: "bar-helper",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md", "skills/bar/helper.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(3);
    expect(fs._written.get(`${TARGET}/foo/SKILL.md`)).toBe("foo");
    expect(fs._written.get(`${TARGET}/bar/SKILL.md`)).toBe("bar");
    expect(fs._written.get(`${TARGET}/bar/helper.md`)).toBe("bar-helper");
  });

  // R4：源文件缺失时产生 "missing" record（跳过而非错误）。
  it("源文件缺失时以 status=missing 跳过（真实作用域）", () => {
    const fs = mockFs(); // empty — no skill files
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/absent/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("不存在");
  });

  // R5：拒绝逃逸 bundle workspace 的不安全路径。
  it("拒绝逃逸 bundle workspace 的不安全声明路径（../traversal）", () => {
    const fs = mockFs();
    const result = routeSkills(
      makeInput({ declaredSkills: ["../escape/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("逃逸 bundle workspace");
  });

  // R6：混合列表，一次调用同时包含 routed、missing 和 unsafe。
  it("混合声明列表正确汇总 routed/missing/unsafe", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/ok/SKILL.md`]: "ok",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/ok/SKILL.md", "skills/absent/SKILL.md", "../escape/SKILL.md"] }),
      fs,
    );
    expect(result.records).toHaveLength(3);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
  });

  // R7-B1：目标端路径包含性（qitem-20260518215234-f84fff45 的 B1 修复）。声明路径
  // "skills/../outside/SKILL.md" 可通过源端包含性（前导 "skills/" 在 ../ 之前被消费，因此解析后
  // 位于 bundleRoot 下），但移除前导 "skills/" 后变为 "../outside/SKILL.md"，会逃逸
  // targetSkillsDir，必须拒绝。
  it("拒绝移除前缀后会逃逸目标 skills 目录的声明路径", () => {
    // 源文件位于 bundleRoot 下（通过源端包含性），但移除前缀后解析出的目标会逃逸目标目录。
    const fs = mockFs({
      // 源文件可通过 "skills/../outside/SKILL.md" 从 bundleRoot 访问，解析为
      // "<bundleRoot>/outside/SKILL.md"。
      [`${BUNDLE_ROOT}/outside/SKILL.md`]: "would-escape-target",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/../outside/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("逃逸 target skill library");
    // 关键点：目标之外没有发生写入。
    expect(fs._written.has(`${TARGET}/../outside/SKILL.md`)).toBe(false);
    expect(fs._written.has(nodePath.resolve(`${TARGET}/../outside/SKILL.md`))).toBe(false);
  });

  // R8：不以 "skills/" 开头的声明路径按原样处理（不移除前缀）。
  it("不含前导 skills/ 前缀的声明路径按原样路由", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/custom/path/X.md`]: "x",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["custom/path/X.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/custom/path/X.md`);
  });

  it("可将 package 形态的 bundle payload 保留在托管 catalog 之外，而不改变源查找", () => {
    const packageRoot = "/operator/.openrig/packages";
    const source = `${BUNDLE_ROOT}/packages/test-pkg/skills/DUAL.md`;
    const fs = mockFs({ [source]: "dual" });

    const result = routeSkills(makeInput({
      declaredSkills: ["packages/test-pkg/skills/DUAL.md"],
      targetSkillsDir: packageRoot,
      targetPrefixToStrip: "packages/",
    }), fs);

    expect(result).toMatchObject({ routedCount: 1, rejectedCount: 0 });
    expect(result.records[0]!.installedAt).toBe(`${packageRoot}/test-pkg/skills/DUAL.md`);
    expect(fs._written.get(`${packageRoot}/test-pkg/skills/DUAL.md`)).toBe("dual");
  });
});
