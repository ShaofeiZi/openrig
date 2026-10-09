import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

// 0.5.2-07 A2-3——ENUMERATION 守卫（反增量围栏）。
//
// 本 slice 杀的 bug 是从增量推理：OPR.0.4.6.PI1 在 ONE restore 站点修了 model-drop，
// 51-07 A1 只在 FRESH 分支穿了 -m/--model，两者都让兄弟 launch 分支（codex fork/resume）
// 静默把 spec 钉死的 seat 退回 runtime 默认。本守卫钉住整个类：每个 seat-launch 命令模板都穿
// SPEC model，而那个不是 seat launch 的命令构造器（buildNativeResumeCommand——metadata/
// inventory 展示）按此枚举。新 launch 分支若掉 model，在此 loudly 失败。

const SRC = nodePath.resolve(fileURLToPath(import.meta.url), "../../src");
const read = (rel: string): string => readFileSync(nodePath.join(SRC, rel), "utf-8");

function allSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSrcFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("0.5.2-07 A2-3——model-fidelity enumeration 守卫", () => {
  it("codex adapter：fresh + fork 命令模板穿 modelArg", () => {
    const src = read("adapters/codex-runtime-adapter.ts");
    const templates = [...src.matchAll(/`codex\$\{[^`]*`/g)].map((m) => m[0]);
    const seatLaunches = templates.filter((t) => / fork| -C /.test(t));
    // fresh（-C）+ fork 是两个内联模板；resume 经 buildCodexResumeCore（见下）。
    expect(seatLaunches.length).toBeGreaterThanOrEqual(2);
    for (const t of seatLaunches) {
      expect(t, `codex seat-launch 模板必须传递 modelArg:\n${t}`).toContain("modelArg");
    }
  });

  it("codex adapter：resume 分支把 model 传给 buildCodexResumeCore", () => {
    const src = read("adapters/codex-runtime-adapter.ts");
    // LAUNCH resume 调用穿 binding.launchPosture、model，然后是精确预计算的 posture 段。
    // 后者防止 W3 observation 重新决策 policy。
    expect(src).toMatch(/buildCodexResumeCore\([^;]*binding\.launchPosture,\s*model,\s*postureArg,\s*daemonOptOut\)/);
  });

  it("claude adapter：每个 claude seat-launch 模板穿 modelArg", () => {
    const src = read("adapters/claude-code-adapter.ts");
    const templates = [...src.matchAll(/`(?:\$\{rendererPrefix\})?claude \$\{[^`]*`/g)].map((m) => m[0]);
    const seatLaunches = templates.filter((t) => /--resume|--session-id|--fork-session/.test(t));
    // fresh（--session-id）、resume（--resume … --name）、fork（--resume … --fork-session）。
    expect(seatLaunches.length).toBeGreaterThanOrEqual(3);
    for (const t of seatLaunches) {
      expect(t, `claude seat-launch 模板必须传递 modelArg:\n${t}`).toContain("modelArg");
    }
  });

  it("legacy resume 构造器（claude-resume + codex-resume）穿 model", () => {
    const claudeResume = read("adapters/claude-resume.ts");
    expect(claudeResume).toMatch(/const modelArg = model \?/);
    expect(claudeResume).toMatch(/\$\{modelArg\}.*--resume/);
    const codexResume = read("adapters/codex-resume.ts");
    // codex-resume 把 `model` 穿到 buildCodexResumeCore 的 model 参数。
    expect(codexResume).toMatch(/buildCodexResumeCore\([\s\S]*?\n\s*model,\n/);
  });

  it("共享 buildCodexResumeCore 接受 model 参数并在 resume 子命令前发 -m", () => {
    const src = read("domain/native-resume-probe.ts");
    expect(src).toMatch(/model\?: string \| null,\n\s*\/\*\*[^]*?\*\/\n\s*precomputedPostureArg\?: string,\n\s*\/\*\*[^]*?\*\/\n\s*daemonOptOut\?: boolean,\n\): string/);
    expect(src).toMatch(/const modelArg = model \? ` -m \$\{shellQuote\(model\)\}`/);
    expect(src).toContain("`codex${daemonArg}${profileOrPosture}${modelArg} resume ");
  });

  it("buildNativeResumeCommand 被分类为 NOT-A-SEAT-LAUNCH：每个 caller 都是 metadata/inventory，无一是 launch module", () => {
    const LAUNCH_MODULES = new Set([
      "codex-runtime-adapter.ts",
      "claude-code-adapter.ts",
      "pi-runner-protocol.ts",
      "successor-session-launcher.ts",
      "restore-orchestrator.ts",
      "startup-orchestrator.ts",
      "claude-resume.ts",
      "codex-resume.ts",
    ]);
    // 枚举每个引用 buildNativeResumeCommand 的文件，排除其自身定义文件。
    const callers = allSrcFiles(SRC)
      .filter((f) => nodePath.basename(f) !== "native-resume-probe.ts")
      .filter((f) => readFileSync(f, "utf-8").includes("buildNativeResumeCommand"))
      .map((f) => nodePath.basename(f));
    // 它是 display/metadata 构造器——无 live-pane launch module 可调用它。若某 launch module
    // 开始调用它，本围栏失败，buildNativeResumeCommand 届时必须穿 model。
    const launchCallers = callers.filter((c) => LAUNCH_MODULES.has(c));
    expect(launchCallers, `buildNativeResumeCommand 不得被 seat-launch 模块调用: ${launchCallers}`).toEqual([]);
    // 且它仍被 metadata/inventory 表面使用（分类是活的，不是死的）。
    expect(callers.sort()).toEqual(["node-inventory.ts", "resume-metadata-refresher.ts"]);
  });

  // 0.5.2-07 A4-profile——把围栏扩到 codex_config_profile 字段。codex adapter 已从
  // binding.codexConfigProfile 发 `-p`；HANDOVER 路径（A2-1 修复的兄弟）必须在 lookupNode
  // SELECT 该列并把它带到 successor binding 上，完全像现在对 model 做的那样。未来编辑若把
  // profile 穿进 binding 却忘了 SELECT（或反之），在此失败。
  it("handover 穿 codex_config_profile：lookupNode SELECT 它 且 successor binding 携带它", () => {
    const handover = read("domain/seat-handover-service.ts");
    // lookupNode 查询必须 SELECT 该列（镜像 A2-1 model SELECT，多一个字段）。
    expect(handover, "seat-handover-service 的 lookupNode 必须 SELECT codex_config_profile").toMatch(
      /SELECT id, runtime, cwd, model, codex_config_profile FROM nodes/,
    );
    // NodeRow 形状必须带它，createSuccessor 必须把它转发到 successor node。
    expect(handover, "NodeRow 必须携带 codex_config_profile").toMatch(/codex_config_profile: string \| null/);
    expect(handover, "createSuccessor 必须把 profile 转发到 successor node").toMatch(
      /codexConfigProfile: node\.codex_config_profile/,
    );
    // launcher 必须从 successor node 把它穿到 adapter 读取的 transient binding 上。
    const launcher = read("domain/successor-session-launcher.ts");
    expect(launcher, "SuccessorNode 必须声明 codexConfigProfile").toMatch(/codexConfigProfile\?: string \| null/);
    expect(launcher, "transient binding 必须贯穿 codexConfigProfile").toMatch(
      /codexConfigProfile: node\.codexConfigProfile/,
    );
  });
});
