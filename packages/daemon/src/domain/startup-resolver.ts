import type { StartupBlock, StartupFile, StartupAction, StartupProofSelection } from "./types.js";
import { validateStartupAction } from "./startup-validation.js";

export interface StartupLayerInputs {
  specStartup: StartupBlock;
  profileStartup?: StartupBlock;
  rigCultureFile?: string;
  rigStartup?: StartupBlock;
  podStartup?: StartupBlock;
  memberStartup?: StartupBlock;
  operatorStartup?: StartupBlock;
}

/**
 * 按固定的叠加顺序构建有效启动内容：
 * 1. 智能体基础启动内容
 * 2. Profile 启动内容
 * 3. 工作组 culture 文件（合成 StartupFile）
 * 4. 工作组启动 overlay
 * 5. Pod 共享启动内容
 * 6. Member 启动 overlay
 * 7. 操作者调试追加内容（始终最后）
 *
 * 文件与 action 按顺序连接，不做去重；adapter 按启动契约处理重放容忍。
 *
 * @param inputs - 全部启动来源
 * @returns 合并后的 StartupBlock
 */
export function resolveStartup(inputs: StartupLayerInputs): StartupBlock {
  const files: StartupFile[] = [];
  const actions: StartupAction[] = [];

  // 1. 智能体基础启动内容
  appendBlock(inputs.specStartup, files, actions);

  // 2. Profile 启动内容
  if (inputs.profileStartup) {
    appendBlock(inputs.profileStartup, files, actions);
  }

  // 3. 工作组 culture 文件（合成文件项）
  if (inputs.rigCultureFile) {
    files.push({
      path: inputs.rigCultureFile,
      deliveryHint: "auto",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    });
  }

  // 4. 工作组启动 overlay
  if (inputs.rigStartup) {
    appendBlock(inputs.rigStartup, files, actions);
  }

  // 5. Pod 共享启动内容
  if (inputs.podStartup) {
    appendBlock(inputs.podStartup, files, actions);
  }

  // 6. Member 启动 overlay
  if (inputs.memberStartup) {
    appendBlock(inputs.memberStartup, files, actions);
  }

  // 7. 操作者调试追加内容（始终最后）
  if (inputs.operatorStartup) {
    appendBlock(inputs.operatorStartup, files, actions);
  }

  return { files, actions };
}

function appendBlock(block: StartupBlock, files: StartupFile[], actions: StartupAction[]): void {
  files.push(...block.files);
  actions.push(...block.actions);
}

/** 最后一个适用的作者声明选择生效；省略时不增加练习。 */
export function resolveStartupProof(
  actions: StartupAction[],
  context: "fresh_start" | "restore",
): StartupProofSelection {
  let selection: StartupProofSelection = { mode: "none", source: "default" };
  for (const [actionIndex, action] of actions.entries()) {
    if (action.type !== "startup_proof") continue;
    // 持久化/直接输入必须遵循与作者 YAML 相同的契约，包括被覆盖和不适用的声明。
    const errors = validateStartupAction({ ...action, applies_on: action.appliesOn }, actionIndex, "startup.");
    if (errors.length) throw new Error(errors.join("; "));
    if (action.appliesOn.includes(context)) {
      selection = { mode: action.value as StartupProofSelection["mode"], source: "authored", actionIndex };
    }
  }
  return selection;
}
