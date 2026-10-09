// `rig slack`——Slack 连接器配置 + 子系统管理。
//
// S10（OPR.0.5.5.10）切换：slice-11 的 relay 运行器（`rig slack outbound` 扫描 +
// `rig slack inbound` Socket Mode 循环）已退役——网关作为后台服务内子系统
//（修订后的 M1 §3）直接拥有 Slack 投递与入站。退役动词会带提示拒绝（绝不静默
// 不做任何事）；配置接口（setup/status/verify）保留，通过窄接口
// @openrig/daemon/gateway-slack 由后台服务主目录模块支持（dep rail：调用时惰性导入）。
// enable/disable 现在是后台服务管理调用——后台服务拥有队列与持久化 seen-state，
// enable 时的 backlog-seeding 规则（slice-11 item 9）在 wire 上线前于后台服务侧执行。
//
// 密钥姿态不变：0600 env 文件 / 调用时的 SLACK_* 环境变量，绝不入配置，绝不入库。
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import type {
  loadConfig as LoadConfigFn,
  saveConfig as SaveConfigFn,
  staticReadiness as StaticReadinessFn,
  resolveSecret as ResolveSecretFn,
  checkEnvFilePermissions as CheckEnvFn,
  verifyScopes as VerifyScopesFn,
  verifyChannelMembership as VerifyMembershipFn,
  buildSlackAppManifest as BuildManifestFn,
  FEATURE_SCOPES as FeatureScopes,
  BASELINE_REQUIRED_SCOPES as BaselineScopes,
  SlackConnectorConfig,
  FetchImpl,
} from "@openrig/daemon/gateway-slack";

  // S10：入站 webhook 密钥随 relay 一起退役——出站由后台服务内子系统经 Web API
  //（bot token）发送。
const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

interface SlackSurface {
  loadConfig: typeof LoadConfigFn;
  saveConfig: typeof SaveConfigFn;
  staticReadiness: typeof StaticReadinessFn;
  resolveSecret: typeof ResolveSecretFn;
  checkEnvFilePermissions: typeof CheckEnvFn;
  verifyScopes: typeof VerifyScopesFn;
  verifyChannelMembership: typeof VerifyMembershipFn;
  buildSlackAppManifest: typeof BuildManifestFn;
  FEATURE_SCOPES: typeof FeatureScopes;
  BASELINE_REQUIRED_SCOPES: typeof BaselineScopes;
}

export interface SlackDeps {
  home?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  /** 可注入的后台服务接口加载器（测试用）。默认：惰性导入窄子路径。 */
  surface?: () => Promise<SlackSurface>;
  clientFactory?: () => Pick<DaemonClient, "post">;
}

const RETIRED_TEACHING =
  "已退役（S10 切换）：网关现在跑在后台服务内——该子系统自己轮询队列、发到 Slack、" +
  "并消费 Socket Mode 入站；没有可调用的 relay 运行器。" +
  "用 `rig slack status` 查看配置、`curl /api/health-summary/gateway` 查看子系统健康状态，" +
  "用 `rig slack enable` 激活投递。";

const MANIFEST_FIRST_STEP =
  "`zrig slack manifest --url` 会打印一个链接，按 zrig 的 manifest 创建你自己的 Slack app（见 `zrig slack manifest --help`）";

function resolveSecrets(surface: SlackSurface, cfg: SlackConnectorConfig): { bot: string | null; app: string | null } {
  const envFile = cfg.secretsEnvFile ?? undefined;
  return {
    bot: surface.resolveSecret(SECRET_BOT, { envFile }),
    app: surface.resolveSecret(SECRET_APP, { envFile }),
  };
}

export function slackCommand(deps: SlackDeps = {}): Command {
  const log = deps.log ?? ((m: string) => console.log(m));
  const loadSurface = deps.surface ?? (async () => (await import("@openrig/daemon/gateway-slack")) as SlackSurface);
  const clientFactory = deps.clientFactory ?? (() => new DaemonClient());

  const cmd = new Command("slack").description("Slack 连接器：配置 + 后台服务内子系统管理（S10）");

  // ---- setup ----
  cmd
    .command("setup")
    .description("配置连接器（一等配置；密钥留在 env 文件，绝不写在这里）")
    .option("--channel <id>", "连接器 app 必须加入的 Slack 频道 id")
    .option("--inbound-destination <session>", "入站人类消息落到哪里（默认 operator-agent@kernel）")
    .option("--minimum-level-that-posts <level>", "发到 Slack 的最低 OWNER 级别：RECORD|NOTICE|ALERT")
    .option("--minimum-level-that-interrupts <level>", "触发 @ 提及/打断的最低 OWNER 级别：RECORD|NOTICE|ALERT")
    .option("--source-label <label>", "发出消息页脚显示的标签（队列所在处）")
    .option("--secrets-env-file <path>", "含 SLACK_BOT_TOKEN / SLACK_APP_TOKEN 的 0600 env 文件路径")
    .option("--required-scopes <csv>", "verify 时要求的逗号分隔 bot scope")
    .option("--reason <reason>", "配置变更时记录的原因", "配置人类投递")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cur = surface.loadConfig(deps.home);
      const next: SlackConnectorConfig = {
        ...cur,
        channel: opts.channel ?? cur.channel,
        inboundDestination: opts.inboundDestination ?? cur.inboundDestination,
        minimumLevelThatPosts: opts.minimumLevelThatPosts ?? cur.minimumLevelThatPosts,
        minimumLevelThatInterrupts: opts.minimumLevelThatInterrupts ?? cur.minimumLevelThatInterrupts,
        sourceLabel: opts.sourceLabel ?? cur.sourceLabel,
        secretsEnvFile: opts.secretsEnvFile ?? cur.secretsEnvFile,
        requiredScopes: opts.requiredScopes ? String(opts.requiredScopes).split(",").map((s: string) => s.trim()).filter(Boolean) : cur.requiredScopes,
      };
      const { runChannelOperation, channelStateDigest } = await import("@openrig/daemon/gateway-slack");
      const result = await runChannelOperation({
        actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1",
        reason: opts.reason, action: "configure", subject: "slack", before: { digest: channelStateDigest(cur) },
        run: async () => ({ value: surface.saveConfig(next, deps.home), after: { digest: channelStateDigest(next) },
          effect: channelStateDigest(cur) === channelStateDigest(next) ? "no-op" : "applied" }),
      }, deps.home);
      log(`已写入 ${result.value}；回执 ${result.receipt.id}（${result.receipt.effect}）`);
      log(`下一步：如果还没有 Slack app，从 ${MANIFEST_FIRST_STEP} 开始。然后把 SLACK_BOT_TOKEN / SLACK_APP_TOKEN 放进 ${next.secretsEnvFile ?? "<--secrets-env-file> (0600)"}，再 \`zrig slack verify\`，然后 \`zrig slack enable\`。`);
    });

  // ---- status（如实报告未配置状态，不联网） ----
  cmd
    .command("status")
    .description("展示连接器已配置 + 可解析的状态（如实；不联网）")
    .option("--json", "以 JSON 输出")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      const readiness = surface.staticReadiness(cfg, s.bot !== null, s.app !== null);
      const permWarn = cfg.secretsEnvFile ? surface.checkEnvFilePermissions(cfg.secretsEnvFile) : null;
      const unconfigured = readiness.some((r) => !r.ok);
      const next = unconfigured ? `第一步：${MANIFEST_FIRST_STEP}。` : null;
      if (opts.json) {
        log(JSON.stringify({ config: { ...cfg }, readiness, permWarning: permWarn, next }));
      } else {
        log(`slack-connector（配置：${cfg.enabled ? "已启用" : "已禁用"}；投递在后台服务内运行——S10 子系统）`);
        for (const r of readiness) log(`  ${r.ok ? "✓" : "✗"} ${r.label}：${r.detail}`);
        if (permWarn) log(`  ⚠ ${permWarn}`);
        if (next) log(`  ${next}`);
      }
    });

  // ---- manifest（离线：不连后台服务、不要 token、不联网） ----
  cmd
    .command("manifest")
    .description("打印用于创建你自己的 zrig Slack app 的 Slack manifest（离线）")
    .option("--url", "打印 Slack 的 create-app 链接，manifest 已预填（URL 编码）")
    .option("--json", "以 JSON 输出：manifest 及其 bot scope 与 bot 事件")
    .addHelpText("after", [
      "",
      "不会创建任何东西：在登录你 Slack 工作区的浏览器里自己打开 --url 链接。",
      "该 app 仅对该工作区私有（Socket Mode；zrig 不托管任何东西，也不发布任何东西）。",
      "--json 列出每个申请的 scope 及原因。`zrig slack verify` 只检查基线 scope，",
      "因此那里 READY 并不能证明附件或 @ 提及已拿到授权。",
      "创建 app 后的步骤：docs/reference/slack-app-setup.md",
      "（已安装到 $OPENRIG_HOME/reference/slack-app-setup.md）。",
    ].join("\n"))
    .action(async (opts) => {
      const surface = await loadSurface();
      const bundle = surface.buildSlackAppManifest();
      if (opts.json) {
        const reasons: Record<string, string> = {};
        for (const scope of surface.BASELINE_REQUIRED_SCOPES) reasons[scope] = "基线：由 `zrig slack verify` 检查";
        for (const f of surface.FEATURE_SCOPES) reasons[f.scope] = `功能，不由 verify 检查：${f.usedBy}`;
        log(JSON.stringify({
          manifest: bundle.manifest, url: bundle.url, scopes: bundle.scopes, events: bundle.events,
          why: Object.fromEntries(bundle.scopes.map((scope) => [scope, reasons[scope] ?? "未说明"])),
        }));
      }
      else if (opts.url) log(bundle.url);
      else log(bundle.yaml.trimEnd());
    });

  // ---- verify（在线：从响应头拿到的已授权 scope + 频道成员关系） ----
  cmd
    .command("verify")
    .description("在线核验已授权的 Slack scope（来自响应头）+ 频道成员关系")
    .option("--json", "以 JSON 输出")
    .option("--reason <reason>", "核验时记录的原因", "核验人类投递")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      const { runChannelOperation, channelStateDigest } = await import("@openrig/daemon/gateway-slack");
      const verification = await runChannelOperation({
        actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1",
        reason: opts.reason, action: "verify", subject: "slack", before: { digest: channelStateDigest(cfg) },
        run: async () => {
          const scope = s.bot ? await surface.verifyScopes(s.bot, cfg.requiredScopes, deps.fetchImpl) : null;
          const member = s.bot && cfg.channel ? await surface.verifyChannelMembership(s.bot, cfg.channel, deps.fetchImpl) : null;
          const ready = scope === null || scope.error || member?.error ? null : scope.ok && (member?.isMember ?? false);
          return { value: { scope, member }, after: { ready }, effect: "observed" };
        },
      }, deps.home);
      if (!s.bot) {
        log("✗ 无法解析 bot token——请设置 SLACK_BOT_TOKEN（环境变量或 secrets env 文件）。无法核验。");
        process.exitCode = 1;
        return;
      }
      const scope = verification.value.scope!;
      const member = verification.value.member;
      const ready = scope.ok && (member ? member.isMember : false);
      if (opts.json) {
        log(JSON.stringify({ scope, member, ready, receipt: verification.receipt }));
      } else {
        log(`已授权 scope：${scope.granted.join(", ") || "（无）"}`);
        if (!scope.ok) log(`✗ 缺少 scope（配置 ≠ 已授权——请重装 app）：${scope.missing.join(", ")}${scope.error ? ` [${scope.error}]` : ""}`);
        else log("✓ 所有必需 scope 已授权");
        if (member) log(member.isMember ? `✓ 已是频道成员（${member.name ?? cfg.channel}）` : `✗ 不是频道 ${cfg.channel} 的成员——请邀请该 app`);
        else log("… 未配置频道——请设置 --channel 以核验成员关系");
        log(ready ? "就绪" : "未就绪");
      }
      if (!ready) process.exitCode = 1;
    });

  // ---- enable / disable（后台服务管理：seeding + 子系统重启在后台服务侧进行） ----
  cmd
    .command("enable")
    .description("启用连接器（后台服务把当前 backlog 作为历史 seeding——不重放飞船——然后重新接线）")
    .option("--reason <reason>", "变更时记录的原因", "启用人类投递")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (opts) => {
      try {
        const res = await clientFactory().post<{ ok: boolean; seeded: number; onlineStatus: string }>("/api/gateway/slack/enable", { reason: opts.reason, actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK });
        if (res.status !== 200 || res.data.ok !== true) throw new Error(`后台服务拒绝 enable（HTTP ${res.status}）：${JSON.stringify(res.data)}`);
        log(res.data.onlineStatus);
      } catch (e) {
        log(`✗ enable 失败：${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command("disable")
    .description("禁用连接器（后台服务重新接到惰性投递路径）")
    .requiredOption("--reason <reason>", "为何关闭人类投递（记录在生命周期回执中）")
    .option("--actor <actor>", "不在受管席位内时的具名操作人员")
    .action(async (opts) => {
      try {
        const res = await clientFactory().post<{ ok: boolean }>("/api/gateway/slack/disable", { reason: opts.reason, actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK });
        if (res.status !== 200 || res.data.ok !== true) throw new Error(`后台服务拒绝 disable（HTTP ${res.status}）：${JSON.stringify(res.data)}`);
        log("slack 连接器已禁用");
      } catch (e) {
        log(`✗ disable 失败：${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ---- 已退役的 relay 运行器（S10 切换）：带提示拒绝，绝不静默 no-op ----
  cmd
    .command("outbound")
    .description("[已退役——S10] 后台服务内子系统拥有出站投递")
    .option("--json", "（忽略）")
    .action(() => {
      log(RETIRED_TEACHING);
      process.exitCode = 1;
    });

  cmd
    .command("inbound")
    .description("[已退役——S10] 后台服务内子系统拥有 Socket Mode 入站")
    .action(() => {
      log(RETIRED_TEACHING);
      process.exitCode = 1;
    });

  return cmd;
}
