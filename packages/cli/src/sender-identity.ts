import { readOpenRigEnv } from "./openrig-compat.js";

/**
 * CLI 调度所归属的席位身份——与 DaemonClient 盖在 `X-OpenRig-Session` 上的值
 * 完全相同（P18 检查点），后台服务从中派生 actor / 渲染出的 `From:`。
 * `--from` 已弃用并被忽略：来源是席位环境变量，绝不是调用方在请求体中声称的值。
 * 当席位无法解析时返回 `undefined`——调用方随后以 `SENDER_FALLBACK` 投递并标注
 * （绝不拒绝，绝不伪造 actor）。
 */
export function resolveSenderSession(): string | undefined {
  return readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
}

/**
 * 无法归属的 CLI 调度使用的无会话回退标记。P18（删除原子操作）反转了 A1 的
 * 席位边界拒绝策略：没有环境变量的 `rig send`/`broadcast` 现在携带这个诚实标签投递，
 * 而不是拒绝，因为后台服务对半投递并标注了缺少请求头的写入（下游不会返回 401）——
 * 未经验证的标注为未知，绝不洗白为已验证。
 *
 * 这是该字面量的两个命名孪生定义点之一；另一个是后台服务的
 * `pane-envelope.ts::SENDER_FALLBACK`（其字节一致的 `wrapPaneEnvelope` 孪生）。
 * `send.ts`（`wrapSendBody`）和 `broadcast.ts`（信封扇出标记）都导入这同一个 CLI 来源，
 * 而非重新声明——因此 CLI 中没有散落的回退值。src 中任何第三处字面量定义都会被
 * `send.test.ts` 的规范性守卫按名字捕获。
 */
export const SENDER_FALLBACK = "<unknown sender>";
