---
skill: agent-browser
openrig-relationship: vendored-supplemented
---

# zrig 与此 Skill

## 来源

- **上游：** Vercel agent-browser CLI（https://github.com/vercel/agent-browser）
- **引入模式：** `add-supplementary-files`
- **最近一次上游检查：** 2026-05-13（首次声明关系）

## zrig 如何使用此 Skill

zrig 随产品交付 `agent-browser`，这样任何由 zrig 拓扑派发的智能体都能驱动真实浏览器（快照、填写表单、截图、抓取、Web 应用测试），操作者无需另行安装浏览器自动化 Skill。任何角色包含 Web 工作的智能体 profile 都会引用它。

## zrig 专属修改

这是 **add-supplementary-files** 模式的规范示例（参见 `writing-skills-for-openrig` SKILL.md 的“Vendored skills”一节）。上游 Skill 在结构上保持完整；zrig 添加一个伴随文件，记录本地使用经验，同时避免污染上游内容。

| 界面 | 变更内容 | 原因 |
|---|---|---|
| `SKILL.md` 正文 | 在接近末尾处添加了简短的“## Local Dev Insights”一节，并包含 `**IMPORTANT:** Read LOCAL-INSIGHTS.md` 指针。 | 如果没有该指针，加载此 Skill 的智能体不会知道伴随文件存在。这是让补充模式可被发现所需的唯一结构变更。 |
| `LOCAL-INSIGHTS.md`（新增同级文件，约 189 行） | 上游 Skill 未涵盖的实测陷阱、命令兼容性矩阵，以及在实际使用中发现的修正。 | 例如，并非所有 `get` 子命令都接受 `@refs`——`get text @e1` 有效，但 `get html @e1` 会静默失败。兼容性矩阵能避免最常见的一类困惑。 |

截至最近一次上游检查，`SKILL.md` 中没有其他内容偏离上游。

## 伴随文件

- `LOCAL-INSIGHTS.md`——不可缺少的补充内容。SKILL.md 正文会明确引导读者查看其中的实操陷阱。

## 何时重新同步上游

关注 Vercel 发布的新版 `agent-browser` CLI。当命令界面发生实质变化时：

1. 从上游重新同步 `SKILL.md` 正文，同时保留“Local Dev Insights”指针一节。
2. 更新 `LOCAL-INSIGHTS.md` 兼容性矩阵以反映新行为（某些 `get` 子命令可能新增对 `@ref` 的支持，从而使当前矩阵失效）。
3. 更新 `SKILL.md` front matter 中的 `last_upstream_check`。
4. 在 `divergence_notes` 中记录所有结构形态变化。
