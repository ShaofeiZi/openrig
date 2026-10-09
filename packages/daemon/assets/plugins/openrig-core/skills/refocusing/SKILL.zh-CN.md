---
name: refocusing
description: >-
  当长时间运行的智能体可能已经偏离产品结果、上下文已被压缩、工作跨越了重要边界，
  或下一项关键行动前需要重新执行基于路径的追踪时使用。不要用于新会话定位、唤醒空闲席位或阶段检查点。
metadata:
  openrig:
    stage: product
---

# 重新聚焦

重新聚焦会保留长会话已经积累的专业知识，同时让它重新立足于当前意图和亲历上下文。这不是重启、唤醒或阶段检查点。

请从此 Skill 目录运行随附的追踪脚本，不要凭记忆重建层级：

```bash
python3 scripts/trace-to-root.py --trees both --depth light
```

使用 `--trees topology|work|both` 选择上下文域，使用 `--depth light|full` 控制每个节点提供多少内容。轻量工作追踪会组合 `intent:` 并列出 notes 名称；完整追踪则包含完整的节点与 notes 正文。脚本通过 `zrig config get` 解析 `topology.root` 和 `workspace.root`。如果无法推导当前节点，请设置 `OPENRIG_REFOCUS_TOPOLOGY_NODE` 或 `OPENRIG_REFOCUS_WORK_NODE`，也可以传入对应的 `--*-start` 选项。

修改自动 hook 或其内容阶梯时，请阅读 [references/refocus.md](references/refocus.md)。缺少链式文件本身就是证据：报告这一空白并继续；绝不要沿指针捏造第二个父节点。
