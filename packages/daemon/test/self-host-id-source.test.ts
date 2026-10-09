// Slice 14 §2c——如实推导本主机身份的来源。
//
// `self_host_identity` 只存储 host_id / minted_at / reconciled_at，不存任何出处，因此没有可读记录。
// 可推导的就推导，不可推导的明确标为 INDETERMINATE 而非猜测；把未知读成已知正是本 slice
// 要解决的缺陷，而确实由人命名的机器绝不能报告为 `generated`。

import { describe, it, expect } from "vitest";
import { deriveSelfHostIdSource } from "../src/domain/seat-identity-reconciler.js";

describe("deriveSelfHostIdSource", () => {
  it("配置的 host.name 等于实时 id 时报告 named", () => {
    expect(deriveSelfHostIdSource("mm2-openrig1", "mm2-openrig1")).toBe("named");
    expect(deriveSelfHostIdSource("mm2-openrig1", "  mm2-openrig1  ")).toBe("named");
  });

  it("无人命名主机且 id 呈回退形状时报告 generated", () => {
    expect(deriveSelfHostIdSource("host-84c37990", null)).toBe("generated");
    expect(deriveSelfHostIdSource("host-84c37990", "   ")).toBe("generated");
  });

  // 绝不能说谎的场景：操作人员随后设置 host.name 时，reconciler 保留已生成 id
  //（持久身份绝不静默改 key）并发出警告。此后名称与 id 不一致；该机器确实已命名，
  // 因而报告 `generated` 会成为虚假声明。
  it("配置名称与实时 id 不一致时报告 indeterminate", () => {
    expect(deriveSelfHostIdSource("host-84c37990", "mm2-openrig1")).toBe("indeterminate");
  });

  // 真实路径，也是初版处理错误的场景。SettingsStore 将 host.name 默认为 "localhost"，
  // 这是 reconciler 拒绝用作 seed 的保留展示 token；因此新生成主机的候选值虽存在却不可用，
  // 仅检查是否存在会把最普通的未命名机器错误报告为 `indeterminate`。
  it("host.name 保持未修改的默认值 'localhost' 时报告 generated", () => {
    expect(deriveSelfHostIdSource("host-84c37990", "localhost")).toBe("generated");
    expect(deriveSelfHostIdSource("host-84c37990", "LocalHost")).toBe("generated");
  });

  // 对生成分支拒绝的其他 seed 采用相同规则：保留 token 和格式非法名称都会回退到生成 id，
  // 因此都必须读为 `generated`，而非 `indeterminate`。
  it("对 seed reconciler 会拒绝的任意值报告 generated", () => {
    for (const refused of ["local", "kernel", "host", "external", "a/b", ".hidden", "  "]) {
      expect(deriveSelfHostIdSource("host-84c37990", refused), `seed ${JSON.stringify(refused)}`).toBe("generated");
    }
  });

  it("未命名主机的 id 不符合任一来源时报告 indeterminate", () => {
    expect(deriveSelfHostIdSource("some-legacy-id", null)).toBe("indeterminate");
    expect(deriveSelfHostIdSource("host-NOTHEX0", null)).toBe("indeterminate");
  });

  it("尚无 id 时完全不报告（启动对账前）", () => {
    expect(deriveSelfHostIdSource(null, "mm2-openrig1")).toBeNull();
    expect(deriveSelfHostIdSource("", "mm2-openrig1")).toBeNull();
    expect(deriveSelfHostIdSource(undefined, undefined)).toBeNull();
  });
});
