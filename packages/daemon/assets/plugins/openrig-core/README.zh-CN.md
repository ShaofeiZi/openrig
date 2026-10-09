# openrig-core

用于跨运行时智能体拓扑协调、连续性保障和运行纪律的规范 zrig skills 与 hooks。

## 此插件提供的内容

**Skills（19 个）：**规范的 zrig 运行知识，包括公开的 `refocusing` skill 及其仅记录路径的拓扑/工作轨迹。

**Hooks：**活动跟踪、压缩连续性以及默认启用的重新聚焦通道。两个运行时都会在压缩后执行 Refocus；Claude 还会在达到阈值时触发。两个运行时均支持按需触发和配置关闭，且全新会话启动时绝不会执行。

## 运行时

此插件采用双 manifest 打包，同时提供 `.claude-plugin/` 和 `.codex-plugin/`。使用方式如下：

- **Claude Code** — zrig 后台服务首次运行并将 `openrig-core/` 内置到 `~/.openrig/plugins/openrig-core/` 后，通过 `/plugin` 安装；远程分发可用时，也可以直接使用 Claude Code 自己的插件命令安装
- **Codex CLI** — 完成同一内置步骤后，通过 `/plugins` 安装；也可以直接使用 Codex 自己的插件命令安装

有一个 skill 专门针对 Claude Code 的压缩行为：

- `claude-compaction-restore` — Claude Code 智能体执行 `/compact` 后，使用 JSONL 转录和曾改动的文件重建其工作心智模型

它**不是**让 Codex 对自身执行的（Codex 会在内部处理压缩，不需要重建 SOP）。不过，作为编排者的 Codex 智能体经常会在恢复一位刚完成压缩的 Claude 同伴时调用此 skill——这正是它的用途。两个运行时都会随附该 skill。

其他所有 skills 都按跨运行时用途设计。

## 分发

npm 包在后台服务的 `assets/plugins/openrig-core/` 下包含一份离线基线。后台服务会先解析本地插件权威来源，再尝试通过网络获取内容；它使用已配置的 OpenRig home（安装副本通常位于 `~/.openrig/plugins/openrig-core/`）：

| 安装状态 | 本地内置行为 |
| --- | --- |
| 不存在 | 植入打包随附的插件。 |
| manifest 版本较旧 | 使用较新的内置版本推进文件。 |
| manifest 版本相同 | 保留已安装内容；对于字节完全相同的文件，可能会协调其可执行模式。 |
| manifest 版本较新 | 保留已安装副本。 |

插件 manifest 决定版本权威性。已有目录如果没有 manifest，会保持不变；manifest 版本无效或彼此不一致时，系统会报告问题，而不是猜测。因此，更新 CLI 不会无条件覆盖版本相同、版本较新或独立管理的插件副本。

本地解析完成后，后台服务会尝试访问 GitHub release 端点获取 `openrig-core.tar.gz`，超时时间为五秒。目前这条路径只会获取并记录响应：不会解压归档、比较版本或安装其中的内容。获取失败（包括 404 和网络错误）时，已解析的本地副本会继续保留。即使获取成功，本地副本也不会改变。这里描述的是获取功能的当前实现，并不声称外部仓库目前一定提供 release 制品。

如果希望在 zrig 外部管理插件，也可以直接使用 Claude Code 或 Codex 自己的插件命令进行安装。

## 许可证

Apache License 2.0。详见 `LICENSE`。

## 源码

- 插件仓库：https://github.com/mvschwarz/openrig-plugins
- zrig CLI：https://github.com/mvschwarz/openrig
