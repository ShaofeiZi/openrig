import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * 在调用时读取 CLI 自身 package.json 的版本（Item 1 / slice-05）。
 * 有意在函数级读取：按"逐层审计"原则，模块级常量会掩盖测试隔离。
 */
function getCliVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = nodePath.join(nodePath.dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 构造 CLI 发送给 /api/bundles/create 的出处块。在调用时读取主机名、
 * 会话名（取自规范的 OPENRIG_SESSION_NAME 环境变量）与 CLI 版本。
 * 操作人员备注来自 --notes 标志。daemonVersion 由后台服务在服务端追加。
 */
function buildClientProvenance(notes: string | undefined): Record<string, string> {
  const out: Record<string, string> = {
    sourceHost: os.hostname(),
    cliVersion: getCliVersion(),
  };
  const session = process.env.OPENRIG_SESSION_NAME;
  if (typeof session === "string" && session.length > 0) out.authorSession = session;
  if (typeof notes === "string" && notes.length > 0) out.notes = notes;
  return out;
}

export function bundleCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bundle").description("管理工作组 bundle");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // zrig bundle create <spec> -o <path>
  cmd.command("create <spec>")
    .description("从工作组规格创建 .rigbundle")
    .requiredOption("-o, --output <path>", ".rigbundle 输出路径")
    .option("--name <name>", "bundle 名称", "my-bundle")
    .option("--bundle-version <ver>", "bundle 版本", "0.1.0")
    .option("--include-packages <refs...>", "要包含的包引用（默认：规格中的全部）")
    .option("--rig-root <root>", "pod 感知解析的根目录")
    .option("--notes <text>", "记入 bundle 出处元数据的操作人员备注")
    .option("--min-daemon-version <ver>", "安装此 bundle 所需的最低后台服务版本（Item 2 兼容性）")
    .option("--min-cli-version <ver>", "安装此 bundle 所需的最低 CLI 版本（Item 2 兼容性）")
    .option("--allow-drift", "打包与同名运行中工作组不一致的规格；差异会盖入 bundle 出处")
    .option("--json", "以 JSON 输出")
    .action(async (spec: string, opts: { output: string; name: string; bundleVersion: string; includePackages?: string[]; rigRoot?: string; notes?: string; minDaemonVersion?: string; minCliVersion?: string; allowDrift?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      // Item 2 / slice-05：由操作人员标志构造兼容性。
      // 仅当两个标志中至少一个设置时才放进请求体。
      const compatibility: Record<string, string> = {};
      if (opts.minDaemonVersion) compatibility.minDaemonVersion = opts.minDaemonVersion;
      if (opts.minCliVersion) compatibility.minCliVersion = opts.minCliVersion;
      const hasCompatibility = Object.keys(compatibility).length > 0;

      // QA-20260601 A1 修复（banked banked-create-install-long-running）：
      // /create 可能耗时数秒到数分钟（pod 感知组装遍历 + Item-6 跨原语
      // vendoring + 全内容完整性校验 + tar 打包）。默认 5000ms 的 CLI 超时
      //（client.ts:31）对真实 bundle 太短；后台服务完成了工作，CLI 却报失败。
      // 按调用 120s 上限覆盖合理的真实 bundle 体积；若作者遇到上限，后台服务侧
      // 操作可在未来的 /bundles/jobs/<id> 接口异步完成（不在 slice-05 范围）。
      const res = await client.post<Record<string, unknown>>("/api/bundles/create", {
        specPath: spec, bundleName: opts.name, bundleVersion: opts.bundleVersion, outputPath: opts.output,
        includePackages: opts.includePackages,
        rigRoot: opts.rigRoot ? nodePath.resolve(opts.rigRoot) : undefined,
        provenance: buildClientProvenance(opts.notes),
        ...(hasCompatibility ? { compatibility } : {}),
        ...(opts.allowDrift ? { allowDrift: true } : {}),
      }, { timeoutMs: 120_000 });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 2;
        return;
      }
      if (res.status >= 400) { console.error(res.data["error"] ?? "创建失败"); process.exitCode = 2; return; }
      console.log(`bundle 已创建：${opts.output}`);
      console.log(`  名称：${res.data["bundleName"]} v${res.data["bundleVersion"]}`);
      console.log(`  哈希：${res.data["archiveHash"]}`);
      // 自 Build B 起后台服务在每次漂移导出都会返回此字段，而人类路径把它丢了——
      // 操作人员看到干净的成功，发出的却是一个不存在的工作组。
      if (typeof res.data["warning"] === "string") console.warn(`\n${res.data["warning"]}`);
    });

  // zrig bundle inspect <path>
  cmd.command("inspect <path>")
    .description("查看 .rigbundle")
    .option("--json", "以 JSON 输出")
    .action(async (bundlePath: string, opts: { json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bundles/inspect", { bundlePath });

      // 检查结构化失败（200 但带 error 或完整性校验未过）
      const hasError = typeof res.data["error"] === "string";
      const digestValid = res.data["digestValid"] === true;
      const integrityPassed = (res.data["integrityResult"] as Record<string, unknown> | undefined)?.["passed"] === true;
      const isFailed = hasError || !digestValid || !integrityPassed;

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || isFailed) process.exitCode = 2;
        return;
      }
      if (res.status >= 400 || hasError) {
        console.error(res.data["error"] ?? "查看失败");
        process.exitCode = 2;
        return;
      }

      const m = res.data["manifest"] as Record<string, unknown>;
      if (!m) { console.error("响应中无清单"); process.exitCode = 2; return; }
      console.log(`包：${m["name"]} v${m["version"]}`);
      console.log(`摘要校验：${res.data["digestValid"]}`);
      const ir = res.data["integrityResult"] as Record<string, unknown>;
      console.log(`完整性：${ir["passed"] ? "通过" : "失败"}`);
      if (!digestValid || !integrityPassed) process.exitCode = 2;
    });

  // zrig bundle install <path>
  cmd.command("install <path>")
    .description("安装 .rigbundle（从 bundle 引导）")
    .option("--plan", "计划模式")
    .option("--yes", "自动批准")
    .option("--target <root>", "目标根目录")
    .option("--skip-version-check", "操作人员显式覆盖 Item-2 安装时兼容性检查（不建议常规使用）")
    .option("--force", "操作人员显式覆盖 Item-3 安装时冲突检查（不建议；冲突可能导致部分安装状态）")
    .option("--json", "以 JSON 输出")
    .action(async (bundlePath: string, opts: { plan?: boolean; yes?: boolean; target?: string; skipVersionCheck?: boolean; force?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      // QA-20260601 A1 修复：/install 会完成一次完整引导运行
      //（解析 → vendoring 同级原语 → 启动工作组会话），真实 bundle 可能耗时
      // 数秒。默认 5000ms 的 CLI 超时（client.ts:31）会在后台服务完成
      // 变更性安装时让 CLI 报失败——对操作人员不安全的重试路径（第二次尝试
      // 出现 rig_name_collision）。已提高到 120s。
      const res = await client.post<Record<string, unknown>>("/api/bundles/install", {
        bundlePath, plan: opts.plan ?? false, autoApprove: opts.yes ?? false, targetRoot: opts.target,
        // Item 2 / slice-05 Checkpoint 3.3：发送 CLI 版本与跳过标志，
        // 供后台服务侧安装时兼容性检查。CLI 版本在调用时读取（不用模块级
        // 常量），走既有的 getCliVersion 辅助函数。
        cliVersion: getCliVersion(),
        skipVersionCheck: opts.skipVersionCheck ?? false,
        // Item 3 / slice-05 Checkpoint 4.2：发送 force 标志，
        // 供后台服务侧安装时冲突检查。仅操作人员显式覆盖。
        force: opts.force ?? false,
      }, { timeoutMs: 120_000 });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }
      if (res.status >= 400) {
        console.error(res.data["error"] ?? res.data["errors"] ?? "安装失败");
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      const status = res.data["status"] as string;
      console.log(`状态：${status}`);
      if (res.data["rigId"]) console.log(`工作组：${res.data["rigId"]}`);
    });

  // zrig bundle history——第 4 项 / slice-05 检查点 5.2
  cmd.command("history")
    .description("列出 ~/.openrig/bundle-audit.jsonl 中的 bundle 安装审计记录")
    .option("--rig <name>", "只看 targetRigName 匹配的记录")
    .option("--since <iso>", "只看 installedAt >= 该 ISO 时间戳的记录")
    .option("--json", "以 JSON 输出")
    .action(async (opts: { rig?: string; since?: string; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const qs = new URLSearchParams();
      if (opts.rig) qs.set("rig", opts.rig);
      if (opts.since) qs.set("since", opts.since);
      const query = qs.toString();
      const path = query.length > 0 ? `/api/bundles/history?${query}` : "/api/bundles/history";

      const res = await client.get<Record<string, unknown>>(path);
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 2;
        return;
      }
      if (res.status >= 400) {
        console.error(res.data["error"] ?? "历史记录获取失败");
        process.exitCode = 2;
        return;
      }
      const records = Array.isArray(res.data["records"]) ? res.data["records"] as Array<Record<string, unknown>> : [];
      if (records.length === 0) {
        console.log("未找到 bundle 安装审计记录。");
        return;
      }
      console.log(`bundle 安装历史（${records.length} 条记录）：`);
      for (const r of records) {
        const at = r["installedAt"] ?? "?";
        const rig = r["targetRigName"] ?? "?";
        const outcome = r["outcome"] ?? "?";
        const bundle = r["bundlePath"] ?? "?";
        console.log(`  ${at}  ${outcome.toString().padEnd(8)}  rig=${rig}  ${bundle}`);
      }
    });

  return cmd;
}
