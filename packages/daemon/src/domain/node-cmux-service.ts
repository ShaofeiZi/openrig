import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { CmuxAdapter, CmuxResult } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export type OpenCmuxAction = "focused_existing" | "created_new" | "created_helper";

export interface OpenCmuxResult {
  ok: boolean;
  action?: OpenCmuxAction;
  error?: string;
  code?: string;
}

export class NodeCmuxService {
  private tmuxAdapter: TmuxAdapter | null;
  constructor(
    private rigRepo: RigRepository,
    private sessionRegistry: SessionRegistry,
    private cmuxAdapter: CmuxAdapter,
    tmuxAdapter?: TmuxAdapter,
  ) {
    this.tmuxAdapter = tmuxAdapter ?? null;
  }

  async openOrFocusNodeSurface(rigId: string, logicalId: string): Promise<OpenCmuxResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, error: "未找到工作组", code: "not_found" };

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) return { ok: false, error: "未找到节点", code: "not_found" };

    const binding = node.binding;

    // 对 tmux 后端节点，在创建或聚焦任何 surface 之前先检查存活状态。
    const isTmux = binding?.attachmentType === "tmux" && binding?.tmuxSession;
    if (isTmux && this.tmuxAdapter) {
      const alive = await this.tmuxAdapter.hasSession(binding.tmuxSession!);
      if (!alive) {
        return { ok: false, error: `tmux 会话 '${binding.tmuxSession}' 未存活，无法附加`, code: "session_not_found" };
      }
    }

    // 已绑定 surface 时优先聚焦既有 surface。
    if (binding?.cmuxSurface) {
      const result = await this.cmuxAdapter.focusSurface(binding.cmuxSurface, binding.cmuxWorkspace ?? undefined);
      if (result.ok) return { ok: true, action: "focused_existing" };
      if (result.code === "unavailable") {
        return { ok: false, error: result.message, code: result.code };
      }
    }

    return this.createAndBindSurface(node.id, logicalId, binding);
  }

  private async createAndBindSurface(
    nodeId: string,
    logicalId: string,
    binding: {
      attachmentType?: string | null;
      tmuxSession?: string | null;
      externalSessionName?: string | null;
    } | null | undefined,
  ): Promise<OpenCmuxResult> {

    // 为新 surface 解析工作区锚点。OPR.0.4.1.31 part A：过去 node open-in-cmux 只依赖
    // currentWorkspace()，因此 cmux 没有当前工作区时，每个未绑定行都会在 node-specific attach 前失败
    //（只有工作组级 Launch-in-CMUX 会创建工作区）。现在先使用当前工作区；不存在时选择既有工作区；
    // 再不存在则创建并选择一个，确保 surface 落在可见工作区中。
    const wsResult = await this.resolveWorkspaceAnchor();
    if (!wsResult.ok) return { ok: false, error: wsResult.message, code: wsResult.code };

    // 创建新的 terminal surface。
    const createResult = await this.cmuxAdapter.createTerminalSurface(wsResult.data);
    if (!createResult.ok) return { ok: false, error: createResult.message, code: createResult.code };

    const newSurfaceId = createResult.data;

    // 会话名优先取自 binding，否则使用 logical ID。
    const sessionName = binding?.tmuxSession ?? binding?.externalSessionName ?? logicalId;

    // tmux 后端：附加到 tmux；存活状态已在 openOrFocusNodeSurface 中检查。等 attach + focus 成功后
    // 才持久化 binding，避免 attach 失败后留下陈旧 cmuxSurface，导致重试时把它当作
    // focused_existing 聚焦却未重新附加。
    const isTmux = binding?.attachmentType === "tmux" && binding?.tmuxSession;
    if (isTmux) {
      const sendResult = await this.cmuxAdapter.sendText(newSurfaceId, `tmux attach -t ${binding.tmuxSession}\n`, wsResult.data);
      if (!sendResult.ok) return { ok: false, error: sendResult.message, code: sendResult.code };
      const focusResult = await this.cmuxAdapter.focusSurface(newSurfaceId, wsResult.data);
      if (!focusResult.ok) return { ok: false, error: focusResult.message, code: focusResult.code };
      this.sessionRegistry.updateBinding(nodeId, {
        cmuxWorkspace: wsResult.data,
        cmuxSurface: newSurfaceId,
      });
      return { ok: true, action: "created_new" };
    }

    // External CLI / 无 tmux：提供诚实的辅助控制台。与 tmux 路径相同，等辅助文本发送并聚焦成功后
    // 才持久化 binding。
    const helperText = [
      `# ${sessionName} 的辅助控制台`,
      `# 此节点通过外部方式附加，没有可直接使用的 terminal 会话。`,
      `# 常用命令：`,
      `zrig capture ${sessionName}`,
      `zrig transcript ${sessionName} --tail 100`,
      `zrig send ${sessionName} "..." --verify`,
    ].join("\n");
    const sendResult = await this.cmuxAdapter.sendText(newSurfaceId, helperText, wsResult.data);
    if (!sendResult.ok) return { ok: false, error: sendResult.message, code: sendResult.code };
    const focusResult = await this.cmuxAdapter.focusSurface(newSurfaceId, wsResult.data);
    if (!focusResult.ok) return { ok: false, error: focusResult.message, code: focusResult.code };
    this.sessionRegistry.updateBinding(nodeId, {
      cmuxWorkspace: wsResult.data,
      cmuxSurface: newSurfaceId,
    });
    return { ok: true, action: "created_helper" };
  }

  // OPR.0.4.1.31 part A——解析用于承载新 surface 的工作区。
  // (1) cmux 有当前工作区时直接使用。(2) cmux 不可达时如实传播错误，因为无法解析锚点。
  // (3) cmux 已打开但没有当前工作区时创建一个；cmux 会把新工作区设为 active/visible
  //（`cmux <path>` / new-workspace 模型），随后创建的 surface 会落在操作员正在查看的位置。
  //
  // 有意只使用 transport allowlist 中且经过二进制验证的方法
  //（workspace.current + workspace.create）。不调用 workspace.select：cmux CLI 未提供
  // select-workspace 命令，cmux transport 也未允许该 RPC，真实路径调用会抛错（dev1-guard B1）。
  // 官方 socket API 虽列出 workspace.select，但只有外部文档还不够，集成界面必须实际公开它。
  // create 失败时如实呈现错误；操作员可改用工作组级 Launch-in-CMUX。
  private async resolveWorkspaceAnchor(): Promise<CmuxResult<string>> {
    const current = await this.cmuxAdapter.currentWorkspace();
    if (current.ok) return current;
    if (current.code === "unavailable") return current;
    return this.cmuxAdapter.createWorkspace("zrig");
  }
}
