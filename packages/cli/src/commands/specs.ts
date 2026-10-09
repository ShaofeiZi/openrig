import { Command } from "commander";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface LibraryEntry {
  id: string;
  kind: "rig" | "agent" | "workflow";
  name: string;
  version: string;
  sourceType: string;
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
}

interface AddSpecSource {
  inputPath: string;
  yamlPath: string;
  installName: string;
  installKind: "file" | "directory";
  libraryEntrySuffix: string;
}

function normalizePathForMatch(path: string): string {
  return path.replaceAll("\\", "/");
}

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} 不能是符号链接：${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} 必须是普通文件：${path}`);
  }
}

function assertTreeHasNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Spec 目录不能包含符号链接：${absPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(absPath);
      }
    }
  }
}

function resolveAddSpecSource(inputPath: string): AddSpecSource {
  if (!existsSync(inputPath)) {
    throw new Error(`文件未找到：${inputPath}`);
  }

  const stat = lstatSync(inputPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Spec 路径不能是符号链接：${inputPath}`);
  }

  if (stat.isFile()) {
    return {
      inputPath,
      yamlPath: inputPath,
      installName: basename(inputPath),
      installKind: "file",
      libraryEntrySuffix: basename(inputPath),
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Spec 路径必须是 YAML 文件或 spec 目录：${inputPath}`);
  }

  const rootSpec = ["rig.yaml", "rig.yml", "agent.yaml", "agent.yml"]
    .map((candidate) => join(inputPath, candidate))
    .find((candidate) => existsSync(candidate));
  if (!rootSpec) {
    throw new Error(`Spec 目录必须包含 rig.yaml 或 agent.yaml：${inputPath}`);
  }
  requireRegularFile(rootSpec, "根 spec 文件");

  const installName = basename(inputPath);
  return {
    inputPath,
    yamlPath: rootSpec,
    installName,
    installKind: "directory",
    libraryEntrySuffix: normalizePathForMatch(join(installName, basename(rootSpec))),
  };
}

function installSpecSource(source: AddSpecSource, userRoot: string): string {
  mkdirSync(userRoot, { recursive: true });
  const dest = join(userRoot, source.installName);

  if (source.installKind === "file") {
    requireRegularFile(source.inputPath, "Spec file");
    copyFileSync(source.inputPath, dest);
    return dest;
  }

  if (existsSync(dest)) {
    throw new Error(`目标位置已存在 spec 目录：${dest}。添加本 spec 之前请先移除或改名。`);
  }

  assertTreeHasNoSymlinks(source.inputPath);
  const tempParent = mkdtempSync(join(userRoot, ".spec-add-"));
  const tempDest = join(tempParent, source.installName);
  try {
    cpSync(source.inputPath, tempDest, { recursive: true, errorOnExist: true, force: false });
    renameSync(tempDest, dest);
  } catch (err) {
    rmSync(tempParent, { recursive: true, force: true });
    throw err;
  }
  rmSync(tempParent, { recursive: true, force: true });
  return dest;
}

/**
 * 库 spec 的共用名称解析。
 * 返回匹配到的条目，或在歧义/未找到时抛出带指引的错误。
 */
export async function resolveLibrarySpec(
  client: DaemonClient,
  nameOrId: string,
  opts?: { kind?: LibraryEntry["kind"] },
): Promise<LibraryEntry> {
  const res = await client.get<LibraryEntry[]>(opts?.kind ? `/api/specs/library?kind=${opts.kind}` : "/api/specs/library");
  const entries = res.data ?? [];

  // 先尝试精确 ID 匹配
  const byId = entries.find((e) => e.id === nameOrId);
  if (byId) return byId;

  // 再尝试名称匹配
  const byName = entries.filter((e) => e.name === nameOrId);
  if (byName.length === 1) return byName[0]!;

  if (byName.length > 1) {
    const candidates = byName.map((e) => `  ${e.id}（${e.kind}）—— ${e.sourcePath}`).join("\n");
    const scope = opts?.kind ? ` ${opts.kind}` : "";
    throw new Error(
      `Spec 名称 '${nameOrId}' 有歧义——${byName.length} 个${scope}条目匹配。\n请改用 ID：\n${candidates}`
    );
  }

  const scope = opts?.kind ? ` ${opts.kind}` : "";
  throw new Error(
    `在${scope}库中未找到 spec '${nameOrId}'。运行 'rig specs ls' 查看可用的工作组、智能体、工作流与受管 app。`
  );
}

export function specsCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("specs")
    .description("浏览、预览和管理 spec 库，包括受管 app")
    .addHelpText("after", `
示例：
  rig specs ls
  rig specs preview secrets-manager
  rig specs show vault-specialist
`);
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b：通过唯一 helper 做认知匹配语言（宕机 ≠ 忙）。
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // specs ls
  cmd.command("ls")
    .description("列出库中的工作组、智能体与受管 app")
    .option("--kind <kind>", "按类型过滤（rig、agent 或 workflow）")
    .option("--json", "以 JSON 输出")
    .action(async (opts: { kind?: string; json?: boolean }) => {
      try {
        const client = await getClient();
        const url = opts.kind ? `/api/specs/library?kind=${opts.kind}` : "/api/specs/library";
        const res = await client.get<LibraryEntry[]>(url);
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log("库中没有 spec。用 rig specs add <path> 添加 spec。");
          return;
        }

        for (const e of entries) {
          console.log(`${e.name.padEnd(24)} ${e.kind.padEnd(8)} ${e.version.padEnd(8)} ${e.sourceType.padEnd(12)} ${e.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs show 命令
  cmd.command("show")
    .argument("<name-or-id>", "Spec 名称或库 ID")
    .description("展示 spec 元数据与路径")
    .option("--kind <kind>", "按类型消歧（rig、agent 或 workflow）")
    .option("--json", "以 JSON 输出")
    .action(async (nameOrId: string, opts: { kind?: LibraryEntry["kind"]; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId, opts.kind ? { kind: opts.kind } : undefined);

        if (opts.json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }

        console.log(`名称：    ${entry.name}`);
        console.log(`类型：    ${entry.kind}`);
        console.log(`版本：    ${entry.version}`);
        console.log(`来源：    ${entry.sourceType}`);
        console.log(`路径：    ${entry.sourcePath}`);
        console.log(`ID：      ${entry.id}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs preview 命令
  cmd.command("preview")
    .argument("<name-or-id>", "Spec 名称或库 ID")
    .description("展示结构化的 spec 评审，包括受管 app 详情")
    .option("--kind <kind>", "按类型消歧（rig、agent 或 workflow）")
    .option("--json", "以 JSON 输出")
    .action(async (nameOrId: string, opts: { kind?: LibraryEntry["kind"]; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId, opts.kind ? { kind: opts.kind } : undefined);
        const res = await client.get<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}/review`);

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }

        const review = res.data;
        console.log(`${review["name"]}（${review["kind"]}，${review["format"] ?? "agent"}）`);
        if (review["summary"]) console.log(`  ${review["summary"]}`);
        console.log(`  来源：${review["sourcePath"]} [${review["sourceState"]}]`);

        if (review["kind"] === "rig" && review["format"] === "pod_aware") {
          const pods = (review["pods"] as Array<{ id: string; members: Array<{ id: string; runtime: string }> }>) ?? [];
          for (const pod of pods) {
            console.log(`  Pod：${pod.id}（${pod.members.length} 个成员）`);
            for (const m of pod.members) {
              console.log(`    ${m.id} — ${m.runtime}`);
            }
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs add 命令
  cmd.command("add")
    .argument("<path>", "YAML spec 文件或 spec 目录的路径")
    .description("把 spec 文件或完整 spec 目录添加到用户库")
    .option("--json", "以 JSON 输出")
    .action(async (inputPath: string, opts: { json?: boolean }) => {
      try {
        const source = resolveAddSpecSource(inputPath);
        const yaml = readFileSync(source.yamlPath, "utf-8");
        const client = await getClient();

        // 通过后台服务校验
        let kind = "rig";
        let res = await client.post<Record<string, unknown>>("/api/specs/review/rig", { yaml });
        if (res.status >= 400) {
          res = await client.post<Record<string, unknown>>("/api/specs/review/agent", { yaml });
          kind = "agent";
        }
        if (res.status >= 400) {
          throw new Error("文件不是合法的 RigSpec 或 AgentSpec。请先修复校验错误再添加。");
        }

        // 复制到用户库
        const userRoot = getDefaultOpenRigPath("specs");
        const dest = installSpecSource(source, userRoot);

        // 同步并找到新条目
        const syncRes = await client.post<LibraryEntry[]>("/api/specs/library/sync");
        const entries = syncRes.data ?? [];
        const name = (res.data as Record<string, unknown>)["name"] as string ?? source.installName;
        const newEntry = entries.find((e) => (
          e.name === name &&
          normalizePathForMatch(e.sourcePath).endsWith(source.libraryEntrySuffix)
        ));

        if (opts.json) {
          console.log(JSON.stringify({ name, kind, path: dest, id: newEntry?.id ?? null, entry: newEntry ?? null }));
          return;
        }

        console.log(`已将${kind} spec '${name}' 添加到库，位置 ${dest}`);
        if (newEntry) {
          console.log(`  ID：${newEntry.id}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs sync 命令
  cmd.command("sync")
    .description("重新扫描 spec 库根目录")
    .option("--json", "以 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.post<LibraryEntry[]>("/api/specs/library/sync");
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        console.log(`库已同步：已索引 ${entries.length} 个 spec。`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs remove 命令
  cmd.command("remove")
    .argument("<name-or-id>", "Spec 名称或库 ID")
    .description("从库中移除一个用户文件 spec")
    .option("--json", "以 JSON 输出")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);
        const res = await client.delete<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}`);

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }

        if (res.status >= 400) {
          console.error((res.data["error"] as string | undefined) ?? `移除失败（HTTP ${res.status}）`);
          process.exitCode = 1;
          return;
        }

        console.log(`已从库中移除 ${res.data["name"] ?? entry.name}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs rename 命令
  cmd.command("rename")
    .argument("<name-or-id>", "Spec 名称或库 ID")
    .argument("<new-name>", "新 spec 名称")
    .description("在库中重命名一个用户文件 spec")
    .option("--json", "以 JSON 输出")
    .action(async (nameOrId: string, newName: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);
        const res = await client.post<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}/rename`, {
          name: newName,
        });

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }

        if (res.status >= 400) {
          console.error((res.data["error"] as string | undefined) ?? `重命名失败（HTTP ${res.status}）`);
          process.exitCode = 1;
          return;
        }

        const renamed = (res.data["entry"] as Record<string, unknown> | undefined) ?? {};
        console.log(`已将 ${entry.name} 重命名为 ${renamed["name"] ?? newName}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
