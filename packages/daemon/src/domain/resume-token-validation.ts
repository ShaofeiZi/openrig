// OPR.0.4.0.22 FR-2——逐运行时 resume-token 校验。
// OPR.0.4.6.PI1 FR-6——按 RESUME TYPE 校验：ID 形 token（claude/codex）保持原规则不变；
// pi_session_file 是 PATH 形 token（绝对 session-file 路径），有自己的最低要求。
//
// 最低要求是 FORMAT 校验：拒绝格式错误的输入，绝不虚构 token，也绝不在错误消息中引用原始 token
//（它属于 credential 类；redaction 契约覆盖 CLI 输出、路由响应、路由错误、日志和 audit event）。
// 深度探测“是否确实可 resume”有意不在范围内，因为开销大且不得修改实时状态；格式校验是安全、
// 无副作用的最低保障。

export type ResumeType = "claude_id" | "codex_id" | "pi_session_file";

export interface ResumeTokenValidationOk {
  ok: true;
  resumeType: ResumeType;
  /** 要持久化的 trim 后 token；内部值，绝不记录或回显。 */
  token: string;
}
export interface ResumeTokenValidationErr {
  ok: false;
  /** 描述 FORMAT 问题；绝不包含 token 值。 */
  error: string;
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TOKEN_LEN = 200;

// pi_session_file 最低要求：必须是绝对路径，不含 `..` segment（在原始 operand 上检查；normalization
// 会折叠 `..`，因此 normalize 后检查会成为死代码；姿态与已交付 `zrig file` traversal guard 相同）；
// 使用 shell-inert 路径字符集；长度上限 1024；要求 Pi session-file suffix。若 Pi 日后重命名
// session format，只需修改一个常量。
//
// 字符集中有意包含 `@`（与 PRD 字面值 [A-Za-z0-9._/-] 的差异由 VM hermetic run 发现）：
// Pi 席位状态布局以 canonical 会话名（pod-member@rig）为 key，因此每条真实 Pi session-file 路径
// 都含 `@`。此处它对 shell 无害，因为 token 始终通过 argv/shellQuote 传入，绝不会成为远程
// scp/rsync operand，不涉及 user@host 解析；`zrig file` 正因该歧义排除它，而本界面没有这种解析。
const PI_SESSION_FILE_CHARSET_RE = /^[A-Za-z0-9._/@-]+$/;
const MAX_PI_SESSION_FILE_LEN = 1024;
const PI_SESSION_FILE_SUFFIX = ".jsonl";

/** 运行时对应的 resume ID 类型；运行时没有 resume token（terminal / unknown）时为 null。 */
export function resumeTypeForRuntime(runtime: string | null): ResumeType | null {
  if (runtime === "claude-code") return "claude_id";
  if (runtime === "codex") return "codex_id";
  if (runtime === "pi") return "pi_session_file";
  return null;
}

function validateIdShapedToken(resumeType: ResumeType, token: string): ResumeTokenValidationOk | ResumeTokenValidationErr {
  if (token.length > MAX_TOKEN_LEN) {
    return { ok: false, error: `Resume token 过长（最多 ${MAX_TOKEN_LEN} 个字符）。` };
  }
  if (!SAFE_TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: "Resume token 包含不允许的字符（允许：字母、数字、'.'、'_'、'-'）。",
    };
  }
  return { ok: true, resumeType, token };
}

function validatePiSessionFileToken(token: string): ResumeTokenValidationOk | ResumeTokenValidationErr {
  if (token.length > MAX_PI_SESSION_FILE_LEN) {
    return { ok: false, error: `Pi session-file token 过长（最多 ${MAX_PI_SESSION_FILE_LEN} 个字符）。` };
  }
  if (!token.startsWith("/")) {
    return { ok: false, error: "Pi session-file token 必须是以 '/' 开头的绝对路径。" };
  }
  if (token.split("/").includes("..")) {
    return { ok: false, error: "Pi session-file token 不得包含 '..' 路径段。" };
  }
  if (!PI_SESSION_FILE_CHARSET_RE.test(token)) {
    return {
      ok: false,
      error: "Pi session-file token 包含不允许的字符（允许：字母、数字、'.'、'_'、'/'、'@'、'-'）。",
    };
  }
  if (!token.endsWith(PI_SESSION_FILE_SUFFIX)) {
    return { ok: false, error: `Pi session-file token 必须以 '${PI_SESSION_FILE_SUFFIX}' 结尾。` };
  }
  return { ok: true, resumeType: "pi_session_file", token };
}

export function validateResumeToken(
  runtime: string | null,
  rawToken: unknown,
): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const resumeType = resumeTypeForRuntime(runtime);
  if (!resumeType) {
    return {
      ok: false,
      error: `runtime "${runtime ?? "unknown"}" 不支持 set-resume-token（只有 claude-code、codex 和 pi 使用 resume token）。`,
    };
  }
  if (typeof rawToken !== "string") {
    return { ok: false, error: "Resume token 缺失或不是字符串。" };
  }
  const token = rawToken.trim();
  if (token.length === 0) {
    return { ok: false, error: "Resume token 为空。" };
  }
  if (resumeType === "pi_session_file") {
    return validatePiSessionFileToken(token);
  }
  return validateIdShapedToken(resumeType, token);
}
