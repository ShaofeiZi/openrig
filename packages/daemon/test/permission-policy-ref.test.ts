// Slice-03（OPR.0.4.8.3）接缝 B——permission_policy REF resolver 的 RED 钉扎：
// validate/classify（builtin、custom、reserved、invalid）、flag-surface launch-posture 解析
//（README v4 d65afe67：YOLO/Operator = full_bypass，其余均为 floor），以及
// member > rig > floor 优先级。以 README v4 A1/A2/A3 固定 ref/none 语义。
import { describe, it, expect } from "vitest";
import {
  validatePermissionPolicyRef,
  classifyPermissionPolicyRef,
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  builtinPackageTarget,
  BUILTIN_POLICY_NAMES,
} from "../src/domain/permission-policy/policy-ref.js";

const FLAG_FULL_BYPASS = `---\nsource: custom\nname: operator-clone\nsurface: flag\nlaunch_posture: full_bypass\npolicy_schema_version: 1\ndescription: a custom operator-style flag policy\n---\nbody\n`;
const CONFIG_POLICY = `---\nsource: custom\nname: my-config\nsurface: config\ndefault_posture: ask\nallow: []\nask: []\ndeny: []\ndestructive_class: []\npolicy_schema_version: 1\ndescription: a custom config policy\n---\nbody\n`;

describe("permission_policy ref——校验（A1/A2/A3）", () => {
  it("通过必填 builtin: 前缀接受所有已打包 built-in", () => {
    for (const name of BUILTIN_POLICY_NAMES) {
      expect(validatePermissionPolicyRef(`builtin:${name}`, "permission_policy")).toBeNull();
    }
  });

  it("拒绝未知 built-in 名称，并以结构化错误列出已知集合", () => {
    const err = validatePermissionPolicyRef("builtin:bogus", "permission_policy");
    expect(err).toBeTruthy();
    expect(err).toMatch(/未知内置策略/);
    // 列出已知集合，使错误可执行。
    for (const name of BUILTIN_POLICY_NAMES) expect(err).toContain(name);
  });

  it("拒绝裸 canonical 名称（builtin: 前缀必填，不允许 shadowing）", () => {
    expect(validatePermissionPolicyRef("standard", "permission_policy")).toBeTruthy();
  });

  it("接受相对 custom ref（相对于声明它的 RigSpec 目录解析）", () => {
    expect(validatePermissionPolicyRef("policies/team.md", "permission_policy")).toBeNull();
    expect(validatePermissionPolicyRef("team.md", "permission_policy")).toBeNull();
  });

  it("以结构化错误拒绝绝对路径、.. 穿越和空 segment ref（绝不回退到 floor）", () => {
    expect(validatePermissionPolicyRef("/etc/policy.md", "permission_policy")).toMatch(/绝对路径/);
    expect(validatePermissionPolicyRef("../secret.md", "permission_policy")).toMatch(/路径穿越|\.\./);
    expect(validatePermissionPolicyRef("a//b.md", "permission_policy")).toMatch(/空路径 segment/);
  });

  it("'none' 是已记录的有意选择——按裁定修订有效（RULED-FORM-deliberate-none-2026-08-04，sha256 5f37e40f；取代 A3 预留错误，是该修订唯一获准的封闭 surface 变更）", () => {
    expect(validatePermissionPolicyRef("none", "permission_policy")).toBeNull();
  });

  it("拒绝空值或仅空白字符", () => {
    expect(validatePermissionPolicyRef("", "permission_policy")).toBeTruthy();
    expect(validatePermissionPolicyRef("   ", "permission_policy")).toBeTruthy();
  });
});

describe("permission_policy ref——分类 origin（如实呈现 origin）", () => {
  it("将 builtin ref 分类为 origin=builtin 并携带已校验名称", () => {
    expect(classifyPermissionPolicyRef("builtin:yolo")).toEqual({ ref: "builtin:yolo", origin: "builtin", builtinName: "yolo" });
  });
  it("将 custom ref 分类为 origin=custom", () => {
    expect(classifyPermissionPolicyRef("policies/team.md")).toEqual({ ref: "policies/team.md", origin: "custom" });
  });
});

describe("permission_policy——跨重启稳定的 attachment 解析（Guard 裁定 2026-08-04）", () => {
  const noFile = { readFile: () => { throw new Error("no file"); } };

  it("builtin:yolo → full_bypass、origin=builtin 和 PM 裁定的 package-copy target（绝不回显 builtin:<name>）", () => {
    const a = resolvePermissionPolicyAttachment("builtin:yolo", "/rig", noFile);
    expect(a).toMatchObject({ ref: "builtin:yolo", origin: "builtin", builtinName: "yolo", launchPosture: "full_bypass" });
    // PM 行内裁定（由 9e94c274 的 dev-guard NOT-CLEAR 得出）：resolved target 是 package-relative
    // canonical 副本，而不是原始 ref 的回显。
    expect(a.resolvedTarget).toBe("policies/builtin/yolo.policy.md");
  });

  it("Policy-Mode built-in 解析为 floor，并携带 PM 裁定的 package-copy target", () => {
    for (const name of ["locked", "standard", "open"]) {
      const a = resolvePermissionPolicyAttachment(`builtin:${name}`, "/rig", noFile);
      expect(a.origin).toBe("builtin");
      expect(a.launchPosture).toBe("floor");
      expect(a.resolvedTarget).toBe(`policies/builtin/${name}.policy.md`);
    }
  });

  it("builtinPackageTarget 将四个裁定名称精确钉扎到 package-relative 副本", () => {
    for (const name of ["locked", "standard", "open", "yolo"] as const) {
      expect(builtinPackageTarget(name)).toBe(`policies/builtin/${name}.policy.md`);
    }
  });

  it("CUSTOM flag policy 可以是 full_bypass——内容相对于声明目录解析（core 所有）", () => {
    const a = resolvePermissionPolicyAttachment("policies/operator.md", "/rig/spec", { readFile: () => FLAG_FULL_BYPASS });
    expect(a.origin).toBe("custom");
    expect(a.surface).toBe("flag");
    expect(a.launchPosture).toBe("full_bypass"); // 不是 floor——这是裁定的关键。
    expect(a.resolvedTarget).toBe("/rig/spec/policies/operator.md"); // 跨重启稳定的绝对 target。
    expect(a.declaringDir).toBe("/rig/spec"); // 跨重启稳定的 provenance。
    expect(a.ref).toBe("policies/operator.md"); // 保留原始 ref 用于导出。
  });

  it("CUSTOM config policy 解析为 floor（推迟 config-surface 内容应用，不写 config）", () => {
    const a = resolvePermissionPolicyAttachment("policies/team.md", "/rig", { readFile: () => CONFIG_POLICY });
    expect(a.origin).toBe("custom");
    expect(a.surface).toBe("config");
    expect(a.launchPosture).toBe("floor");
  });

  it("不可读 CUSTOM ref → 建议性 floor，但仍保留 ref + provenance", () => {
    const a = resolvePermissionPolicyAttachment("policies/missing.md", "/rig", noFile);
    expect(a.launchPosture).toBe("floor");
    expect(a.ref).toBe("policies/missing.md");
    expect(a.resolvedTarget).toBe("/rig/policies/missing.md");
    expect(a.origin).toBe("custom");
  });
});

describe("permission_policy——优先级（member > rig > floor）", () => {
  it("member ref 覆盖 rig ref", () => {
    expect(resolvePermissionPolicyRefValue("builtin:yolo", "builtin:locked")).toBe("builtin:yolo");
  });
  it("member 无 ref 时回退到 rig ref", () => {
    expect(resolvePermissionPolicyRefValue(undefined, "builtin:standard")).toBe("builtin:standard");
  });
  it("两个层级都缺席时解析为 undefined（= floor）", () => {
    expect(resolvePermissionPolicyRefValue(undefined, undefined)).toBeUndefined();
    expect(resolvePermissionPolicyRefValue(null, null)).toBeUndefined();
  });
});
