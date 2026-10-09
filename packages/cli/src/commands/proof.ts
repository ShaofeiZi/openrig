import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { DaemonClient } from "../client.js";
import { findSlice, resolveMissionsRoot } from "../lib/scope/scope-fs.js";
import { ScopeCliError } from "../lib/scope/types.js";
import { selectProofContractBody, isScaffoldPlaceholderText } from "../lib/scope/scaffold-placeholder.js";
import { parseLogicalCheckboxes } from "../lib/scope/logical-checkbox.js";

/**
 * `rig proof add`——证据捕获写路径（OPR.0.4.4.19 FR-8 + FR-11；
 * 约定 C1 + C2 + C8、D2 证明）。
 *
 * 捕获这一段只在 CLI 侧文件系统完成：drop 在证据到手的那一刻
 * 校验 C1 头，把产物写进 slice 的 proof/ 目录，并回显解析后的头
 * （席位看到的就是 composer 会看到的）。不涉及后台服务，不合成 qitem，
 * 不写数据库。
 *
 * 承重边界：
 *   - 校验只作用于经由本路径做出的 drop。以其他任何方式写出的产物
 *     （直接写文件、既有工作流）在写入时绝不被拦截——兜底是
 *     `rig scope audit`（FR-10），而不是在普通文件 I/O 上设写入闸门。
 *   - D2 proof contract + self_check 是记录在这里的智能体判断；
 *     drop 路径只建议（退出码 0），绝不据此拦截。没有任何配置能让
 *     任何建议变成拦截（BR-7）。
 */

/** C1 已批准的闭集（BR-4——扩展它们是 pm-lead 主导的约定变更，不是代码决定）。 */
export const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
export const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;

/** C8 UX 建议用的视频扩展名（录屏证据）。 */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);

export interface C1Header {
  slice: string;
  candidate_sha: string;
  artifact_type: string;
  verdict: string;
  money_evidence: string;
  /** D2 可选证明字段——只建议不拦截。 */
  evidences?: string[];
  self_check?: string;
}

export interface C1ValidationResult {
  ok: boolean;
  missing: string[];
  invalid: Array<{ field: string; value: string; allowed: readonly string[] }>;
}

const PROOF_CONTRACT_HEADING_RE = /^##\s+(?:Proof contract|证明契约|证据约定)\s*$/i;

/** 校验五个必填 C1 字段 + 闭集。纯函数。 */
export function validateC1Header(header: Partial<C1Header>): C1ValidationResult {
  const missing: string[] = [];
  for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"] as const) {
    const value = header[field];
    if (typeof value !== "string" || value.trim().length === 0) missing.push(field);
  }
  const invalid: C1ValidationResult["invalid"] = [];
  if (header.artifact_type && !(C1_ARTIFACT_TYPES as readonly string[]).includes(header.artifact_type)) {
    invalid.push({ field: "artifact_type", value: header.artifact_type, allowed: C1_ARTIFACT_TYPES });
  }
  if (header.verdict && !(C1_VERDICTS as readonly string[]).includes(header.verdict)) {
    invalid.push({ field: "verdict", value: header.verdict, allowed: C1_VERDICTS });
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/**
 * 从某 slice 的已撰写工作节点契约（当前工作用 SPEC.md；旧文件名仍可读）中
 * 解析固定的 `## Proof contract` 段。返回承诺项（复选框形式，每行一项）；
 * 当该 slice 未声明契约时返回 null（tier-1 降级——零噪音）。
 */
export function parseProofContract(prdContent: string): string[] | null {
  const lines = prdContent.split("\n");
  const start = lines.findIndex((l) => PROOF_CONTRACT_HEADING_RE.test(l.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) { end = i; break; } // 下一节
  }
  // KI-5.3-2——单一语法：评审 composer 的逻辑复选框关系
  // （仅 CHECKBOX 行，更深的续行 JOINED）。这使得证据索引在
  // 这里和渲染处按同一个 1-based 索引命名同一承诺——没有幽灵裸圆点，
  // 没有被拆开的子圆点平移 byIndex。脚手架占位符不在此过滤：
  // 下方的"纯净脚手架第二面"检查需要看到它们；规范化索引在该检查之后
  // 再逐项过滤，与 composer 的 extractProofContract 完全一致。
  return parseLogicalCheckboxes(lines.slice(start + 1, end).join("\n")).map((it) => it.rawText);
}

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function proofCommand(): Command {
  const cmd = new Command("proof").description(
    "捕获证据（add）、记录带归属的条目判定（judge）、读取派生就绪度（show）。捕获、策略接受、更高结果判定与发布相互独立。"
  );
  cmd.addHelpText("after", `
show/judge 由所选后台服务负责。作用域地址为 mission/slices/slice#item。
项目所有者在所属 slice.yaml、mission.yaml 或 project.yaml 中选择
proofPolicy: { judges: [精确席位地址] }（就近生效；无默认闸门角色）。
契约即已撰写的 ## Proof contract。单一条目无需 # 选择器。

示例（既有证据，无需复制哈希或操作密钥）：
  rig proof judge trial/slices/01-build#1 --verdict accept --reason '观察到承诺的结果' --evidence proof/result.md
  rig proof show trial --json
  rig proof judge trial/slices/01-build#1 --verdict withdraw --reason '结果不再支持接受'

更正会在 proof/judgments/ 保留此前收据。--replace 刻意在更正后
重申一条历史上完全相同的判定；普通重试返回其原始收据加当前就绪度，
绝不恢复旧事实。补丁等价比较收据与高级身份见 judge --help。
旧版 proof add 产物可直接引用；在所选 proof 策略下，队列 done 与已存
复选框不接受为一个条目作证。
`);
  cmd.option("--workspace <path>", "仅 capture/add：覆盖工作区根；show/judge 使用所选后台服务工作区");

  const client = () => {
    if (cmd.opts().workspace) throw new Error("--workspace 仅适用于 proof add。用 OPENRIG_URL 选择判定后台服务；proof show 会报告其作用域基准。");
    return new DaemonClient();
  };
  const response = async (r: { status: number; data: unknown }): Promise<Record<string, any>> => {
    const data = r.data as Record<string, any>;
    if (r.status >= 400) throw new Error(`${data.error ?? r.status}：${data.message ?? "阅读指定来源后重试"}`);
    return data;
  };
  cmd.command("show [scope]").description("读取某 slice、mission 或活动项目当前带归属的 proof 就绪度；不改动任何状态文件。")
    .option("--json", "结构化就绪度、条目修订与保留的判定引用")
    .action(async (scope, opts) => {
      try {
        const data = await response(await client().get(`/api/proof${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`));
        console.log(opts.json ? JSON.stringify(data) : JSON.stringify(data, null, 2));
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });
  cmd.command("judge <scope-item>").description("记录一条带归属的条目判定并派生就绪度。用 mission/slices/slice#item（索引、文本或 ID）。策略从所属 slice、mission 或项目继承 proofPolicy.judges。")
    .requiredOption("--verdict <verdict>", "accept | reject | withdraw")
    .requiredOption("--reason <text>", "所做的、有证据支撑的判定")
    .option("--evidence <ref>", "既有证据，相对 slice 或 workspace missions/；可重复以指定多个引用", (v: string, prior: string[]) => [...prior, v], [])
    .option("--subject <kind:ref>", "artifact、commit 或补丁等价主体；省略时推断为 artifact")
    .option("--comparison <ref>", "补丁等价主体：随结果证据一起的实际比较/采纳收据")
    .option("--revision <revision>", "高级：刻意要求该条目此修订")
    .option("--operation-id <id>", "高级：显式重试身份")
    .option("--replace", "在更晚的更正后刻意重申一条历史判定")
    .option("--json", "返回已提交收据与当前就绪度")
    .action(async (address: string, opts) => {
      try {
        const at = address.indexOf("#"), scope = at < 0 ? address : address.slice(0, at), selector = at < 0 ? null : address.slice(at + 1);
        const refs = [...new Set<string>([...opts.evidence, ...(opts.comparison ? [opts.comparison] : [])])];
        const query = new URLSearchParams({ scope });
        for (const ref of refs) query.append("evidence", ref);
        const c = client(), view = await response(await c.get(`/api/proof?${query}`));
        const items = view.items as Array<{ id: string; text: string; index: number; revision: string; judgment: { id: string } | null }> | undefined;
        const item = selector ? items?.find(i => i.id === selector || i.text === selector || String(i.index) === selector) : items?.length === 1 ? items[0] : undefined;
        if (!item) throw new Error("用 scope#item 选定一个当前条目；rig proof show 会列出 ID、文本与索引");
        const subjectAt = opts.subject?.indexOf(":") ?? -1;
        if (opts.subject && subjectAt < 1) throw new Error("--subject 必须是 kind:ref 形式");
        const body = { scope, item: item.id, verdict: opts.verdict, reason: opts.reason,
          ...(refs.length ? { evidence: refs, expectedEvidence: view.preparedEvidence } : {}),
          ...(opts.subject ? { subject: { kind: opts.subject.slice(0, subjectAt), ref: opts.subject.slice(subjectAt + 1), ...(opts.comparison ? { comparison: opts.comparison } : {}) } } : {}),
          expectedRevision: opts.revision ?? item.revision, expectedPrevious: item.judgment?.id ?? null,
          operationId: opts.operationId, replace: opts.replace === true };
        const result = await response(await c.post("/api/proof/judge", body));
        console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });

  cmd
    .command("add <slice-path>")
    .description("投放一个 proof 产物：从标志撰写 C1 frontmatter，写入 <slice>/proof/<name>，回显解析后的头。契约/self_check/C8 输出均为建议（退出码 0）——绝不是闸门。")
    .option("--mission <name>", "当 slice-path 仅为 NN-slug 时提示所属 mission")
    .requiredOption("--artifact-type <type>", `C1 artifact_type，取值之一：${C1_ARTIFACT_TYPES.join(" | ")}`)
    .requiredOption("--verdict <verdict>", `C1 verdict，取值之一：${C1_VERDICTS.join(" | ")}`)
    .requiredOption("--candidate-sha <sha>", "C1 candidate_sha——连接键（约定 C2）：本产物所评判的已证明候选 tip")
    .requiredOption("--money-evidence <line>", "C1 money_evidence——那一行关键证据")
    .option("--slice-id <dot-id>", "C1 slice 点分 ID（默认取 slice frontmatter id）")
    .option("--file <path>", "来自文件的产物正文（与 --body 互斥）")
    .option("--body <text>", "内联产物正文（与 --file 互斥）")
    .option("--name <filename>", "proof/ 下的产物文件名（默认取 --file 基名，否则为 <artifact-type>-<verdict>-<UTC>.md）")
    .option("--evidences <refs>", "D2 证明：逗号分隔的、本产物覆盖的 proof-contract 条目引用（条目文本或 1-based 索引）")
    .option("--self-check <text>", "D2 证明：智能体断言自己确实看过证据并确认它支撑该主张")
    .option("--media <refs>", "更正 §3.4：逗号分隔的媒体引用（相对 slice proof/ 目录），本 drop 为其背书——以 markdown 引用形式追加到产物正文，供 composer 策展进 delivered.items[].proof")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (slicePath: string, opts: {
      mission?: string;
      artifactType: string;
      verdict: string;
      candidateSha: string;
      moneyEvidence: string;
      sliceId?: string;
      file?: string;
      body?: string;
      name?: string;
      evidences?: string;
      selfCheck?: string;
      media?: string;
      json?: boolean;
    }, command: Command) => {
      const json = Boolean(opts.json);
      const advisories: string[] = [];
      const warns: string[] = [];
      try {
        if (opts.file && opts.body) {
          throw new ScopeCliError({
            fact: "同时提供了 --file 和 --body。",
            consequence: "产物正文不明确。",
            action: "--file <path> 与 --body <text> 二者只传其一。",
          });
        }
        const parentOpts = (command.parent?.opts() ?? {}) as { workspace?: string };
        const missionsRoot = resolveMissionsRoot({ override: parentOpts.workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);

        // 解析产物正文。
        let body = "";
        if (opts.file) {
          if (!fs.existsSync(opts.file)) {
            throw new ScopeCliError({
              fact: `--file ${opts.file} 不存在。`,
              consequence: "没有可投放的产物正文。",
              action: "把 --file 指向证据文件，或改用 --body。",
            });
          }
          body = fs.readFileSync(opts.file, "utf8");
        } else if (opts.body) {
          body = opts.body;
        }

        // 更正 §3.4——把策展好的媒体引用（相对 proof/）以 markdown 引用形式
        // 附到产物正文；composer 会把它们投影到所覆盖交付物的
        // delivered.items[].proof。与 --name 同样的 containment 纪律：
        // slice 目录之外一概不放。
        const sliceProofDir = path.join(slice.absPath, "proof");
        const mediaRefs = opts.media
          ? opts.media.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const mediaLines: string[] = [];
        for (const ref of mediaRefs) {
          if (path.isAbsolute(ref)) {
            throw new ScopeCliError({
              fact: `--media 引用 '${ref}' 是绝对路径。`,
              consequence: "产物未投放——proof 媒体是同处一目录的 slice 内容（FR-5），相对 slice 的 proof/ 目录引用。",
              action: "把媒体拷进 slice 的 proof/ 目录，再传相对文件名。",
            });
          }
          const resolved = path.resolve(sliceProofDir, ref);
          if (!resolved.startsWith(path.resolve(slice.absPath) + path.sep)) {
            throw new ScopeCliError({
              fact: `--media 引用 '${ref}' 解析到 slice 目录之外。`,
              consequence: "产物未投放——slice 之外的媒体永远无法随评审一起交付或冻结（FR-5）。",
              action: "把媒体移到 slice 目录下（proof/ 是天然位置）后重跑。",
            });
          }
          if (!fs.existsSync(resolved)) {
            warns.push(`--media 引用 '${ref}' 尚不存在（${resolved}）——在文件落位前，评审会显示它不可用`);
          }
          const ext = path.extname(ref).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) mediaLines.push(`<video src="${ref}"></video>`);
          else mediaLines.push(`![${ref}](${ref})`);
        }
        if (mediaLines.length > 0) {
          body = `${body.trimEnd()}\n\n## Media\n\n${mediaLines.join("\n")}\n`;
        }

        // 从标志 + slice 身份撰写 C1 头。
        const header: Partial<C1Header> = {
          slice: opts.sliceId ?? (typeof slice.id === "string" ? slice.id : undefined),
          candidate_sha: opts.candidateSha,
          artifact_type: opts.artifactType,
          verdict: opts.verdict,
          money_evidence: opts.moneyEvidence,
        };
        const evidences = opts.evidences
          ? opts.evidences.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        if (evidences && evidences.length > 0) header.evidences = evidences;
        if (opts.selfCheck) header.self_check = opts.selfCheck;

        // 在投放时校验闭集（此时证据就在手边）——这是本路径唯一会拒绝的校验。
        const validation = validateC1Header(header);
        if (!validation.ok) {
          const parts: string[] = [];
          if (validation.missing.length > 0) parts.push(`缺少必填 C1 字段：${validation.missing.join(", ")}`);
          for (const inv of validation.invalid) {
            parts.push(`${inv.field}='${inv.value}' 不在已批准闭集中（${inv.allowed.join(" | ")}）`);
          }
          throw new ScopeCliError({
            fact: `C1 头非法——${parts.join("；")}。`,
            consequence: "产物未投放（事后补造正是本机制要对抗的失败模式）。",
            action: "在手边还有证据时，补上指定字段并填合法值后重跑。扩展闭集是 pm-lead 的约定变更（BR-4）。",
          });
        }

        // D2——按 slice 声明的 proof 契约校验 evidences 引用
        // （未知引用 = 具名 WARN，绝不拒绝）；当存在契约时输出
        // 覆盖/self_check 建议。
        // KI-5.3-2 后续（行 e69daaef）：契约来源选择单一归位于
        // scaffold-placeholder 孪生（selectProofContractBody）——composer 和
        // audit 消费同一个选择，证据再也不会记在一份契约上、却显示在另一份上。
        // proof-add 读取三份文档，由孪生决定；按架构对等契约，两份孪生
        // 字节相等（刻意不在包间去重——孪生自身头里的裁定；此处偏离了
        // 后续行的子路径导出措辞，并保留该引用：同包孪生 import 维持了
        // 跨包消费者会打破的对等安排）。
        const readDoc = (name: string): string | null => {
          const fp = path.join(slice.absPath, name);
          return fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : null;
        };
        const prdDoc = readDoc("IMPLEMENTATION-PRD.md");
        const specDoc = readDoc("SPEC.md");
        const readmeDoc = readDoc("README.md");
        const contractBody = (doc: string | null): string | null => {
          if (doc === null) return null;
          const items = parseProofContract(doc);
          if (items === null) return null;
          const lines = doc.split("\n");
          const start = lines.findIndex((l) => PROOF_CONTRACT_HEADING_RE.test(l.trim()));
          const rest = lines.slice(start + 1);
          const end = rest.findIndex((l) => /^##\s/.test(l));
          return rest.slice(0, end === -1 ? undefined : end).join("\n");
        };
        const selection = selectProofContractBody({
          prdBody: contractBody(prdDoc),
          specBody: contractBody(specDoc),
          readmeBody: contractBody(readmeDoc),
        });
        const contractSource = selection.source;
        // KI-5.3-2 条目语法：用唯一共享的逻辑复选框语法解析所选来源，
        // 再逐项剔除脚手架占位行——与评审 composer 的 extractProofContract
        // 所做的逐项跳过一致——这样占位符+已撰写混合正文不会把 1-based
        // 证据索引平移到占位行上（那种静默的一位错位配对）。
        let contractItems = contractSource === null
          ? null
          : parseProofContract(contractSource === "prd" ? prdDoc! : contractSource === "spec" ? specDoc! : readmeDoc!);
        if (contractItems) contractItems = contractItems.filter((it) => !isScaffoldPlaceholderText(it));
        if (contractSource !== null && contractSource !== "spec") {
          advisories.push(
            `契约来源：SPEC.md 没有已撰写的 ## Proof contract——` +
              `这份 ${contractItems?.length ?? 0} 项契约派生自旧版 ${contractSource === "prd" ? "IMPLEMENTATION-PRD.md" : "README.md"}。` +
              "今后请把契约编辑改放到 SPEC.md；旧文件仍可读。",
          );
        } else if (contractSource === null) {
          advisories.push(
            "契约来源：既无已撰写的 SPEC.md proof 契约，也无可读的旧版回退——视为未声明契约。",
          );
        }
        let coveredItems: string[] = [];
        if (contractItems && contractItems.length > 0) {
          if (evidences && evidences.length > 0) {
            for (const ref of evidences) {
              const byIndex = /^\d+$/.test(ref) ? contractItems[Number.parseInt(ref, 10) - 1] : undefined;
              const byText = contractItems.find((item) => item === ref);
              const match = byText ?? byIndex;
              if (match) coveredItems.push(match);
              else warns.push(`evidences 引用 '${ref}' 不匹配任何已声明的 proof-contract 条目（已知条目：${contractItems.map((_, i) => i + 1).join(", ")} 或精确文本）`);
            }
          }
          if (coveredItems.length === 0 || !header.self_check) {
            const uncovered = contractItems.filter((item) => !coveredItems.includes(item));
            const reasons: string[] = [];
            if (coveredItems.length === 0) reasons.push("本次 drop 未覆盖任何已声明契约条目");
            if (!header.self_check) reasons.push("缺少 self_check 证明");
            advisories.push(
              `建议（D2，只建议不拦截）：${reasons.join("且")}。` +
              `未覆盖的契约条目：${uncovered.map((u) => `"${u}"`).join(", ")}。` +
              `Packet-2 的 承诺→交付 连接会把这些显示为 MISSING（▲ 证据不足信号）。`
            );
          }
        }

        // FR-11 / C8——UX slice 视频建议（SHOULD/引导，退出码 0，
        // 无任何配置能让它变拦截）。触发条件：slice frontmatter
        // ux-change: true（规范期标志；绝不是 qitem 标签，绝不是 diff 推断）。
        // 当本次 drop 是视频、或 proof/ 目录已已有一个视频时视为满足。
        const uxChange = slice.frontmatter["ux-change"] === true;
        if (uxChange) {
          const proofDir = path.join(slice.absPath, "proof");
          const existingVideo = fs.existsSync(proofDir)
            && fs.readdirSync(proofDir).some((f) => isVideoFile(f));
          const droppingVideo = (opts.file ? isVideoFile(opts.file) : false) || mediaRefs.some((r) => isVideoFile(r));
          if (!existingVideo && !droppingVideo) {
            advisories.push(
              "建议（C8，SHOULD/引导）：本 slice 标记为 UX 变更（ux-change: true），其证据集没有视频。" +
              "UX 变更 slice 应同时产出截图 + 视频——通过 agent-browser-screencast 方法录屏，" +
              "并对齐 money-shot 剪辑标准。本建议绝不拦截 drop。"
            );
          }
        }

        // 写入产物：YAML frontmatter + 正文，写进 proof/。
        const proofDir = path.join(slice.absPath, "proof");
        const defaultName = `${opts.artifactType}-${opts.verdict}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
        const fileName = opts.name ?? (opts.file ? path.basename(opts.file) : defaultName);
        // rev1-r2 BLOCKING 修复（a7dedd93 评审）：--name 是文件名，绝不是路径。
        // 在任何文件系统动作之前拒绝分隔符 / dot-dot / 绝对形态，
        // 使 drop 只能落在 proof/ 内（FR-8 契约）——像 ../README.md 这样的
        // 穿越名绝不能碰到 slice 控制文件。
        if (fileName.includes("/") || fileName.includes("\\") || fileName.startsWith("..") || path.isAbsolute(fileName)) {
          throw new ScopeCliError({
            fact: `--name '${fileName}' 不是一个普通文件名（拒绝路径分隔符、'..' 与绝对路径）。`,
            consequence: "产物未投放——proof drop 只落在 slice proof/ 目录内（FR-8）。",
            action: "传一个裸文件名，如 qa-clear.md；目录由 drop 路径自己决定。",
          });
        }
        const target = path.resolve(proofDir, fileName);
        // 纵深防御：即使某个名字逃过了形态检查，也必须解析在 proof/ 内
        // （与 scope-approve 的路径逃逸守卫同样的 containment 纪律）。
        if (!target.startsWith(path.resolve(proofDir) + path.sep)) {
          throw new ScopeCliError({
            fact: `--name '${fileName}' 解析到了 slice proof/ 目录之外。`,
            consequence: "产物未投放。",
            action: "传一个裸文件名；目录由 drop 路径自己决定。",
          });
        }
        fs.mkdirSync(proofDir, { recursive: true });
        const frontmatter = YAML.stringify(header).trimEnd();
        fs.writeFileSync(target, `---\n${frontmatter}\n---\n\n${body}`, "utf8");

        // 回显解析后的头——席位看到的就是 composer 会看到的。
        const echo = {
          dropped: path.relative(process.cwd(), target),
          header: header as C1Header,
          contractItemsDeclared: contractItems?.length ?? 0,
          contractSource,
          contractItemsCovered: coveredItems,
          mediaRefs,
          warnings: warns,
          advisories,
        };
        if (json) {
          console.log(JSON.stringify(echo, null, 2));
        } else {
          console.log(`已投放：${echo.dropped}`);
          console.log(`解析后的 C1 头：\n${frontmatter}`);
          if (contractItems) console.log(`Proof contract：本次 drop 覆盖 ${coveredItems.length}/${contractItems.length} 个条目。`);
          for (const w of warns) console.error(`警告：${w}`);
          for (const a of advisories) console.error(a);
        }
        // 建议与警告绝不改变退出码（BR-7）。
      } catch (err) {
        if (err instanceof ScopeCliError) {
          if (json) {
            console.log(JSON.stringify({ ok: false, error: { fact: err.fact, consequence: err.consequence, action: err.action } }, null, 2));
          } else {
            console.error(`${err.fact}\n${err.consequence}\n${err.action}`);
          }
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return cmd;
}
