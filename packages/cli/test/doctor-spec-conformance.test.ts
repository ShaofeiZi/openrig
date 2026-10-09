// Build B — `rig doctor` spec-vs-live conformance check. RED-first.
//
// 此检查无法自发现其输入，而这是一个发现而非缺陷：没有任何东西
// 持久化运行中 rig 的 spec 路径。`rigs` 表无 spec/rigRoot 列，`rig_services.
// rig_root` 为空，`projection_manifest.source_spec` 为空。daemon 不记得
// 描述一个 rig 的文件来自何处。故检查显式接收 `--spec`，未给时
// 必须带原因跳过而非通过——一个找不到输入且保持沉默的检查，
// 与查过却未发现问题的检查无法区分。

import { describe, it, expect } from "vitest";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";

const SPEC_3_8 = `version: "0.2"
name: v-openrig-build
pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
      - id: advisor
  - id: dev
    label: Development
    members:
      - id: driver
      - id: guard
`;

function baseDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/tmp",
    readFile: () => null,
    exec: () => "tmux 3.4",
    checkPort: async () => true,
    configStore: {
      resolve: () => ({
        db: { path: "/tmp/openrig/openrig.sqlite" },
        transcripts: { path: "/tmp/openrig/transcripts" },
        daemon: { host: "127.0.0.1", port: 7433 },
      }),
    } as never,
    mkdirp: () => {},
    checkWritable: () => {},
    ...over,
  };
}

async function conformanceCheck(deps: DoctorDeps) {
  const { checks, asyncChecks } = runDoctorChecks(deps);
  const all = [...checks, ...(await Promise.all(asyncChecks))];
  return all.find((c) => c.name === "spec_live_conformance");
}

describe("rig doctor — spec vs live conformance", () => {
  it("SKIPS with the reason when no --spec is given — it must not read as a pass", async () => {
    const check = await conformanceCheck(baseDeps());
    expect(check).toBeDefined();
    expect(check!.status).toBe("skipped");
    // 原因必须说明为何无法自发现，否则下一位读者会提单。
    expect(`${check!.message} ${check!.reason ?? ""}`).toMatch(/not persisted|--spec/i);
  });

  it("PASSES silently when the spec matches the live rig — the negative control", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => ["orch.lead", "orch.advisor", "dev.driver", "dev.guard"],
    }));
    expect(check!.status).toBe("pass");
    expect(check!.message).not.toMatch(/absent|WARNING/i);
  });

  it("WARNS and names the real delta when the live rig has undeclared pods", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => [
        "orch.lead", "orch.advisor", "dev.driver", "dev.guard",
        "dev50.driver", "dev50.guard", "review50.r1",
      ],
    }));
    expect(check!.status).toBe("warn");
    expect(check!.message).toContain("dev50");
    expect(check!.message).toContain("review50");
    expect(check!.message).toContain("2 pods");
    expect(check!.message).toContain("4 seats");
  });

  it("SKIPS when the live topology cannot be read — absence of data is not conformance", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => null,
    }));
    expect(check!.status).toBe("skipped");
  });

  it("FAILS loudly when an explicitly-given spec path cannot be read", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/missing.yaml",
      readFile: () => null,
      fetchLiveLogicalIds: async () => ["orch.lead"],
    }));
    expect(check!.status).toBe("fail");
  });
});
