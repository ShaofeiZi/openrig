import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";

/** 快照刻意保持精简且不含实际值：凭据、账号标识、消息正文和连接器响应
 * 永远不会进入生命周期台账。 */
export interface ChannelState {
  enabled?: boolean;
  active?: boolean;
  digest?: string;
  ready?: boolean | null;
}

export interface ChannelActor {
  actor: string;
  provenance: "transport:v1" | "claimed:v1" | "origin-unknown:v1";
  reason: string;
}

export interface ChannelOperation extends ChannelActor {
  id: string;
  at: string;
  action: "enable" | "disable" | "configure" | "verify" | "binding";
  subject: string;
  before: ChannelState;
  after: ChannelState | null;
  effect: "started" | "applied" | "no-op" | "observed" | "failed";
}

export function channelStateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 即使在操作生效后、完成回执写入前崩溃，开始回执仍会保留。
 * 若开始回执写入失败，则必须在产生副作用前拒绝操作；未完成绝不能算作成功。 */
export async function runChannelOperation<T>(input: ChannelActor & {
  action: ChannelOperation["action"];
  subject: string;
  before: ChannelState;
  run: () => Promise<{ value: T; after: ChannelState; effect: "applied" | "no-op" | "observed" }>;
}, home = getOpenRigHome()): Promise<{ value: T; receipt: ChannelOperation }> {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error("通道操作必须提供操作者和原因");
  const dir = join(home, "state");
  const file = join(dir, "human-channel-operations.jsonl");
  mkdirSync(dir, { recursive: true });
  const base = {
    id: randomUUID(), actor: input.actor, provenance: input.provenance,
    reason: input.reason, action: input.action, subject: input.subject, before: input.before,
  };
  const append = (after: ChannelState | null, effect: ChannelOperation["effect"]): ChannelOperation => {
    const receipt = { ...base, at: new Date().toISOString(), after, effect };
    appendFileSync(file, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    return receipt;
  };
  append(null, "started");
  try {
    const result = await input.run();
    return { value: result.value, receipt: append(result.after, result.effect) };
  } catch (error) {
    append(null, "failed");
    throw error;
  }
}
