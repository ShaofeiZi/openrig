// 安全核心命令语法（§4.B / FR-1）：:section 跳转 · /text 过滤 ·
// <resource> <name> 钻取 · spec-of / running 交叉导航。k9s 风格分类法。
// parseCommand 是纯文本 -> 动作；目标存在性由 dispatch 验证，
// 因此所有输入适配器共享同一失败面。
// 补全从注册表提议文本；复合命令解析不在范围内。
//
// REGISTRY I1（裁决 64f1dbdf）：动词表从唯一命令注册表（commands/registry.ts）派生——
// 未注册的动词无法解析，因此未文档化的动作在构造上不可能发生。前缀形式（`:`、`/`）
// 是已注册的前缀条目，在此处结构性解析。
import { SECTION_REGISTRY } from "./sections.js";
import { VERB_TABLE, unknownCommandMessage } from "./commands/registry.js";
import type { Action, SectionDef } from "./types.js";

export function parseCommand(raw: string, sections: readonly SectionDef[] = SECTION_REGISTRY): Action {
  const input = raw.trim();
  if (input === "") return { type: "noop" };

  if (input.startsWith(":")) {
    const section = input.slice(1).trim();
    const names = sections.map((entry) => entry.name);
    if (names.includes(section)) return { type: "jump", section };
    return {
      type: "error",
      message: `未知分区 ":${section}" — 已知：${names.map((s) => ":" + s).join(" ")}`,
    };
  }

  if (input.startsWith("/")) {
    return { type: "filter", text: input.slice(1).trim() };
  }

  const [verb = "", ...rest] = input.split(/\s+/);
  const name = rest.join(" ");

  const entry = VERB_TABLE.get(verb);
  if (entry?.build) return entry.build(name, { sections });

  return { type: "error", message: unknownCommandMessage(verb) };
}
