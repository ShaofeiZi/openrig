import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  HEALTH_SEVERITIES,
  HEALTH_STATUSES,
  type HealthRecord,
  type HealthScope,
} from "@openrig/daemon/health-projection";
import type { HealthListProjection } from "@openrig/daemon/health-detectors";
import {
  DaemonClient,
  DaemonConnectionError,
  DaemonResponseError,
  DaemonTimeoutError,
} from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  statusGuardMessage,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { resolveIdentitySource } from "./whoami.js";
import type { StatusDeps } from "./status.js";
import { shellQuote } from "../cross-host-executor.js";
import { omittedReadField, readView } from "../read-view.js";

interface DiagnosisEntry {
  row: Record<string, unknown> & { qitemId: string };
  finding: HealthRecord;
  packet: Record<string, unknown> & { instructions: string };
  receipts: unknown[];
  authority: Array<{ path: string; state: string; content?: string; role?: string; reason?: string; selectedBy?: string }>;
  disposition: { verdict: string; causalStart: string | null; steering: string; uncertainty: string; evidenceRefs: string[];
    correction?: { applicability: string; causalJudgment: string; action: { state: string; summary: string }; effect: { state: string; summary: string } } } | null;
  assessment?: { actor?: string; at: string } | null;
  behavioralEffect?: string;
  guidance?: string;
  humanDelivery: { qitemId: string; outcome: string } | null;
  notificationReadiness?: { ready: boolean; reason: string } | null;
}

function diagnosisPreview(entry: DiagnosisEntry) {
  const omitted: ReturnType<typeof omittedReadField>[] = [];
  // ponytail：只省略已知证据载荷；保持当前决策与未知项原样。
  function without<T extends object>(record: T, keys: string[], prefix = ""): T {
    const copy = { ...record } as Record<string, unknown>;
    for (const key of keys) {
      const value = copy[key];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
      omitted.push(omittedReadField(`${prefix}${key}`, value));
      delete copy[key];
    }
    return copy as T;
  }
  const result = without(entry, ["receipts", "guidance"]);
  result.row = without(entry.row, ["body", "chainOfRecord"], "row.");
  result.packet = without(entry.packet, ["finding", "authority", "instructions"], "packet.");
  result.finding = without(entry.finding, ["evidence"], "finding.");
  if (entry.finding.ceremony) {
    result.finding.ceremony = { ...entry.finding.ceremony,
      workflowReceipts: entry.finding.ceremony.workflowReceipts.map((receipt, index) => {
        const envelope = without(receipt, ["evidence"], `finding.ceremony.workflowReceipts[${index}].`);
        const evidence = receipt.evidence;
        // 这些是既有 cut/acceptance 身份拼写，不是对 receipt 的判定。
        const identity = evidence && typeof evidence === "object" && !Array.isArray(evidence)
          ? Object.fromEntries(Object.entries(evidence).filter(([key, value]) =>
            ["candidate", "candidateSha", "candidate_sha", "cutSha", "tree", "verdict", "evidenceRef", "evidence_ref"].includes(key)
            && typeof value === "string"))
          : {};
        return { ...envelope, evidenceIdentity: identity };
      }),
    };
  }
  result.authority = entry.authority.map((ref, index) => without(ref, ["content"], `authority[${index}].`));
  return { ...result, readView: readView(entry, `rig health diagnosis show ${shellQuote(entry.row.qitemId)} --full --json`, omitted) };
}

const HEALTH_ERROR_SCHEMA = "openrig.health-error/v0alpha1" as const;

type IdentitySource = { nodeId?: string; sessionName?: string };

export interface HealthDeps extends StatusDeps {
  resolveIdentity: () => IdentitySource | null;
}

interface HealthListOptions {
  self?: boolean;
  seat?: string;
  rig?: string;
  instance?: string | boolean;
  severity?: string;
  status?: string;
  limit?: number;
  json?: boolean;
}

interface HealthCliError {
  schema: typeof HEALTH_ERROR_SCHEMA;
  error: string;
  message: string;
  nextInspection: string;
  details?: unknown;
}

function defaultDeps(): HealthDeps {
  return {
    lifecycleDeps: realDeps(),
    clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
    resolveIdentity: () => resolveIdentitySource({}),
  };
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new InvalidArgumentError("必须是 1 到 200 之间的整数");
  }
  return parsed;
}

function emitError(error: HealthCliError, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(error));
  } else {
    console.error(`错误：${error.message}`);
    console.error(`  下一步检查：${error.nextInspection}`);
  }
  process.exitCode = 1;
}

function daemonError(details: unknown): HealthCliError {
  return {
    schema: HEALTH_ERROR_SCHEMA,
    error: "health_daemon_unavailable",
    message: "无法读取健康投影，因为后台服务没有响应。",
    nextInspection: "zrig daemon status",
    details,
  };
}

function responseError(status: number, data: unknown): HealthCliError {
  const daemonCode = typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
    ? (data as { error: string }).error
    : null;
  if (status === 503 && daemonCode === "health_projection_unavailable") {
    return {
      schema: HEALTH_ERROR_SCHEMA,
      error: daemonCode,
      message: "后台服务可连接，但健康投影不可用。",
      nextInspection: "zrig daemon status",
    };
  }
  if (status === 404 && daemonCode === "health_finding_not_found") {
    return {
      schema: HEALTH_ERROR_SCHEMA,
      error: daemonCode,
      message: "当前投影中不存在该 ID 的健康发现。",
      nextInspection: "rig health --instance --json",
    };
  }
  if (status === 404 && daemonCode === "not_found") {
    return {
      schema: HEALTH_ERROR_SCHEMA,
      error: "health_projection_unavailable",
      message: "后台服务可连接，但它没有暴露健康投影。",
      nextInspection: "rig --version",
      details: data,
    };
  }
  return {
    schema: HEALTH_ERROR_SCHEMA,
    error: "health_query_failed",
    message: `后台服务拒绝了健康查询（HTTP ${status}）。`,
    nextInspection: "rig health --help",
    details: data,
  };
}

async function readyClient(deps: HealthDeps, json: boolean): Promise<DaemonClient | null> {
  const status = await getDaemonStatus(deps.lifecycleDeps, { cleanupStaleState: false });
  if (status.state !== "running" || status.healthy === false) {
    emitError(daemonError(statusGuardMessage(status)), json);
    return null;
  }
  return deps.clientFactory(getDaemonUrl(status));
}

async function readSelfSeatId(client: DaemonClient, deps: HealthDeps, json: boolean): Promise<string | null> {
  const source = deps.resolveIdentity();
  if (!source) {
    emitError({
      schema: HEALTH_ERROR_SCHEMA,
      error: "health_identity_unavailable",
      message: "当前席位身份不可用，无法安全地把自身健康限定到范围。",
      nextInspection: "rig whoami --json",
    }, json);
    return null;
  }

  const params = new URLSearchParams();
  if (source.nodeId) params.set("nodeId", source.nodeId);
  else if (source.sessionName) params.set("sessionName", source.sessionName);
  params.set("compact", "1");
  const response = await client.get<Record<string, unknown>>(`/api/whoami?${params.toString()}`);
  if (response.status === 409) {
    emitError({
      schema: HEALTH_ERROR_SCHEMA,
      error: "health_identity_ambiguous",
      message: "当前身份匹配到多个受管席位。",
      nextInspection: "zrig ps --nodes -A",
      details: response.data,
    }, json);
    return null;
  }
  if (response.status >= 400) {
    emitError({
      schema: HEALTH_ERROR_SCHEMA,
      error: "health_identity_unavailable",
      message: "后台服务无法解析当前席位身份。",
      nextInspection: "rig whoami --json",
      details: response.data,
    }, json);
    return null;
  }
  const identity = response.data["identity"];
  const nodeId = typeof identity === "object" && identity !== null
    ? (identity as Record<string, unknown>)["nodeId"]
    : null;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    emitError({
      schema: HEALTH_ERROR_SCHEMA,
      error: "health_identity_indeterminate",
      message: "身份响应未携带稳定节点 ID，因此自身健康状态不确定。",
      nextInspection: "rig whoami --full --json",
      details: response.data,
    }, json);
    return null;
  }
  return nodeId;
}

function scopeLabel(scope: HealthScope): string {
  switch (scope.type) {
    case "instance": return `instance:${scope.instanceId}`;
    case "rig": return `rig:${scope.rigId}`;
    case "seat": return `seat:${scope.seatId}`;
    case "mission": return `mission:${scope.missionId}`;
    case "slice": return `slice:${scope.sliceId}`;
  }
}

function renderList(projection: HealthListProjection): void {
  const evaluated = projection.evaluatedAt ?? "不可用";
  console.log(`机队健康——评估时间=${evaluated} 发现数=${projection.total} 上限=${projection.limit}`);
  if (projection.records.length === 0) {
    console.log("没有健康发现匹配这个有界查询。这不等于健康断言。");
    console.log("下一步检查：按需用 `rig health --instance --json` 扩大范围。");
    return;
  }
  for (const record of projection.records) {
    console.log(`${record.id}  ${record.severity}  ${record.status}  ${record.detector}`);
    console.log(`  ${scopeLabel(record.scope)}  ${record.confidence} 置信度  新鲜度=${record.freshness.state}${record.indeterminateReason ? `  不确定原因=${record.indeterminateReason}` : ""}`);
    console.log(`  ${record.summary}`);
    if (record.operatingPosture) console.log(`  运行姿态：${record.operatingPosture.posture}（${record.operatingPosture.source}）；阶段=${record.operatingPosture.context?.phase.value ?? "未知"}`);
  }
  if (projection.truncated) {
    console.log(`已在 ${projection.total} 条中截断到 ${projection.limit} 条；请缩小范围或提高 --limit（最大 200）。`);
  }
}

function renderExplanation(record: HealthRecord): void {
  console.log(`健康发现 ${record.id}`);
  console.log(`  探测器：    ${record.detector}（${record.category}）`);
  console.log(`  范围：      ${scopeLabel(record.scope)}`);
  console.log(`  结果：      ${record.severity} / ${record.status} / ${record.confidence} 置信度`);
  console.log(`  观测：      ${record.startedAt ?? "不可用"} → ${record.lastObservedAt ?? "不可用"}`);
  console.log(`  窗口：      ${record.window.startedAt} → ${record.window.endedAt}；来源=${record.window.source}；上限=${record.window.limit}；保留=${record.window.retentionSeconds}s`);
  console.log(`  新鲜度：    ${record.freshness.state}；评估时间=${record.freshness.evaluatedAt}；最新=${record.freshness.newestSourceAt ?? "不可用"}；最大年龄=${record.freshness.maxAgeSeconds}s；年龄=${record.freshness.ageSeconds ?? "不可用"}s`);
  if (record.indeterminateReason) console.log(`  不确定：${record.indeterminateReason}`);
  console.log(`  规则：      ${record.threshold}`);
  console.log(`  策略：      ${record.policyVersion ?? "来源未报告"}`);
  if (record.operatingPosture) console.log(`  姿态：      ${JSON.stringify(record.operatingPosture)}`);
  console.log(`  解释：      ${record.explanation}`);
  console.log(`  证据：      ${JSON.stringify(record.evidence)}`);
  if (record.ceremony) console.log(`  诊断阶段：${record.ceremony.stage}\n  常规上下文：${JSON.stringify(record.ceremony)}`);
  console.log(`  检查：      ${record.suggestedInspection}`);
}

async function guardedRequest<T>(
  request: () => Promise<{ status: number; data: T }>,
  json: boolean,
): Promise<{ status: number; data: T } | null> {
  try {
    return await request();
  } catch (error) {
    const details = error instanceof DaemonTimeoutError
      ? { kind: "timeout", message: error.message }
      : error instanceof DaemonResponseError
        ? { kind: "unreadable-response", status: error.status, bodySnippet: error.bodySnippet }
        : error instanceof DaemonConnectionError
          ? { kind: "connection", message: error.message }
          : { kind: "unexpected", message: error instanceof Error ? error.message : String(error) };
    emitError(daemonError(details), json);
    return null;
  }
}

export function healthCommand(depsOverride?: HealthDeps): Command {
  const deps = depsOverride ?? defaultDeps();
  const command = new Command("health")
    .description("检查只读、可解释的系统健康记录")
    .addOption(new Option("--self", "检查当前席位（默认）").conflicts(["seat", "rig", "instance"]))
    .addOption(new Option("--seat <node-id>", "按稳定节点 ID 检查一个席位").conflicts(["self", "rig", "instance"]))
    .addOption(new Option("--rig <rig-id>", "检查规范范围为该工作组的发现").conflicts(["self", "seat", "instance"]))
    .addOption(new Option("--instance [instance-id]", "检查整个本地实例，或按 ID 检查一个规范实例范围").conflicts(["self", "seat", "rig"]))
    .addOption(new Option("--severity <severity>", "按严重程度过滤").choices([...HEALTH_SEVERITIES]))
    .addOption(new Option("--status <status>", "按发现状态过滤").choices([...HEALTH_STATUSES]))
    .option("--limit <count>", "最大发现条数（1-200）", parseLimit, 100)
    .option("--json", "以 JSON 输出；diagnosis list/show 需要 --full 才能拿到完整证据")
    .option("--actor <name>", "不在受管席位内操作时，为显式诊断写入署名")
    .addHelpText("after", `
默认范围是当前席位。不带 ID 的 --instance 是有界的实例范围投影。
空输出不等于健康断言。本命令的 list/explain 永不修改状态。诊断修改使用显式子命令；
自动诊断展示是可选策略。`);

  command.action(async (options: HealthListOptions) => {
    const json = Boolean(options.json);
    const client = await readyClient(deps, json);
    if (!client) return;

    let scopeType: HealthScope["type"] | undefined;
    let scopeId: string | undefined;
    if (options.seat) {
      scopeType = "seat";
      scopeId = options.seat;
    } else if (options.rig) {
      scopeType = "rig";
      scopeId = options.rig;
    } else if (typeof options.instance === "string") {
      scopeType = "instance";
      scopeId = options.instance;
    } else if (!options.instance) {
      const seatId = await guardedRequest(
        () => readSelfSeatId(client, deps, json).then((data) => ({ status: data === null ? 1 : 0, data })),
        json,
      );
      if (!seatId || seatId.data === null) return;
      scopeType = "seat";
      scopeId = seatId.data;
    }

    const params = new URLSearchParams();
    if (scopeType && scopeId) {
      params.set("scope_type", scopeType);
      params.set("scope_id", scopeId);
    }
    params.set("limit", String(options.limit ?? 100));
    if (options.severity) params.set("severity", options.severity);
    if (options.status) params.set("status", options.status);
    const response = await guardedRequest(
      () => client.get<HealthListProjection>(`/api/health?${params.toString()}`),
      json,
    );
    if (!response) return;
    if (response.status >= 400) {
      emitError(responseError(response.status, response.data), json);
      return;
    }
    if (json) console.log(JSON.stringify(response.data));
    else renderList(response.data);
  });

  command
    .command("explain <finding-id>")
    .description("根据规范的有界记录解释一条健康发现")
    .option("--json", "以 JSON 输出规范的后台服务健康记录")
    .action(async (findingId: string, options: { json?: boolean }) => {
      const json = Boolean(options.json || command.opts().json);
      const client = await readyClient(deps, json);
      if (!client) return;
      const response = await guardedRequest(
        () => client.get<HealthRecord>(`/api/health/${encodeURIComponent(findingId)}`),
        json,
      );
      if (!response) return;
      if (response.status >= 400) {
        emitError(responseError(response.status, response.data), json);
        return;
      }
      if (json) console.log(JSON.stringify(response.data));
      else renderExplanation(response.data);
    });

  async function diagnosisRequest(path: string, options: { json?: boolean; full?: boolean }, payload?: unknown) {
    const json = Boolean(options.json || command.opts().json);
    const client = await readyClient(deps, json);
    if (!client) return;
    const response = await guardedRequest(() => payload === undefined ? client.get(`/api/health-diagnosis${path}`) : client.post(`/api/health-diagnosis${path}`, { ...(payload as object), actor: command.opts().actor }), json);
    if (!response) return;
    if (response.status >= 400) { console.error(JSON.stringify(response.data)); process.exitCode = 1; return; }
    const occurrenceRead = payload === undefined && path !== "/policy" && path !== "/checkpoints";
    if (options.full || json || path === "/policy" || path === "/checkpoints" || path === "/evaluate" || path.endsWith("/notify")) {
      const data = occurrenceRead && !options.full
        ? (Array.isArray(response.data) ? response.data.map((entry) => diagnosisPreview(entry as DiagnosisEntry)) : diagnosisPreview(response.data as DiagnosisEntry))
        : response.data;
      console.log(JSON.stringify(data, null, json ? undefined : 2));
    } else {
      const entries = Array.isArray(response.data) ? response.data : [response.data];
      if (!entries.length) console.log("没有诊断发生记录。这不等于健康断言。");
      for (const entry of entries as DiagnosisEntry[]) {
        console.log(`${entry.row.qitemId}  ${entry.finding.status}  ${entry.finding.detector}`);
        console.log(`  判定：${entry.disposition?.verdict ?? "等待智能体调查"}`);
        if (path) {
          console.log(`  队列：${entry.row.state ?? "未知"}  负责人：${entry.row.destinationSession ?? "未知"}  阻塞于：${entry.row.blockedOn ?? "未记录"}`);
          if (entry.notificationReadiness) console.log(`  人类 readiness：${entry.notificationReadiness.ready ? "就绪" : "不可用"} — ${entry.notificationReadiness.reason}`);
          if (entry.humanDelivery) console.log(`  人类投递：${entry.humanDelivery.outcome}（${entry.humanDelivery.qitemId}）`);
          console.log(`  发现：${entry.finding.id}  策略：${entry.finding.policyVersion ?? "未报告"}`);
          console.log(`  ${entry.finding.explanation}`);
          if (entry.finding.operatingPosture) console.log(`  姿态：${entry.finding.operatingPosture.posture}（${entry.finding.operatingPosture.source}）；阶段=${entry.finding.operatingPosture.context?.phase.value ?? "未知"}；${entry.finding.operatingPosture.reason}`);
          console.log(`  起点：${entry.disposition?.causalStart ?? "未知"}`);
          console.log(`  引导：${entry.disposition?.steering ?? "尚未记录"}`);
          console.log(`  不确定性：${entry.disposition?.uncertainty ?? entry.finding.indeterminateReason ?? "诊断待处理"}`);
          if (entry.assessment) console.log(`  署名评估：${entry.assessment.actor ?? "未知"} 于 ${entry.assessment.at}`);
          const correction = entry.disposition?.correction;
          if (correction) {
            console.log(`  适用性：${correction.applicability}`);
            console.log(`  因果判定：${correction.causalJudgment}`);
            console.log(`  动作（${correction.action.state}）：${correction.action.summary}`);
          }
          console.log(`  后续行为效果（负责人报告）：${correction?.effect.state ?? "未观测"}${correction ? " — " + correction.effect.summary : " — 仅有判定或放行本身并不构成行为改变"}`);
          for (const ref of entry.authority) console.log(`  ${ref.role ?? "权威来源"}（${ref.state}）：${ref.path}${ref.selectedBy ? " 选择者 " + ref.selectedBy : ""}${ref.reason ? " — " + ref.reason : ""}`);
          if (occurrenceRead) {
            const view = diagnosisPreview(entry).readView;
            console.log(`  证据预览；完整记录 ${view.fullJsonBytes} JSON 字节：${view.fullCommand}`);
          } else console.log(`  ${entry.packet.instructions}`);
        }
      }
    }
  }
  function fromFile(file: string): unknown {
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > 1048576) throw new Error("健康输入超过 1 MiB");
    return JSON.parse(text);
  }
  command.command("policy").description("检查生效策略与引擎状态；用 --file 应用编辑后的 JSON")
    .option("--file <path>", "应用策略 JSON 并附审计记录").option("--json")
    .action(async (o: { file?: string; json?: boolean }) => diagnosisRequest("/policy", o, o.file ? { value: fromFile(o.file) } : undefined));
  command.command("checkpoint").description("检查或提交结果边界谱系普查（不是每次编辑的仪式）")
    .option("--file <path>", "提交 checkpoint JSON 并附准确的队列与产品证据").option("--json")
    .action(async (o: { file?: string; json?: boolean }) => diagnosisRequest("/checkpoints", o, o.file ? { value: fromFile(o.file) } : undefined));
  command.command("diagnose").description("预览策略准入；--apply 创建或重新呈现有界诊断上下文")
    .option("--apply").option("--json").action(async (o: { apply?: boolean; json?: boolean }) => diagnosisRequest("/evaluate", o, { apply: Boolean(o.apply) }));
  const diagnosis = command.command("diagnosis").description("读取发生记录并记录智能体拥有的判定");
  diagnosis.command("list").description("列出发生记录摘要；证据载荷需要 --full")
    .option("--json", "摘要数组，含明确省略字段与每条发生记录的展开命令")
    .option("--full", "完整记录，含全部证据与 receipt；可能很大")
    .action(async (o: { json?: boolean; full?: boolean }) => diagnosisRequest("", o));
  diagnosis.command("show <qitem-id>").description("检查当前状态与决策；有意识地展开保留的证据")
    .option("--json", "摘要 JSON，含省略字段、原始字节数与完整命令")
    .option("--full", "完整原始记录；用 --full --json 得到无损 JSON（可能很大）")
    .action(async (id: string, o: { json?: boolean; full?: boolean }) => diagnosisRequest(`/${encodeURIComponent(id)}`, o));
  diagnosis.command("record <qitem-id>").requiredOption("--file <path>", "判定 JSON，含 verdict、causalStart、steering、uncertainty、evidenceRefs").option("--json")
    .action(async (id: string, o: { file: string; json?: boolean }) => diagnosisRequest(`/${encodeURIComponent(id)}/disposition`, o, { value: fromFile(o.file) }));
  diagnosis.command("notify <qitem-id>").description("在策略与已核验的连接器 readiness 下显式请求人类投递").option("--json")
    .action(async (id: string, o: { json?: boolean }) => diagnosisRequest(`/${encodeURIComponent(id)}/notify`, o, {}));
  return command;
}
