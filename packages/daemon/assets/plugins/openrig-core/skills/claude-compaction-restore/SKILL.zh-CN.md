---
name: claude-compaction-restore
description: 当 Claude Code 会话刚完成压缩、即将压缩、达到上下文上限、在 /compact 后恢复，或需要根据 Claude JSONL 转录与曾改动文件重建工作心智模型时使用。
metadata:
  openrig:
    sibling_skills:
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# Claude 压缩恢复

使用此 skill 在 Claude Code 压缩前保持连续性，并在压缩后恢复连续性。遵循活动恢复请求或已配置的连续性策略。hook 通知只会指出可用证据，其本身并不构成席位恢复请求。

## 如果即将压缩

在跨越上下文边界前准备持久的连续性信息。

1. 确认活动任务、队列项、mission/slice、分支或 commit，以及当前工作目录。
2. 记录当前状态：已作决策、已改文件、已运行命令/测试、已生成证据、阻塞项、注意事项和下一个具体步骤。
3. 创建或更新持久的心智模型恢复地图。未来的你会主要依靠这份制品在压缩后重建上下文。
4. 在恢复地图中，以 ASCII 文件/目录树列出本次会话中对工作心智模型重要的每一条路径，包括：
   - 活动队列项或任务目标工作包；
   - 任务目标说明、进度、决策和证据文件；
   - 使用或编写过的 Claude memory/项目说明，尤其是 memory 目录由多个智能体共享时；
   - 有活动编辑或最近检查过的源文件；
   - `AGENTS.md`、`CLAUDE.md`、`README.md` 等根级说明；
   - 在代码/评审工作前需要阅读的 as-built 文档、codemap、约定、skills 和产品文档；
   - 塑造当前状态的源文件、测试、脚本、UI 证据、截图、日志或报告。
5. 对树中的每个文件或目录添加简短说明，解释其重要性，以及压缩后是否必须阅读。
6. 将尚未写入磁盘的重要衔接上下文写入 handoff/restore map，包括假设、阶段性结论、失败路径，以及所列文件为何相互关联。
7. 在压缩摘要中包含恢复地图路径，以及地图中最重要的必读路径。

## 如果刚完成压缩

依赖记忆中的任务状态前，先从当前会话的证据中恢复。

1. 检查恢复请求及任何具名 marker、packet、transcript、restore map 或附加说明文件。将记录的 seat/session/transcript 身份与当前请求对照，并确认所引用 packet 可读取。仅有 marker 路径不能证明 packet 可用；不要替换为其他席位的 packet，也不要只因某个 packet 最新就选择它。
2. **packet 可用时使用现有 packet。**读取其中的 `restore-instructions.md`、`touched-files.md` 和任何具名恢复地图。已经为当前会话准备的 packet 不会仅因发生压缩就需要重建。
3. **packet 缺失或不可用时回退。**记录缺失或不匹配内容。解析此 skill 的安装目录，使用匹配的 Claude JSONL 转录和独立输出目录运行 `scripts/restore-from-jsonl.mjs`。如果 skill 安装在全局 Claude skill 根目录：

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs /path/to/session.jsonl --out /tmp/claude-compaction-restore
```

   如果没有指定 transcript，先识别当前会话的 transcript。脚本可以根据工作目录发现 transcript，但依赖其结果前应检查选择是否正确。如果无法识别会话，应报告缺少的输入，而不是从无关对话中重建。读取生成的 `restore-instructions.md` 和 `touched-files.md`。
4. 决定阅读量前，检查实际 packet 和 transcript 大小。生成的说明会报告预计 token 成本。明确阅读预算和停止规则，给后续任务保留空间。对于大型 transcript，先读最近、与任务相关且不重复的叙述；只有特定缺失决策或依赖要求时，才读更早内容。报告实际读取范围，不要把选定预算当作已完成覆盖。
5. 使用恢复地图和 touched-file 列表识别当前任务文件。列表是分流工具，不是详尽清单。优先处理地图中指定的活动 queue/mission packet、决策与 memory、有活动编辑的文件、根级说明，以及相关 as-built 文档或 codemap。在已声明预算内完整阅读必需任务文件，并记录所有剩余缺口。
6. 根据当前 project、mission 和 seat 文件，重新建立任务目的与运行上下文。仅有 transcript 摘要不能确立当前工作范围或义务。在 zrig 内运行时，使用随附的 `refocusing` skill 获取只包含路径的 topology/work trace。
7. 报告下方阅读深度审计。所需上下文恢复后，使用 packet 请求的确认文本，通常为：

```text
restored from packet at <path>; resumed at step <X>
```

   包含实际全文阅读的主要文件。如果关键上下文仍缺失，应报告部分恢复及下一项恢复操作，而不是声称完成。

打包随附的 PreCompact writer 可以准备 packet 和逐席位 pending marker；restore bridge 可以为匹配会话投递一次指针。应检查这些实际制品。制品的创建或投递不能证明 provider 已恢复上下文、文件已被阅读，或任务理解已经恢复。

## 必需的阅读深度审计

第一次恢复后，继续工作前先审计自己。

1. 列出恢复过程中要求阅读的每个 file、packet、marker、restore map、instruction file 和 source document。
2. 将每项标为 `FULL`、`PARTIAL` 或 `NOT_READ`。
3. 根据实际恢复请求和活动任务，区分关键的当前任务上下文与补充历史。
4. 全文阅读 `PARTIAL`/`NOT_READ` 项——但必须遵循**已声明的预算和停止规则**，而不是无限制阅读。按与活动任务的相关程度排序；大型 transcript 先读最近、不重复的叙述（见“如果刚完成压缩”），不要从头到尾机械读取。
5. 当所有任务相关项目都达到 `FULL`，或预算用尽时，必须**停止**——如果恢复过程不为原本要执行的工作留出空间，就不算成功恢复。“读完所有内容，绝不节省”没有终止条件；这种开放性才是问题，而不是目标。
6. 在任务工作前，如实报告最终阅读深度表（`FULL`/`PARTIAL`/`NOT_READ`，每项附原因）。**如实标注 `PARTIAL` 并解释原因是正确结果，不代表失败**——不要声称尚未达到的完整覆盖。

## 护栏

- 压缩是为了生存，不是整理——绝不要为了腾出空间、“精简”席位或捕获/准备 agent starter（`zrig agent-image` 资源库）而压缩。压缩是有损的（压缩后的 Claude 可能信心十足却内里空洞）；只有席位确实接近上下文上限，且已有压缩前后计划时才能压缩。starter 的价值在于**能工作**，而不是体积小——参阅 `agent-starters` skill。
- 压缩后不要静默启动全新会话。
- 恢复证据存在时，不要依赖记忆继续。
- 不要把必需的恢复阅读延后到未来用户任务。恢复本身就是当前任务。
- 在产品代码/评审工作前，不要跳过根级说明、as-built 文档或 codemap。
- 不要把生成的 touched-file 列表当作详尽清单。
- 压缩后未实际阅读全文时，不要把文件标为 `FULL`。
- 在 restore sentinel 和阅读深度审计完成前，不要恢复任务工作。

## 应避免的失败模式

1. **自信但错误的恢复：**只读 touched-file 列表或摘要就声称已恢复。
2. **未报告的部分恢复：**缺少关键任务上下文时仍继续，或在预算受限的阅读后声称完整覆盖。
3. **跳过项目说明：**遗漏约束任务的 `AGENTS.md`、`CLAUDE.md`、`README.md`、as-built 文档或 codemap。
4. **把 packet 当作详尽清单：**忽略脚本未发现但十分重要的 mission 或 workspace 文件。
5. **等待下一项任务：**把恢复阅读视为取决于未来用户任务的工作，而不是立即完成。
