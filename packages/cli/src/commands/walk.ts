import { randomUUID } from "node:crypto";
// Slice-03 Atom 6（rig walk）——节奏原语。"带领席位走过它"：把一系列上下文片段
// 投递进席位的窗格，按 --pace 间隔，使智能体在收到下一片前消化当前这片。
// 它自己是顶层动词（不是 `rig send` 的扩展）；推送方向，带领者主导、不等待回复——
// 间隔完成工作（SPEC-rig-context-rig-walk-composition §3）。--through 接受一个
// 上下文引用（一个包 → 其有序成员片段）或一个原始文件列表；每个片段是一次
// 对窗格的 send。

import { Command } from "commander";
import { analyzeWalkSuffix } from "../lib/walk-consumption.js";
import { existsSync, readFileSync } from "node:fs";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface RefPiecesWire {
  ref: string;
  pieces: Array<{ path: string; content: string }>;
  missingFiles?: Array<{ path: string; role?: string }>;
  error?: string;
  message?: string;
}

export interface WalkDeps extends StatusDeps {
  /** 片段间节奏延迟的测试接缝。 */
  sleep?: (ms: number) => Promise<void>;
  /** 本地文件解析的测试接缝。 */
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

const DEFAULT_PACE_MS = 10_000;

/** 解析带显式单位的 walk 时长：`10s` 或 `500ms`。格式错误返回
 *  null；undefined 时返回默认值。 */
export function parsePaceMs(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_PACE_MS;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === "ms" ? Math.round(n) : Math.round(n * 1000);
}

export interface WalkPiece {
  /** 该片的人类可读标签（文件路径或包成员路径）。 */
  label: string;
  content: string;
}

export function walkCommand(depsOverride?: WalkDeps): Command {
  const cmd = new Command("walk").description("按节奏带领席位走过一系列上下文片段");

  const getDeps = (): WalkDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<seat>", "目标会话名（例如 dev-impl@my-rig）")
    .option("--through <items...>", "一个上下文引用（包）或要带领席位走过的文件列表")
    // Test-A（row 782b467a）—— walk/profile 联结：消费权威的
    // 组合 profile（绝不手工写片段列表），并按"身份"报告已投递片段，
    // 使 profile 集合与已投递集合可精确比对。NO-COPY：发出的字节就是
    // profile 提供的字节。
    .option("--through-profile <ref>", "带领席位走过一个包的组合 PROFILE（需 --situation；片段集来自 rig context profile，绝不手工写）")
    .option("--situation <situation>", "配合 --through-profile：fresh | handover | post-compaction")
    .option("--runtime <runtime>", "配合 --through-profile：claude | codex（默认 claude）")
    .option("--profile <profile>", "配合 --through-profile：包声明的命名安装 profile")
    .option("--rig <rig>", "配合 --through-profile：席位树授权（配合 --seat）")
    .option("--seat-grant <seat>", "配合 --through-profile：其 seat: atoms 可读的席位（配合 --rig）")
    .option("--mission <mission>", "配合 --through-profile：任务目标树授权")
    .option("--slice <slice>", "配合 --through-profile：切片树授权（配合 --mission）")
    .option("--budget <tokens>", "配合 --through-profile：场景预算（仅报告，绝不截断）")
    .option("--pace <duration>", "片段间隔（例如 10s 或 500ms；必须带单位后缀）；默认 10s")
    // 机制门修复（desk 裁决 d9b3989a）：send 成功意味着"已输入"，而非"已消费"——每片
    // 在发下一片前都按"效果"对照席位的生成记录校验。
    .option("--consume-timeout <duration>", "每片消费校验窗口（例如 20s 或 500ms；必须带单位后缀）；默认 20s")
    .option("--consume-poll <duration>", "消费校验轮询间隔（例如 1500ms 或 2s；必须带单位后缀）；默认 1500ms")
    // 回合节奏（desk BLOCKING row 2ff16fa1）：发进一个开放回合的片段会被运行时排队，
    // 绝不成为一个独立用户回合——walk 会等待前一回合关闭。
    .option("--turn-timeout <duration>", "一片被消费后等待席位回合关闭的最长时间（例如 300s；必须带单位后缀）；默认 300s")
    .option("--json", "JSON 输出")
    .addHelpText("after", `
示例：
  zrig walk dev-impl@my-rig --through packs/tui-onboarding --pace 12s
  zrig walk dev-impl@my-rig --through intro.md steps.md wrapup.md --pace 10s

当生成记录可解析时，每个完整片段及其对应的 Claude 或 Codex 回合关闭
都必须在 --pace 与下一片之前出现。校验证明的是投递与回合完成，而非理解。
初始记录不可用时会显式报告为未验证投递。`)
    .action(async (seat: string, opts: { through?: string[]; throughProfile?: string; situation?: string; runtime?: string; profile?: string; rig?: string; seatGrant?: string; mission?: string; slice?: string; budget?: string; pace?: string; consumeTimeout?: string; consumePoll?: string; turnTimeout?: string; json?: boolean }) => {
      try {
        const deps = getDeps();
        const paceMs = parsePaceMs(opts.pace);
        if (paceMs === null) {
          console.error(`无效的 --pace '${opts.pace}'：请使用显式单位后缀，例如 10s 或 500ms。`);
          process.exitCode = 1;
          return;
        }
        const fileExists = deps.fileExists ?? existsSync;
        const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

        // 恰好一种输入形式：--through（文件或包引用）或
        // --through-profile（组合 profile）。混用会在任何 send 前显式拒绝。
        if (opts.through && opts.throughProfile) {
          console.error("请选择 --through 或 --through-profile，不可混用——profile 的片段集是权威，绝不手工混合。");
          process.exitCode = 1;
          return;
        }
        let profileIdentity: Array<{ atomId: string; address: string }> | null = null;
        let pieces: WalkPiece[];
        if (opts.throughProfile) {
          if (!opts.situation) {
            console.error("--through-profile 需要 --situation（fresh | handover | post-compaction）。");
            process.exitCode = 1;
            return;
          }
          const resolved = await resolveProfilePieces(deps, opts);
          pieces = resolved.pieces;
          profileIdentity = resolved.identity;
        } else if (!opts.through) {
          console.error("请提供 --through <items...> 或 --through-profile <ref>。");
          process.exitCode = 1;
          return;
        } else {
        // --through 要么是原始文件列表（每项都是存在的文件），要么是单个
        // 上下文引用（一个包 → 其有序成员片段）。混用会被拒绝。
        const items = opts.through;
        if (items.length > 0 && items.every((it) => fileExists(it))) {
          pieces = items.map((it) => ({ label: it, content: readFile(it) }));
        } else if (items.length === 1) {
          pieces = await resolveRefPieces(deps, items[0]!);
        } else {
          console.error("--through 要么接受单个上下文引用，要么接受已有文件列表（不可混用）。");
          process.exitCode = 1;
          return;
        }
        }
        if (pieces.length === 0) {
          console.error("无可走：--through 解析出零个片段。");
          process.exitCode = 1;
          return;
        }

        const client = await getClient(deps);

        // --- 按效果做消费校验（机制门修复，desk 裁决 d9b3989a）---
        // send 成功意味着"已输入"，而非"已消费"：粘贴+回车在 tmux 层成功，
        // 但目标 TUI 可能把文本停留在提示符处，后续片段会合并。
        // 效果来源是席位当前代记录（只追加的对话 JSONL）：已消费片段表现为
        // 一条完整的 user 角色消息。
        // 与 --pace 相同的显式单位时长语法（10s / 500ms）；默认 20s / 1.5s。
        const consumeTimeoutMs = opts.consumeTimeout !== undefined ? parsePaceMs(opts.consumeTimeout) : 20_000;
        const consumePollMs = opts.consumePoll !== undefined ? parsePaceMs(opts.consumePoll) : 1_500;
        const turnTimeoutMs = opts.turnTimeout !== undefined ? parsePaceMs(opts.turnTimeout) : 300_000;
        if (consumeTimeoutMs === null) {
          console.error(`无效的 --consume-timeout '${opts.consumeTimeout}'：请使用显式单位后缀，例如 20s 或 500ms。`);
          process.exitCode = 1;
          return;
        }
        if (consumePollMs === null) {
          console.error(`无效的 --consume-poll '${opts.consumePoll}'：请使用显式单位后缀，例如 1500ms 或 2s。`);
          process.exitCode = 1;
          return;
        }
        if (turnTimeoutMs === null) {
          console.error(`无效的 --turn-timeout '${opts.turnTimeout}'：请使用显式单位后缀，例如 300s 或 500ms。`);
          process.exitCode = 1;
          return;
        }
        const normalize = (s: string) => s.replace(/\s+/g, "");
        const recordPath = `/api/sessions/${encodeURIComponent(seat)}/generation-record`;

        interface RecordRead { generationId?: string; totalBytes?: number; suffix?: string; error?: string; message?: string }
        const readRecord = async (sinceBytes?: number): Promise<{ status: number; data: RecordRead }> =>
          client.get<RecordRead>(sinceBytes === undefined ? recordPath : `${recordPath}?sinceBytes=${sinceBytes}`, { headers: terminalAuthHeaders() });

        // 一次走前记录探测决定模式。无记录（不支持的运行时 / 无 sidecar /
        // 后台服务无此路由）→ 带命名提示的旧版投递：未验证要明示，绝不静默。
        let preProbe: { status: number; data: RecordRead };
        try {
          preProbe = await readRecord();
        } catch (err) {
          preProbe = { status: 0, data: { message: `生成记录探测失败：${(err as Error).message}` } };
        }
        const verifiable = preProbe.status === 200 && typeof preProbe.data.generationId === "string";
        if (!verifiable) {
          console.error(`walk：${seat} 的消费未验证 —— ${preProbe.data.message ?? preProbe.data.error ?? `生成记录不可用（HTTP ${preProbe.status}）`}。片段将在不做逐片效果校验的情况下投递。`);
        }

        const failPiece = (i: number, label: string, why: string): void => {
          console.error(`walk 在第 ${i + 1}/${pieces.length} 片（${label}）中止：${why}`);
          if (profileIdentity) {
            console.log(JSON.stringify({ seat, delivered: profileIdentity.slice(0, i), expected: profileIdentity, aborted: profileIdentity[i] }));
          }
          process.exitCode = 1;
        };

        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!;
          const head = normalize(piece.content).slice(0, 64); // 仅暂存提示，绝不当作回执证据

          let preLen = 0;
          let preGen: string | undefined;
          if (verifiable) {
            const pre = await readRecord();
            if (pre.status !== 200 || typeof pre.data.generationId !== "string") {
              failPiece(i, piece.label, `发送前席位的生成记录变得不可读（${pre.data.message ?? pre.data.error ?? `HTTP ${pre.status}`}）。`);
              return;
            }
            if (pre.data.generationId !== preProbe.data.generationId) {
              failPiece(i, piece.label, "片段之间席位的生成已改变；拒绝把本次 walk 继续进另一个生成。");
              return;
            }
            preGen = pre.data.generationId;
            preLen = pre.data.totalBytes ?? 0;
          }

          // 真正的 send。抛出的客户端错误（超时）还不算失败——后台服务可能已在
          // 服务端完成；下面按效果对账，绝不重发（fleet 台账的规则，产品化）。
          // 确定性的 4xx/5xx 仍中止——除了 submit_failed，它恰好就是已暂存文本状态，
          // 走单次回车重试路径。
          let sendOutcome: "ok" | "staged-suspect" | { hardError: string } ;
          try {
            const res = await client.post<Record<string, unknown>>("/api/transport/send", {
              session: seat,
              text: piece.content,
              deliveryId: randomUUID(),
            }, { headers: terminalAuthHeaders() });
            if (res.data?.["outcome"] === "retained") {
              failPiece(i, piece.label, `已保留、未投递（${JSON.stringify(res.data["outboxIds"])}）；未再发送后续片段。用 zrig seat held-messages ${seat} 查看。`);
              return;
            }
            if (res.status >= 400) {
              if (res.data?.["reason"] === "submit_failed") sendOutcome = "staged-suspect";
              else {
                failPiece(i, piece.label, (res.data?.["error"] as string | undefined) ?? `HTTP ${res.status}`);
                return;
              }
            } else sendOutcome = "ok";
          } catch (err) {
            if (!verifiable) {
              failPiece(i, piece.label, `传输错误且无法按效果对账（无生成记录）：${(err as Error).message}`);
              return;
            }
            console.error(`walk：第 ${i + 1}/${pieces.length} 片传输错误（${(err as Error).message}）——按效果对账，不重发。`);
            sendOutcome = "staged-suspect";
          }

          if (verifiable) {
            const pollConsumed = async (): Promise<"consumed" | "generation-rolled" | "timeout"> => {
              const deadline = Date.now() + consumeTimeoutMs;
              for (;;) {
                const rec = await readRecord(preLen);
                if (rec.status !== 200) throw new Error(`生成记录变得不可用：${rec.data.message ?? rec.data.error ?? rec.status}。消费未验证。`);
                if (rec.status === 200 && typeof rec.data.generationId === "string") {
                  if (rec.data.generationId !== preGen) return "generation-rolled";
                  if ((rec.data.totalBytes ?? -1) < preLen) return "generation-rolled";
                  if (analyzeWalkSuffix(rec.data.suffix ?? "", piece.content).consumed) return "consumed";
                }
                if (Date.now() >= deadline) return "timeout";
                await sleep(consumePollMs);
              }
            };

            let verdict = await pollConsumed();
            if (verdict === "generation-rolled") {
              failPiece(i, piece.label, "walk 中途席位生成发生滚动（重新 prime）；walk 无法进入另一个生成。");
              return;
            }
            if (verdict === "timeout") {
              // 窗口内未消费。是否已暂存？——一次捕获判定；已暂存则只做恰好一次
              // submit 重试（受控的裸回车），再给一个校验窗口，然后大声报错。
              const cap = await client.post<Record<string, unknown>>("/api/transport/capture", { session: seat, lines: 50 }, { headers: terminalAuthHeaders() });
              const pane = (cap.data?.["content"] as string | undefined) ?? "";
              // 暂存证据：该片自己的开头（短粘贴内联渲染、截断）或 TUI 的
              // 粘贴占位符（大粘贴渲染为 "[Pasted text #N +X lines]"，绝不显示内容——
              // 真实样本的形态）。
              const stagedEvidence = cap.status === 200 && (
                normalize(pane).includes(head.slice(0, 24)) ||
                /\[Pasted text #\d+ \+\d+ lines\]/.test(pane)
              );
              if (stagedEvidence) {
                const enter = await client.post<Record<string, unknown>>("/api/transport/send", {
                  session: seat,
                  submitOnly: true,
                  expectedStagedText: piece.content, // 全量字节——传输层检查渲染出的字面残留是否连续包含
                  expectedStagedLineCount: piece.content.split("\n").length,
                }, { headers: terminalAuthHeaders() });
                if (enter.status >= 400) {
                  failPiece(i, piece.label, `已输入但未消费；单次 submit 重试被拒（${(enter.data?.["error"] as string | undefined) ?? `HTTP ${enter.status}`}）。`);
                  return;
                }
                verdict = await pollConsumed();
                if (verdict !== "consumed") {
                  failPiece(i, piece.label, `已输入并暂存，但即使单次 submit 重试后仍未消费——该片从未进入席位的对话记录。不重发（一次重试是约定）。`);
                  return;
                }
              } else {
                failPiece(i, piece.label, `send 报告${sendOutcome === "ok" ? "成功" : "传输错误"}，但该片既未在生成记录中消费、也未在窗格中暂存——投递丢失；本次 walk 的消费校验以失败告终。`);
                return;
              }
            }
          }

          // 等待匹配的原生回合，包括最后一片。仅凭回执绝不能把下一片
          // 发进一个开放回合，也不能据此认证一次完成的 walk。
          if (verifiable) {
            const turnDeadline = Date.now() + turnTimeoutMs;
            for (;;) {
              const rec = await readRecord(preLen);
              if (rec.status !== 200) {
                failPiece(i, piece.label, `等待回合关闭期间生成记录变得不可用：${rec.data.message ?? rec.data.error ?? rec.status}。`);
                return;
              }
              if (rec.status === 200 && typeof rec.data.generationId === "string") {
                if (rec.data.generationId !== preGen || (rec.data.totalBytes ?? -1) < preLen) {
                  failPiece(i, piece.label, "等待回合关闭期间席位的生成发生滚动。");
                  return;
                }
                if (analyzeWalkSuffix(rec.data.suffix ?? "", piece.content).turnClosed) break;
              }
              if (Date.now() >= turnDeadline) {
                failPiece(i, piece.label, `已消费，但席位回合在 ${turnTimeoutMs}ms 内未关闭——拒绝把下一片发进开放回合（它会被排队，绝不成为独立用户回合）。`);
                return;
              }
              await sleep(consumePollMs);
            }
          }

          if (!opts.json) console.log(`[${i + 1}/${pieces.length}] ${verifiable ? "已消费" : "已发送"} ${piece.label} → ${seat}`);
          // 只在片段之间节奏——最后一片后绝不拖尾停顿。
          if (i < pieces.length - 1) await sleep(paceMs);
        }
        if (opts.json) {
          console.log(JSON.stringify(profileIdentity
            ? { seat, delivered: profileIdentity, paceMs, consumptionVerified: verifiable }
            : { seat, pieces: pieces.length, paceMs, consumptionVerified: verifiable }));
        } else {
          console.log(`已带领 ${seat} 走过 ${pieces.length} 个片段${verifiable ? "，每片均按效果校验消费" : "（消费未验证——无生成记录）"}。`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;

  async function getClient(deps: WalkDeps): Promise<DaemonClient> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b：通过同一个助手给出与认知状态匹配的措辞（宕 ≠ 忙）。
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveProfilePieces(
    deps: WalkDeps,
    opts: { throughProfile?: string; situation?: string; runtime?: string; profile?: string; rig?: string; seatGrant?: string; mission?: string; slice?: string; budget?: string },
  ): Promise<{ pieces: WalkPiece[]; identity: Array<{ atomId: string; address: string }> }> {
    const client = await getClient(deps);
    const params = new URLSearchParams({ ref: opts.throughProfile!, situation: opts.situation!, runtime: opts.runtime ?? "claude" });
    if (opts.profile !== undefined) params.set("profile", opts.profile);
    if (opts.rig !== undefined) params.set("rig", opts.rig);
    if (opts.seatGrant !== undefined) params.set("seat", opts.seatGrant);
    if (opts.mission !== undefined) params.set("mission", opts.mission);
    if (opts.slice !== undefined) params.set("slice", opts.slice);
    if (opts.budget !== undefined) params.set("budget", opts.budget);
    const res = await client.get<{
      pieces?: Array<{ atomId: string; address: string; text: string }>;
      message?: string; error?: string;
    }>(`/api/context-packs/library/by-ref/profile?${params.toString()}`);
    if (res.status !== 200) {
      throw new Error(res.data?.message ?? res.data?.error ?? `后台服务组合 profile 时返回 HTTP ${res.status}。`);
    }
    const profilePieces = res.data.pieces ?? [];
    return {
      // NO-COPY：内容就是提供的文本，逐字节；标签携带身份，
      // 便于中止时点名 atom。
      pieces: profilePieces.map((p) => ({ label: `${p.atomId}（${p.address}）`, content: p.text })),
      identity: profilePieces.map((p) => ({ atomId: p.atomId, address: p.address })),
    };
  }

  async function resolveRefPieces(deps: WalkDeps, ref: string): Promise<WalkPiece[]> {
    const client = await getClient(deps);
    const res = await client.get<RefPiecesWire>(`/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) {
      throw new Error(`库中未找到上下文包 '${ref}'。运行 'rig context list' 查看可用引用。`);
    }
    if (res.status === 400) {
      throw new Error(res.data?.message ?? `不安全的上下文引用 '${ref}'。`);
    }
    if (res.status !== 200) {
      throw new Error(`后台服务解析引用 '${ref}' 时返回 HTTP ${res.status}。`);
    }
    // 两种输入形式共用同一条中止约定：缺失/不可读的成员是预先知道的
    // （在首次 send 前在此报告），因此——和缺失本地 --through 文件完全一样——
    // 它在任何 send 前中止 walk。不做部分 walk；操作者修好包后重跑。
    const missing = res.data.missingFiles ?? [];
    if (missing.length > 0) {
      throw new Error(
        `上下文包 '${ref}' 有 ${missing.length} 个缺失/不可读成员：${missing.map((m) => m.path).join(", ")}。` +
          `walk 要么投递全部成员，要么一个都不投递——请修好该包（或其文件）后重跑。未发送任何内容。`,
      );
    }
    return (res.data.pieces ?? []).map((p) => ({ label: `${ref}:${p.path}`, content: p.content }));
  }
}
