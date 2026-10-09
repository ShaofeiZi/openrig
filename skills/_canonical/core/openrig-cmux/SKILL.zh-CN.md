---
name: openrig-cmux
description: >
  当需要把 zrig 智能体群组终端打开到 cmux 中时使用——可通过 `zrig terminal --provider cmux`
  将工作组、pod、任务目标、切片或保存的视图转化为实时智能体磁贴，也可按智能体请求操作 cmux。
  视图语义与 openrig-herdr 相同（动词、诚实部分结果/降级、跨工作组只读、滚动/复制、
  仅同尺寸重复视图）；cmux 是**尽力而为** provider（herdr 是默认且受证据门禁约束的 provider）。
  除非明确要求 cmux，否则优先使用 openrig-herdr。
metadata:
  openrig:
    stage: candidate
    sibling_skills:
      - openrig-herdr
      - openrig-user
---

# openrig-cmux

cmux 是 zrig 视图的一个 **provider**——它与 herdr 使用相同的 `zrig terminal` 界面，但会把磁贴渲染到 cmux 中。这是 zrig 已经提供的 provider（现有“Launch in cmux”能力被推广到 `zrig terminal <provider>`），并会继续保持可用。zrig 语义层与 openrig-herdr 完全相同：zrig 决定**哪些**智能体构成视图；provider 负责渲染像素。**请先阅读 openrig-herdr 获取完整模型**——本 skill 只列出 cmux 的差异。

## Provider 状态——cmux 为尽力而为

- **herdr 是默认且受证据门禁约束的 provider**；**cmux 为尽力而为**——它使用相同的 `zrig terminal <provider>` 与 web launcher 入口，但 cmux 未命中不构成切片失败。只有明确要求时才使用 cmux；否则默认使用 herdr（`zrig terminal open <view>`，不加 `--provider`）。
- 视图**与 provider 无关**：相同视图、相同智能体和相同语义可在 herdr 与 cmux 之间复用。保存的视图可在任一 provider 中打开。

## 命令界面（同样三个动词，加 `--provider cmux`）

```bash
zrig terminal open <view> --provider cmux [--json]   # 在 cmux 中打开视图（不加 flag 时默认 herdr）
zrig terminal views [--json]                          # 同一个与 provider 无关的视图库
zrig terminal status --provider cmux [--json]         # cmux 存活性 / 健康状态
```

`<view>` 的解析方式与 herdr 完全相同：**工作组名称**、**`pod:<rig>/<podNamespace>`**、**`mission:<id>`**、**`slice:<id>`**（实时推导）或**保存视图名称**。

## 与 openrig-herdr 完全一致的内容

以下行为完全相同——细节参阅 openrig-herdr：

- **诚实的部分结果 / 诚实降级**——逐一说明 opened / absent / degraded；部分打开时退出码为 0，零 pane 时为非零；http-registered 主机上的智能体会带原因降级（“host `<id>` is http-registered; tiles need ssh”），绝不会静默丢弃。
- **只读策略**——工作组或 `pod:` 视图可交互；`mission:` / `slice:` 视图按构造即为只读；保存视图逐成员设置（`readOnly`）。只读 pane 使用 `tmux attach -r`（客户端 `readonly=1`，按键在物理上无法到达智能体）。详见 openrig-herdr。
- **安全护栏（智能体群组安全边界）**——磁贴只是后台服务所有会话的一个*视图*（嵌套 `tmux attach`）；绝不移动/合并/终止/重新挂接后台服务所有的 pane；关闭磁贴只会分离一个客户端，会话不受影响；生产环境中绝不要实时翻转运行中席位的 tmux 选项（先在隔离环境中证明）。
- **开箱即用的滚动 + 复制**——使用后台服务的终端默认设置（启动时的逐会话滚动 + server 的剪贴板默认设置）；运行中的席位会在下次重新启动时获得滚轮滚动。
- **限制**——v1 磁贴外框只有纯文本标签；重复/多视图成员的 pane 尺寸必须相同（不同尺寸调整不匹配是 tmux 多客户端的固有限制，只做记录，不在此修复）。

## cmux 特有说明

- **逐智能体打开或聚焦**——cmux 已发布集成会打开节点；节点已打开时则聚焦。因此，席位已在 cmux 中以磁贴显示时，应预期聚焦，而不是创建重复项。
- **保留已发布的“Launch in cmux”功能**（字节兼容），并将其扩展为 provider + view 选择器；从 web launcher 打开 cmux 仍然有效。
- **没有 AGPL 隔离边界问题**——与 herdr 不同，cmux 是 zrig 已发布的 provider 集成；适用于 herdr 的 clean-room/never-embed 边界不是 cmux 的约束。（本 skill 本身仍以 clean-room 方式编写。）

## 保存视图——与 provider 无关

保存视图在 `terminal-views.yaml` 中**人工编写**（v1 没有 save/write 动词），并且**与 provider 无关**——确切 schema、存储事实（atomic tmp+rename、字节稳定、位于 OpenRig home 根目录）以及“派生视图绝不持久化”规则详见 **openrig-herdr**。使用 `zrig terminal open <id> --provider cmux` 在 cmux 中重新打开任意保存视图。派生视图（工作组、`pod:<rig>/<pod>`、`mission:<id>`、`slice:<id>`）均实时计算，绝不写入文件。
