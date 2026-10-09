import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface RigDeps extends StatusDeps {
  readFile: (path: string) => string;
}

export function rigCommand(depsOverride?: RigDeps): Command {
  const cmd = new Command("spec").description("管理工作组规范");
  const getDeps = (): RigDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .command("show <rig-id>")
    .description("打印可重建一个运行中工作组的规范")
    .option("--json", "JSON 输出")
    .option("--as-template", "剥离实例相关的来源状态，并用占位名替换")
    .action(async (rigId: string, opts: { json?: boolean; asTemplate?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.json && !opts.asTemplate) {
        const res = await client.get<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/spec.json`);
        if (res.status >= 400) {
          console.error(`未找到工作组 ${rigId}。`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const res = await client.getText(`/api/rigs/${encodeURIComponent(rigId)}/spec`);
      if (res.status >= 400) {
        console.error(`未找到工作组 ${rigId}。`);
        process.exitCode = 1;
        return;
      }
      if (!opts.asTemplate) {
        console.log(res.data.trimEnd());
        return;
      }

      const template = parseYaml(res.data) as Record<string, unknown>;
      template["name"] = "REPLACE-ME";
      const pods = Array.isArray(template["pods"])
        ? template["pods"] as Array<Record<string, unknown>>
        : [];
      for (const pod of pods) {
        const members = Array.isArray(pod["members"])
          ? pod["members"] as Array<Record<string, unknown>>
          : [];
        for (const member of members) {
          delete member["session_source"];
          delete member["starter_ref"];
        }
      }
      console.log(opts.json ? JSON.stringify(template, null, 2) : stringifyYaml(template).trimEnd());
    });

  cmd
    .command("audit <path>")
    .description("对工作组规范的文化约定与启动上下文做建议性审计")
    .option("--json", "JSON 输出")
    .action((filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      let source: string;
      try {
        source = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(source);
      } catch (error) {
        console.error(`无法审计 ${filePath}：YAML 无效（${(error as Error).message}）`);
        process.exitCode = 1;
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`无法审计 ${filePath}：工作组规范必须是一个 YAML 对象`);
        process.exitCode = 1;
        return;
      }

      const spec = parsed as Record<string, unknown>;
      const findings: Array<{ kind: string; message: string; typicalFix: string }> = [];
      const cultureFile = typeof spec["culture_file"] === "string" ? spec["culture_file"].trim() : "";
      if (cultureFile === "") {
        findings.push({
          kind: "missing_culture",
          message: "未声明 culture_file。",
          typicalFix: "编写 CULTURE.md 并添加 culture_file: CULTURE.md。参见 openrig-architect 技能的编写流程。",
        });
      } else {
        // Slice 16（第 2 项）：rig.yaml 中席位改名后，不得在文化约定里留下过时的席位 id，
        // 该 id 会物化到每个席位的 AGENTS.md/CLAUDE.md（误导席位间寻址）。
        // 标记文化中任何 `pod.member` 引用：其 pod 存在，但完整席位 id 不是当前席位。
        const knownPods = new Set<string>();
        const knownSeats = new Set<string>();
        const pods = Array.isArray(spec["pods"]) ? (spec["pods"] as Array<Record<string, unknown>>) : [];
        for (const pod of pods) {
          const podId = typeof pod?.["id"] === "string" ? (pod["id"] as string) : null;
          if (!podId) continue;
          knownPods.add(podId);
          const members = Array.isArray(pod["members"]) ? (pod["members"] as Array<Record<string, unknown>>) : [];
          for (const m of members) {
            const mid = typeof m?.["id"] === "string" ? (m["id"] as string) : null;
            if (mid) knownSeats.add(`${podId}.${mid}`);
          }
        }
        const culturePath = nodePath.isAbsolute(cultureFile) ? cultureFile : nodePath.join(nodePath.dirname(filePath), cultureFile);
        let cultureText: string | null = null;
        try { cultureText = deps.readFile(culturePath); } catch { cultureText = null; }
        if (cultureText === null) {
          findings.push({
            kind: "culture_unreadable",
            message: `已声明 culture_file '${cultureFile}'，但在 ${culturePath} 无法读取。`,
            typicalFix: "确保文化文件与工作组规范放在一起。",
          });
        } else if (knownPods.size > 0) {
          // 只匹配反引号包裹、且 pod 为已知 pod 的 `pod.member` 记号——
          // 避免在文件路径（docs/x.md）、版本号等上面误报。
          const stale = new Set<string>();
          const re = /`([a-z0-9_-]+)\.([a-z0-9_-]+)`/gi;
          let match: RegExpExecArray | null;
          while ((match = re.exec(cultureText)) !== null) {
            const pod = match[1]!.toLowerCase();
            const seat = `${pod}.${match[2]!.toLowerCase()}`;
            if (knownPods.has(pod) && !knownSeats.has(seat)) stale.add(seat);
          }
          for (const seat of [...stale].sort()) {
            findings.push({
              kind: "stale_culture_seat_id",
              message: `文化约定引用了席位 id '${seat}'，但它不是 rig.yaml 中的当前席位（已改名或移除）。`,
              typicalFix: "把文化块更新为当前席位 id（rig.yaml 中的改名必须同步到 CULTURE.md）。",
            });
          }
        }
      }

      const startup = spec["startup"];
      const startupFiles = startup && typeof startup === "object" && !Array.isArray(startup)
        ? (startup as Record<string, unknown>)["files"]
        : undefined;
      if (!Array.isArray(startupFiles) || startupFiles.length === 0) {
        findings.push({
          kind: "missing_startup_context",
          message: "未声明 startup.files 上下文。",
          typicalFix: "为智能体在启动时所需的环境上下文添加 startup.files。参见 openrig-architect 技能的编写流程。",
        });
      }

      const result = { clean: findings.length === 0, findingCount: findings.length, findings };
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (result.clean) {
        console.log(`规范审计通过：${filePath}`);
        return;
      }
      console.log(`规范审计：${filePath} 有 ${findings.length} 条建议性发现`);
      for (const finding of findings) {
        console.log(`  - ${finding.message}\n    典型修复：${finding.typicalFix}`);
      }
      console.log("仅为建议：这些发现不会阻塞校验或启动。");
    });

  // zrig spec validate <path>
  cmd
    .command("validate <path>")
    .description("校验一个工作组规范（纯 schema 校验）")
    .option("--json", "JSON 输出")
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.postText<{ valid?: boolean; errors?: string[]; name?: string; advisories?: string[] }>("/api/rigs/import/validate", yaml);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.valid) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`工作组规范无效：\n${data.errors.map((e) => `  ${e}`).join("\n")}\n修复：更新 ${filePath} 后重新校验。`);
        } else {
          console.error(`校验失败（HTTP ${res.status}）。请检查工作组规范的 YAML 语法。`);
        }
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      // OPR.0.5.3.3 —— 无论是否有效都打印建议（fail-open；绝不当作错误）。
      if (data.advisories && data.advisories.length > 0) {
        for (const a of data.advisories) console.error(`⚠ 规范建议：${a}`);
      }
      if (data.valid) {
        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        const name = nameMatch?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "未知";
        console.log(`工作组规范有效：${name}`);
      } else {
        if (data.errors && data.errors.length > 0) {
          console.error(`工作组规范无效：\n${data.errors.map((e) => `  ${e}`).join("\n")}\n修复：更新 ${filePath} 后重新校验。`);
        }
        process.exitCode = 1;
      }
    });

  // zrig spec preflight <path>
  cmd
    .command("preflight <path>")
    .description("对一个工作组规范运行预检诊断")
    .option("--rig-root <root>", "供 Pod 感知解析的根目录")
    .option("--json", "JSON 输出")
    .action(async (filePath: string, opts: { rigRoot?: string; json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRoot = opts.rigRoot
        ? nodePath.resolve(opts.rigRoot)
        : nodePath.dirname(nodePath.resolve(filePath));

      const extraHeaders: Record<string, string> = { "X-Rig-Root": rigRoot };

      const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml, "text/yaml", extraHeaders);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.ready) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(`预检失败（HTTP ${res.status}）。请检查你的规范与 rig-root 路径。`);
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.errors && data.errors.length > 0) {
        console.log("预检错误：");
        for (const e of data.errors) console.log(`  - ${e}`);
      }
      if (data.warnings && data.warnings.length > 0) {
        console.log("预检警告：");
        for (const w of data.warnings) console.log(`  - ${w}`);
      }
      if (data.ready) {
        console.log("预检就绪");
      } else {
        console.log("预检未就绪");
        process.exitCode = 1;
      }
    });

  return cmd;
}
