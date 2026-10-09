/**
 * Slice 51-02 delta D1——拓扑暂存 + 逐席位 stub script 投递。
 *
 * 锁定规则要求 scenario 解析逐席位 stub script，而已交付 stub 会精确读取
 * `<cwd>/.openrig/stub/script.json`（stub-runner-protocol），因此不同 script 需要不同席位 CWD。
 * `zrig up --cwd` 无法表达这一点：`resolveLaunchCwd(authored, specRoot, override)` 会让 override
 * 对每个席位生效，所以共享一个 cwd 就会共享一个 script。
 *
 * 因此流水线先暂存拓扑，再在暂存副本中写入逐席位 `cwd`，不使用 --cwd flag。若只暂存 YAML，
 * spec 根会重新定基准，并使已提交 fixture 依赖的相对闭包失去来源；`culture_file: culture.md`
 * 与 `agent_ref: "local:agents/worker"` 都相对工作组 spec 目录解析。因此需复制整个来源目录，
 * 并在其中修改暂存 YAML；绝不写入已提交 fixture。
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseStubScript } from "../../src/adapters/stub-script.js";

/** 自包含的暂存拓扑根，其中已就地写入逐席位 CWD。 */
export interface StagedTopology {
  /** 暂存根目录，即来源拓扑目录的副本。 */
  root: string;
  /** 交给 `zrig up` 的暂存工作组 spec 路径。 */
  topologyPath: string;
  /** `<pod>-<member>` → 该席位已存在的绝对暂存 cwd。 */
  seatCwds: Record<string, string>;
}

/** `env.stub_scripts` key 未精确指向一个 stub 席位时抛出。 */
export class StubScriptTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptTargetError";
  }
}

interface MemberIndexEntry {
  qualified: string;
  memberId: string;
  runtime: string | undefined;
}

function indexMembers(doc: unknown): MemberIndexEntry[] {
  const pods = (doc as { pods?: unknown }).pods;
  if (!Array.isArray(pods)) return [];
  const out: MemberIndexEntry[] = [];
  for (const pod of pods) {
    const podId = (pod as { id?: unknown }).id;
    const members = (pod as { members?: unknown }).members;
    if (typeof podId !== "string" || !Array.isArray(members)) continue;
    for (const m of members) {
      const memberId = (m as { id?: unknown }).id;
      if (typeof memberId !== "string") continue;
      out.push({
        qualified: `${podId}-${memberId}`,
        memberId,
        runtime: typeof (m as { runtime?: unknown }).runtime === "string" ? (m as { runtime: string }).runtime : undefined,
      });
    }
  }
  return out;
}

/**
 * 将每个 `env.stub_scripts` key 精确解析到一个 runtime:stub member，否则抛错。在任何文件系统
 * 写入或进程 spawn 前执行；拼错的席位绝不能静默回退默认值，同时把 script 写入未使用目录。
 * Key 可以是 pod 限定形式（`dev-alpha`），也可以在无歧义时使用裸 member id。
 * 返回 key → 限定席位名。
 */
export function resolveStubScriptTargets(
  topologyDoc: unknown,
  stubScripts: Record<string, string>,
): Record<string, string> {
  const index = indexMembers(topologyDoc);
  const stubSeats = index.filter((e) => e.runtime === "stub").map((e) => e.qualified);
  const resolved: Record<string, string> = {};
  const claimedBy: Record<string, string> = {};

  for (const key of Object.keys(stubScripts)) {
    const matches = index.filter((e) => e.qualified === key || e.memberId === key);
    if (matches.length === 0) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}"：拓扑中没有该席位——stub 席位为：${stubSeats.join(", ") || "（无）"}。` +
          `拼错的席位会静默运行内置默认值，而 script 落入未使用目录，因此这里必须明确失败。`,
      );
    }
    if (matches.length > 1) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}"：有歧义——匹配 ${matches.map((m) => m.qualified).join(", ")}。` +
          `请使用 pod 限定形式（<pod>-<member>）。`,
      );
    }
    const hit = matches[0]!;
    if (hit.runtime !== "stub") {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}"：席位 ${hit.qualified} 的 runtime 为 ${hit.runtime ?? "（未设置）"}，不是 stub——` +
          `只有 runtime:stub 席位会读取已投递 script，因此此处 script 永远不会被读取。`,
      );
    }
    const prior = claimedBy[hit.qualified];
    if (prior !== undefined) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}" 与 "${prior}" 解析到同一席位 ${hit.qualified}（重复 alias）——` +
          `一个席位只读取一个 script，因此无法判断预期项。`,
      );
    }
    claimedBy[hit.qualified] = key;
    resolved[key] = hit.qualified;
  }
  return resolved;
}

/**
 * 把拓扑来源目录复制到 `destRoot`；副本自包含，相对 `culture_file` / `local:` 智能体闭包一并复制。
 * 随后在暂存 YAML 中写入逐席位、绝对且已存在的 `cwd`。返回暂存路径与 seat→cwd 映射。
 * 来源目录绝不修改。
 */
export function stageTopologyRoot(sourceTopologyPath: string, destRoot: string): StagedTopology {
  const sourceDir = dirname(resolve(sourceTopologyPath));
  const fileName = resolve(sourceTopologyPath).slice(sourceDir.length + 1);

  mkdirSync(destRoot, { recursive: true });
  cpSync(sourceDir, destRoot, { recursive: true });

  const topologyPath = join(destRoot, fileName);
  const doc = parseYaml(readFileSync(topologyPath, "utf-8")) as Record<string, unknown>;

  const seatCwds: Record<string, string> = {};
  const pods = Array.isArray(doc.pods) ? doc.pods : [];
  for (const pod of pods) {
    const podId = (pod as { id?: unknown }).id;
    const members = (pod as { members?: unknown }).members;
    if (typeof podId !== "string" || !Array.isArray(members)) continue;
    for (const m of members) {
      const memberId = (m as { id?: unknown }).id;
      if (typeof memberId !== "string") continue;
      const qualified = `${podId}-${memberId}`;
      // 每个席位使用独立目录：stub 读取 <cwd>/.openrig/stub/script.json，席位受管写入
      //（AGENTS.md、readiness sidecar）也留在 scratch 中。
      const cwd = join(destRoot, "seat-cwd", qualified);
      mkdirSync(cwd, { recursive: true });
      (m as Record<string, unknown>).cwd = cwd;
      seatCwds[qualified] = cwd;
    }
  }

  writeFileSync(topologyPath, stringifyYaml(doc), "utf-8");
  return { root: destRoot, topologyPath, seatCwds };
}

/**
 * 把每个已映射席位的 script 写入其独立暂存 cwd。未映射席位完全不写文件，从而应用 51-01
 * 内置默认值，绝不会读取相邻席位 script。通过已交付 parser（stub-script.ts）校验，
 * 使格式错误 script 在此失败，而不是到席位启动时才失败。
 */
export function deliverStubScripts(
  staged: StagedTopology,
  stubScripts: Record<string, string>,
  scenarioDir: string,
): void {
  const targets = resolveStubScriptTargets(
    parseYaml(readFileSync(staged.topologyPath, "utf-8")),
    stubScripts,
  );
  for (const [key, seat] of Object.entries(targets)) {
    const rel = stubScripts[key]!;
    const scriptPath = isAbsolute(rel) ? rel : resolve(scenarioDir, rel);
    let raw: string;
    try {
      raw = readFileSync(scriptPath, "utf-8");
    } catch (err) {
      throw new StubScriptTargetError(
        `env.stub_scripts."${key}"：无法读取 script ${scriptPath}——${(err as Error).message}`,
      );
    }
    // 使用已交付 parser 校验：与 stub runner 启动时对原始 JSON 文本执行的契约相同。
    // 在此应用可让作者错误在任何席位启动前暴露，而不是表现为死亡席位。
    parseStubScript(raw);
    const dir = join(staged.seatCwds[seat]!, ".openrig", "stub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "script.json"), raw, "utf-8");
  }
}
