import nodePath from "node:path";
import { resolveEffectiveHost } from "../host-selection.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYamlDoc } from "yaml";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import { getDaemonStatus, getDaemonUrl, startDaemon, type LifecycleDeps, daemonStatusGuard } from "../daemon-lifecycle.js";
import type { RiggedConfig } from "../config-store.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { formatThreePart, type ThreePartRejection } from "./workflow-errors.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;

/** OPR.0.3.4.2——awaiting-decision ASK 的默认交互式 [y/N] 提示（仅 TTY；
 *  测试注入 promptYesNo）。默认回答：No。 */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// OPR.0.3.2.22 Bug 3 helper——镜像后台服务里的 cwd-resolution.isPathInsideRoot，
// 让 CLI 不用导入 daemon 包就能判断 path 形式的 sourceRef 是否位于
// 后台服务安装根目录内。
function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

// OPR.0.4.4.11（arch return R11-2）——对 topology source 做 --host 拒绝的
// 预分发检测。镜像后台服务的 FR-1 检测契约，但不导入 daemon 包：
// `.rigtopology` 扩展名，或顶层 `rigs:` 为 LIST 的可读 path 形式 YAML 文档。
export function sourceLooksLikeTopology(source: string): boolean {
  if (/\.rigtopology$/i.test(source)) return true;
  // 名称形式 source（无斜杠、无已知扩展名）保持 rig-name 语义——不嗅探
  //（与后台服务路由同优先级）。
  if (!source.includes("/") && !source.match(/\.(ya?ml)$/i)) return false;
  try {
    const p = nodePath.resolve(source);
    if (!existsSync(p)) return false;
    const parsed: unknown = parseYamlDoc(readFileSync(p, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Array.isArray((parsed as Record<string, unknown>)["rigs"]);
  } catch {
    return false; // 不可读/不可解析——已有流程负责报错
  }
}

export const HOST_TOPOLOGY_REJECTION =
  "zrig up --host 不能接受 topology source：manifest 中按条目写 'host:' 是 topology 唯一的放置机制（两种放置机制不能共存）。把 'host: <id>' 写到你想远程放置的条目上，然后不带 --host 跑 'zrig up <topology>'。";

export function upCommand(
  depsOverride?: StatusDeps & {
    lifecycleDeps?: LifecycleDeps;
    preflightExec?: (cmd: string) => Promise<string>;
    /** OPR.0.3.4.2——awaiting-decision ASK 的可注入 [y/N] 提示
     * （测试驱动；默认 = stdin 上的 readline，仅 TTY 时提供）。 */
    promptYesNo?: (question: string) => Promise<boolean>;
  },
): Command {
  const cmd = new Command("up")
    .description("从 spec、库条目或 bundle 启动一个工作组或受管 app")
    .addHelpText("after", `
示例：
  zrig up secrets-manager
  zrig up ./rig.yaml
  zrig up ./demo.rigbundle --target ~/work
`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<source>", "指向 .yaml rig spec 或 .rigbundle 的路径，或库名（如 secrets-manager）")
    .option("--plan", "计划模式——预览但不执行")
    .option("--yes", "自动批准受信任动作")
    .option("--cwd <path>", "本次运行为所有成员覆盖启动工作目录")
    .option("--target <root>", "包安装的目标根目录（仅 .rigbundle；不改变 agent cwd）")
    .option("--existing", "把 <source> 当作已有工作组名；绕过库 spec 名称解析")
    .option("--fresh <seats...>", "刻意重新 priming 指定席位（逻辑 id），而不是恢复它们原来的会话（操作 B；报告为 fresh-primed）")
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上运行")
    .action(async (source: string, opts: { plan?: boolean; yes?: boolean; cwd?: string; target?: string; existing?: boolean; fresh?: string[]; json?: boolean; host?: string }) => {
      // OPR.0.4.6.MH1 FR-2：选定主机路由——显式 --host 优先；
      // 否则把已保存的选择喂给已交付的 --host 路径；没有选择则与今日一致。
      // topology source 豁免：按条目 host: 是 topology 唯一放置方式
      //（已交付 R11-2）；隐式选择不能把无标志的 topology up 变成被拒绝的
      // --host 形式。
      if (!sourceLooksLikeTopology(source)) opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();

      if (opts.host) {
        // OPR.0.4.4.11 R11-2：--host + topology source 在任何分发之前被拒绝——
        // 按条目 'host:' 是 topology 唯一放置机制。后台服务路由在其公开写路径
        // 上带同样的拒绝（双侧强制，arch 裁定 4）。
        if (sourceLooksLikeTopology(source)) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: HOST_TOPOLOGY_REJECTION, code: "host_flag_topology" }));
          } else {
            console.error(HOST_TOPOLOGY_REJECTION);
          }
          process.exitCode = 1;
          return;
        }
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const body = {
          sourceRef: source,
          plan: opts.plan,
          autoApprove: opts.yes,
          cwdOverride: opts.cwd,
          targetRoot: opts.target,
          existing: opts.existing,
          freshLogicalIds: opts.fresh,
        };
        const result = await runRemoteHttpOp(opts.host, "POST", "/api/up", body, deps, { ...opts, timeoutMs: opts.plan ? undefined : LONG_RUNNING_UP_TIMEOUT_MS });
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`主机 ${opts.host} 上出错：${result.error}`);
          process.exitCode = 1;
        }
        return;
      }

      // 自动启动前跑 preflight
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        let resolvedConfig: RiggedConfig | null = null;
        // bug-fix slice auth-bearer-tailscale-trust：追踪 daemon.host 是
        // 操作人员显式给的（env 或配置文件）还是默认兜底。后台服务的多绑定
        // 路径（loopback + tailscale 自动检测）只在 OPENRIG_HOST 未 export 给
        // 子进程时才跑，所以默认路径上我们省略它。
        // 提升到函数作用域，让下面的 startDaemon 块在 preflight try-catch
        // 之后能读到它。
        let hostForDaemon: string | undefined;
        try {
          const { ConfigStore } = await import("../config-store.js");
          const { SystemPreflight } = await import("../system-preflight.js");
          const { execSync } = await import("node:child_process");
          const { OPENRIG_DIR, resolveBindIntent } = await import("../daemon-lifecycle.js");
          const configStore = new ConfigStore();
          resolvedConfig = configStore.resolve();
          const hostResolution = configStore.resolveWithSource("daemon.host");
          // S20（r2 修复）：共用的专用 intent 接缝——env 来源的
          // daemon.host（ENV_MAP ← OPENRIG_HOST，注入路由通道）绝不通过
          // 自动启动创建绑定 intent；无标志自动启动只认文件来源的
          // daemon.host 或 OPENRIG_BIND_HOST。
          hostForDaemon = resolveBindIntent({
            flagHost: undefined,
            envBindHost: process.env["OPENRIG_BIND_HOST"],
            configSource: hostResolution.source,
            configHost: resolvedConfig.daemon.host,
          }).host;
          const preflightExec = depsOverride?.preflightExec ?? (async (cmd: string) =>
            execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }));
          const preflight = new SystemPreflight({
            exec: preflightExec,
            configStore,
            getDaemonStatus: () => getDaemonStatus(deps.lifecycleDeps),
            openrigHome: OPENRIG_DIR,
          });
          const preflightResult = await preflight.run();
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`✗ ${check.name}：${check.error}`);
              if (check.reason) console.error(`  原因：${check.reason}`);
              if (check.fix) console.error(`  修复：${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
        } catch (preErr) {
          console.error(`Preflight 错误：${preErr instanceof Error ? preErr.message : String(preErr)}`);
          process.exitCode = 1;
          return;
        }

        try {
          await startDaemon({
            port: resolvedConfig?.daemon.port,
            host: hostForDaemon,
            db: resolvedConfig?.db.path,
            transcriptsEnabled: resolvedConfig?.transcripts.enabled,
            transcriptsPath: resolvedConfig?.transcripts.path,
            transcriptsLines: resolvedConfig?.transcripts.lines,
            transcriptsPollIntervalSeconds: resolvedConfig?.transcripts.pollIntervalSeconds,
            workspaceRoot: resolvedConfig?.workspace.root,
            contextRoot: resolvedConfig?.context.root,
            skillsRoot: resolvedConfig?.skills.root,
            topologyRoot: resolvedConfig?.topology.root,
          }, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // 区分工作组名 vs 文件路径：名字不含 / 也不以
      // .yaml/.yml/.rigbundle/.rigtopology 结尾。OPR.0.4.4.11（guard G-1）：
      // topology 扩展名按 PATH 解析（与 yaml/rigbundle 一样），让裸
      // `factory.rigtopology` 到达后台服务的 topology 路由，而不是库/已有
      // 工作组名解析。无扩展名无斜杠 source 保持 rig_name 优先级逐字节一致。
      const isRigName = !source.includes("/") && !source.match(/\.(ya?ml|rigbundle|rigtopology)$/i);
      let sourceRef = isRigName ? source : nodePath.resolve(source);

      // 如果看起来像名字，检查库 spec 匹配
      let defaultLibraryCwdOverride: string | undefined;
      // 缓存 rig 摘要，这样我们既能检测歧义，又能为
      // "Recovering ..." vs "Turning on ..." 措辞推导 lifecycleState（post-L2）。
      let rigSummariesCache: Array<{ id: string; name: string; lifecycleState?: string }> | null = null;
      const fetchRigSummaries = async () => {
        if (rigSummariesCache !== null) return rigSummariesCache;
        try {
          const res = await client.get<Array<{ id: string; name: string; lifecycleState?: string }>>("/api/rigs/summary");
          rigSummariesCache = res.data ?? [];
        } catch {
          rigSummariesCache = [];
        }
        return rigSummariesCache;
      };
      // OPR.0.3.3.19（AC-7）：已归档工作组从默认 `rig up` 名称解析中排除。
      // 如果 <source> 只匹配一个已归档工作组（没有同名的活动工作组），
      // 用指向 `rig unarchive` 的诚实错误拒绝——绝不静默恢复已归档工作组，
      // 绝不静默落空。同时适用于默认路径和 --existing 路径。
      if (isRigName) {
        const activeSummaries = await fetchRigSummaries();
        const activeMatch = activeSummaries.some((r) => r.name === source);
        if (!activeMatch) {
          try {
            const archRes = await client.get<Array<{ id: string; name: string }>>(
              "/api/rigs/summary?archived=only",
            );
            const archivedMatches = (archRes.data ?? []).filter((r) => r.name === source);
            if (archivedMatches.length > 0) {
              // `rig unarchive` 按 rig ID 解析，不按名字（它 POST 到
              // /api/rigs/<rigId>/unarchive），所以修复必须点名 id——告诉操作人员
              // `rig unarchive <name>` 会 404。如果该名在多个已归档工作组间有歧义，
              // 列出 id 而不是猜单个目标。
              const ids = archivedMatches.map((r) => r.id);
              if (opts.json) {
                console.log(JSON.stringify({
                  error: "rig_archived",
                  rig: source,
                  archivedRigIds: ids,
                  action: ids.length === 1
                    ? `zrig unarchive ${ids[0]}`
                    : `zrig unarchive <rigId> (archived rigs named '${source}': ${ids.join(", ")})`,
                }));
              } else if (ids.length === 1) {
                console.error(`工作组 "${source}" 已归档，因此从 'zrig up' 名称解析中隐藏。`);
                console.error(`  先恢复它：zrig unarchive ${ids[0]}`);
                console.error(`  然后启动：zrig up ${source}`);
              } else {
                console.error(`有 ${ids.length} 个已归档工作组叫 "${source}"；它们从 'zrig up' 名称解析中隐藏。`);
                console.error(`  按 id 取消归档你想要的那个（然后 'zrig up'）：`);
                for (const id of ids) console.error(`    zrig unarchive ${id}`);
              }
              process.exitCode = 1;
              return;
            }
          } catch {
            // 已归档摘要探测失败（例如更老的后台服务）——落到正常解析；
            // 没有归档语义要强制。
          }
        }
      }
      if (isRigName && !opts.existing) {
        try {
          const { resolveLibrarySpec } = await import("./specs.js");
          const entry = await resolveLibrarySpec(client, source, { kind: "rig" });
          // 找到库匹配——检查已有工作组冲突
          // 用 /api/rigs/summary，它镜像 findRigsByName（含已停止工作组）
          const rigSummaries = await fetchRigSummaries();
          const rigMatches = rigSummaries.filter((r) => r.name === source);
          if (rigMatches.length > 0) {
            console.error(`'${source}' 有歧义——它同时匹配一个已有工作组恢复目标和一个库 spec。`);
            console.error(`  要启动库 spec：zrig up ${entry.sourcePath}`);
            console.error(`  工作组名匹配指向一个已停止工作组 / 快照支持的恢复路径。`);
            console.error(`  要恢复已有工作组而不是导入 starter：zrig up ${source} --existing`);
            process.exitCode = 1;
            return;
          }
          sourceRef = entry.sourcePath;
          if (!opts.cwd && entry.kind === "rig" && entry.sourceType === "builtin") {
            defaultLibraryCwdOverride = process.cwd();
          }
        } catch (resolveErr) {
          // 库内歧义——暴露它
          if ((resolveErr as Error).message?.includes("ambiguous")) {
            console.error((resolveErr as Error).message);
            process.exitCode = 1;
            return;
          }
          // 未找到或其他错误——按已有工作组名行为继续
        }

        // 措辞分叉（post-L2）：如果 sourceRef 仍是工作组名，我们走已有工作组
        // 恢复路径。按工作组推导出的 lifecycleState 打印 "正在恢复 ..." 或
        // "正在启动 ..."。Help 文本诚实："Recover" 描述 `rig up` 做什么；
        // 不承诺在 tester L4 VM 证明完成之前成功。
        if (sourceRef === source && !opts.json) {
          const summaries = await fetchRigSummaries();
          const match = summaries.find((r) => r.name === source);
          if (match?.lifecycleState === "recoverable") {
            console.log(`正在从最新快照或当前 DB 状态恢复工作组 "${source}"...`);
          } else if (match?.lifecycleState === "stopped") {
            console.log(`正在启动工作组 "${source}"...`);
          }
        }
      } else if (isRigName && opts.existing && !opts.json) {
        const summaries = await fetchRigSummaries();
        const match = summaries.find((r) => r.name === source);
        if (match?.lifecycleState === "recoverable") {
          console.log(`正在从最新快照或当前 DB 状态恢复工作组 "${source}"...`);
        } else {
          console.log(`正在启动已有工作组 "${source}"...`);
        }
      }

      const isRigBundle = !isRigName && /\.rigbundle$/i.test(sourceRef);
      const targetRoot = opts.target ?? (isRigBundle ? process.cwd() : undefined);

      // OPR.0.3.2.22 Bug 3——把裸 `rig up <builtin>` 的默认 cwd 处理
      // 扩展到 path 形式。内置 starter spec 声明成员级 cwd: "."，
      // 解析为 spec 目录（在后台服务安装根目录内）。没有 --cwd 时会在
      // preflight 触发 getOpenRigInstallCwdError。裸名形式已在上面
      // resolveLibrarySpec 分支获救（entry.sourceType === "builtin"）；
      // path 形式 `rig up <install-internal-spec>` 是剩余缺口。
      //
      // 检测：source 是 path 形式（不是 isRigName、不是 isRigBundle），
      // 没给 --cwd，上面裸名分支没设置 defaultLibraryCwdOverride，
      // 且解析出的路径位于后台服务安装根目录内（通过 /api/info 取）。
      // 全部成立时，默认 cwdOverride 为 process.cwd()，让操作人员项目
      // 目录作为启动 cwd，并打印一行提示。如果 /api/info 不可用，静默
      // 落空——后台服务 preflight 仍会暴露 install-cwd 错误。
      //
      // 内置 starter spec 如何声明 cwd 的结构性重设计不在范围内
      //（按 slice triage 推迟到 0.3.3）。
      if (!opts.cwd && !isRigName && !isRigBundle && defaultLibraryCwdOverride === undefined) {
        try {
          // 短超时：健康后台服务 <100ms 应答 /api/info；不应答时落到后台服务
          // 自己的 preflight 错误，而不是给每次 rig up 加几秒停滞。
          const infoRes = await client.get<{ installRoot?: string }>("/api/info", { timeoutMs: 2000 });
          const installRoot = infoRes.data?.installRoot;
          if (installRoot && isPathInsideRoot(sourceRef, installRoot)) {
            defaultLibraryCwdOverride = process.cwd();
            if (!opts.json) {
              console.log("因为 spec 位于 zrig 安装目录内，cwd 默认取当前目录。");
            }
          }
        } catch {
          // /api/info 不可用——落空。如果确实是 install-internal 情况，
          // 后台服务 preflight 返回 getOpenRigInstallCwdError；操作人员拿到
          // 与 Bug-3 之前相同的提示。
        }
      }

      // OPR.0.3.4.4——诚实的异步：APPLY 模式下客户端超时 / 连接丢失
      // 不代表操作失败；后台服务可能仍在处理。用 verify 命令报告
      // in-progress/unknown，绝不报裸连接失败（那是导致事故后错误下一步
      // 的假失败）。今天超时时客户端侧不暴露 operation id，所以诚实消息
      // 是 MVP 底线。
      const printHonestTimeout = (err: DaemonConnectionError): void => {
        console.error(`CLI 等待后台服务超时，但操作可能仍在进行中。`);
        console.error(`这不代表操作失败；后台服务可能仍在处理。`);
        console.error(`用以下命令核验实际状态：zrig ps`);
        console.error(`（底层：${err.message}）`);
        process.exitCode = 1;
      };

      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/up", {
          sourceRef,
          plan: opts.plan ?? false,
          autoApprove: opts.yes ?? false,
          cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
          targetRoot,
          // OPR.0.3.4.2——操作 B opt-in 席位（刻意 fresh-prime）。
          freshLogicalIds: opts.fresh,
        }, opts.plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof DaemonConnectionError && !opts.plan) {
          printHonestTimeout(err);
          return;
        }
        throw err;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        const rigResult = res.data["rigResult"] as string | undefined;
        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted") process.exitCode = 1;
        return;
      }

      // OPR.0.4.4.11——topology 聚合渲染（完全成功或诚实部分；后台服务两种情况
      // 都返回同样的闭合 {rigRef, host, status, error?} 条目，跳过的条目显式在场）。
      const topoEntries = res.data["entries"] as Array<{ rigRef: string; host: string; status: string; error?: string }> | undefined;
      if (typeof res.data["topology"] === "string" && Array.isArray(topoEntries)) {
        const topoOk = res.data["ok"] === true;
        console.log(
          topoOk
            ? `Topology up：全部 ${topoEntries.length} 个工作组已启动。`
            : "Topology up 失败——诚实部分状态（已启动工作组保持运行；不回滚）：",
        );
        for (const e of topoEntries) {
          const tag = e.status === "ok" ? " ok " : e.status === "failed" ? "FAIL" : "skip";
          console.log(`  [${tag}] ${e.rigRef} @ ${e.host}${e.error ? ` — ${e.error}` : ""}`);
        }
        if (!topoOk) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        const error = res.data["error"] as Partial<ThreePartRejection> | null | undefined;
        if (error && typeof error === "object" && typeof error.fact === "string"
          && typeof error.consequence === "string" && typeof error.action === "string") {
          for (const line of formatThreePart(error as ThreePartRejection)) console.error(line);
          const nodes = res.data["attentionNodes"] as Array<{ logicalId: string; sessionName?: string; reason: string }> | undefined;
          for (const node of nodes ?? []) {
            console.error(`  ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}: ${node.reason}`);
          }
        } else if (code === "cycle_error") {
          console.error("工作组拓扑中检测到环。请检查 edge 定义是否有循环依赖。");
        } else if (code === "validation_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`工作组 spec 校验失败：\n${errors.map((e) => `  ${e}`).join("\n")}\n修复：更新你的 rig spec 后重试。`);
        } else if (code === "preflight_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Preflight 检查失败：\n${errors.map((e) => `  ${e}`).join("\n")}\n修复：解决上面的问题后重试。`);
        } else if (code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data as RestoreNotAttemptedData);
        } else if (code === "invalid_topology_manifest") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Topology manifest 非法：\n${errors.map((e) => `  ${e}`).join("\n")}\n修复：manifest 键集是闭合的——rigs[]{source, host?} 加可选 concurrency。`);
        } else if (code === "rig_name_running") {
          // S5b 最终修复 F1（OPR.0.5.4.11）：guard 的教学性拒绝是自描述的
          //（正在运行的工作组身份、检查了什么、未创建任何东西、替代方案）——
          // 原样渲染，绝不走通用的未知错误/validate-your-spec 兜底。
          const teaching = String(res.data["error"] ?? ((res.data["errors"] as string[]) ?? [])[0] ?? "同名工作组已在运行。");
          console.error(teaching);
        } else {
          const errorText = String(res.data["error"] ?? "未知错误");
          console.error(`启动失败：${errorText}（HTTP ${res.status}）。检查后台服务日志，或用以下命令校验 spec：rig spec validate <path>`);
          if (/agent_ref resolution failed|No agent\.yaml found/i.test(errorText)) {
            console.error("提示：local: agent_ref 路径相对于 rig spec 目录解析，不是你的 shell cwd。");
            console.error("      把 agents/ 树放在 rig YAML 旁边，或把这些引用改成 path:/absolute/path。");
          }
        }
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      // 成功输出
      const resStatus = res.data["status"] as string;

      // OPR.0.3.4.4——只读恢复计划预览（--plan 走已有工作组路径）。
      // 渲染每席位预期动作；什么都没跑。
      if (resStatus === "plan" && res.data["mode"] === "restore") {
        const planRigName = res.data["rigName"] as string | undefined;
        const planSnapshot = res.data["snapshot"] as { id: string; kind: string; createdAt: string } | null;
        console.log(`计划：恢复工作组 "${planRigName ?? source}"（只读预览）`);
        if (planSnapshot) {
          console.log(`快照：${planSnapshot.id}（kind=${planSnapshot.kind}，捕获于 ${planSnapshot.createdAt}）`);
        } else if (res.data["wouldCaptureCurrentState"] === true) {
          console.log(`快照：无可使用者——apply 会先把当前 DB 状态捕获为自动重水合快照。`);
        }
        const planNodes = (res.data["nodes"] as Array<{ logicalId: string; intendedAction: string; reason?: string; tokenState?: string; provenance?: string | null; lastVerified?: string | null; freshRequired?: boolean; runtimePrompt?: string }>) ?? [];
        for (const n of planNodes) {
          console.log(`  ${n.logicalId}：${n.intendedAction}${n.reason ? ` — ${n.reason}` : ""}`);
          // OPR.0.4.3.20 FR-6——每席位 token 真相：present/missing/stale/unverified
          // + provenance + freshness + 预期运行时提示 + 显式 --fresh。
          if (n.tokenState) {
            const reverify = (n.tokenState === "stale" || n.tokenState === "unverified") ? " — 重新核验" : "";
            const prov = n.provenance ? `（${n.provenance}）` : "";
            const verified = n.lastVerified ? `，已核验 ${n.lastVerified}` : "";
            const fresh = n.freshRequired ? "；需要 --fresh" : "";
            const prompt = n.runtimePrompt ? `；${n.runtimePrompt}` : "";
            console.log(`      token：${n.tokenState}${reverify}${prov}${verified}${fresh}${prompt}`);
          }
        }
        console.log("未做任何修改。");
        return;
      }

      if (resStatus === "restored") {
        // 已有工作组启动交接
        const rigId = res.data["rigId"] as string;
        const rigName = res.data["rigName"] as string | undefined;
        const rigResult = res.data["rigResult"] as string | undefined;
        const snapshotKind = res.data["snapshotKind"] as string | undefined;
        // L3b：当后台服务回退到非 auto-pre-down 快照时，把 kind 暴露出来，
        // 让操作人员显式看到手动回退。这条注释在 "Rig restored" 行之前打印，
        // 以便在典型的输出顶部扫视中可见。
        if (snapshotKind && snapshotKind !== "auto-pre-down") {
          console.log(`正在从手动快照恢复（kind=${snapshotKind}）；没有可用的 auto-pre-down 快照。`);
        }
        console.log(`工作组 "${rigName ?? rigId}" 已恢复（ID：${rigId}）`);
        if (rigResult) console.log(`结果：${rigResult}`);
        const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
        for (const n of nodes) {
          // OPR.0.3.4.2——五段词汇渲染有别；awaiting-decision 原因是行的一部分
          //（不是死路）。
          if (n.status === "awaiting-decision" && n.error) {
            console.log(`  ${n.logicalId}：awaiting-decision — ${n.error}`);
          } else {
            console.log(`  ${n.logicalId}：${n.status}`);
          }
        }
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  警告：${w}`);
        }
        // 来自服务器响应的 attach 命令（用真实 canonical 会话名）
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach：${attachCommand}`);
        }

        // OPR.0.3.4.2——为 awaiting-decision 席位提供可执行 ASK/offer。
        // TTY：每席位交互式 [y/N]；接受的席位作为刻意 fresh-prime 重跑
        //（操作 B）。Headless：机器状态保持 awaiting-decision，带显式
        // --fresh 提示。绝不自动替换。
        const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
        if (awaiting.length > 0) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(deps.promptYesNo);
          if (interactive) {
            const ask = deps.promptYesNo ?? defaultPromptYesNo;
            const accepted: string[] = [];
            for (const n of awaiting) {
              const reason = n.error ?? "原会话不可恢复";
              const yes = await ask(`无法为 ${n.logicalId} 恢复原会话（原因：${reason}）。改为启动一个 fresh primed 会话？[y/N] `);
              if (yes) accepted.push(n.logicalId);
            }
            if (accepted.length > 0) {
              let freshRes: { status: number; data: Record<string, unknown> };
              try {
                freshRes = await client.post<Record<string, unknown>>("/api/up", {
                  sourceRef,
                  plan: false,
                  autoApprove: opts.yes ?? false,
                  cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
                  targetRoot,
                  freshLogicalIds: accepted,
                }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
              } catch (err) {
                if (err instanceof DaemonConnectionError) {
                  printHonestTimeout(err);
                  return;
                }
                throw err;
              }
              const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
              for (const n of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                console.log(`  ${n.logicalId}：${n.status}`);
              }
            } else {
              console.log(`  未启动任何 fresh 会话。决定后用 --fresh <seat...> 重跑。`);
            }
          } else {
            for (const n of awaiting) {
              console.error(`  ${n.logicalId}：awaiting-decision——未启动会话。要刻意 fresh-prime：zrig up --existing ${source} --fresh ${n.logicalId}`);
            }
          }
        }

        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted" || nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision")) {
          process.exitCode = 1;
        }
      } else {
        // 全新启动交接
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}：${s.status}`);
        }

        const rigId = res.data["rigId"] as string | undefined;
        if (rigId) {
          console.log(`\n工作组：${rigId}`);
          // 看板——用 rig ui open（它知道真实 UI URL）
          console.log(`看板：zrig ui open`);
        }
        console.log(`状态：${resStatus}`);

        // 暴露警告（例如 transcript attach 失败）
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  警告：${w}`);
        }

        // 来自服务器响应的 attach 命令
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach：${attachCommand}`);
        }

        if (resStatus === "partial") process.exitCode = 1;
      }
    });

  return cmd;
}

interface RestoreBlocker {
  code: string;
  severity?: string;
  logicalId?: string;
  nodeId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

interface RestoreNotAttemptedData {
  error?: string;
  rigResult?: string;
  blockers?: RestoreBlocker[];
}

function printRestoreNotAttempted(data: RestoreNotAttemptedData): void {
  console.error(`恢复被阻塞：${data.error ?? "恢复前校验失败"}`);
  if (data.rigResult) {
    console.error(`结果：${data.rigResult}`);
  }
  for (const blocker of data.blockers ?? []) {
    const scope = blocker.logicalId ?? blocker.nodeId ?? blocker.target ?? blocker.code;
    console.error(`  ${scope}：${blocker.message}`);
    if (blocker.path) console.error(`    路径：${blocker.path}`);
    console.error(`    修复：${blocker.remediation}`);
  }
}
