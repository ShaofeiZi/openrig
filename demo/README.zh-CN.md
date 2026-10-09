# 北极星演示

这是一个完整的多智能体拓扑，用于展示 zrig 的核心能力。

本目录是 zrig 的规范编写示例，供人和编码智能体共同阅读，作为真实工作组目录结构的参考：

- `rig.yaml`——拓扑的唯一事实来源
- `culture.md`——整个工作组共享的文化与指引
- `agents/*/agent.yaml`——每个智能体的软件包清单
- `scripts/`——基线填充、验证和证明辅助脚本

同一目录树也是同一 checkout 下 bundle 测试的 golden source：

```bash
zrig bundle create demo/rig.yaml --rig-root demo -o /tmp/demo.rigbundle
zrig bundle inspect /tmp/demo.rigbundle
zrig bundle install /tmp/demo.rigbundle --yes --target /tmp/demo-install
zrig up /tmp/demo.rigbundle
```

## 拓扑

- **orch** pod：`lead`（claude-code）——编排者
- **dev** pod：`impl`（claude-code）、`qa`（codex）、`design`（claude-code）
- **rev** pod：`r1`（claude-code）、`r2`（codex）
- **infra** pod：`daemon`（terminal，监控）、`ui`（terminal，cwd 为 packages/ui）
- 边：`orch.lead` 委派给 `dev.impl`，`dev.qa` 观察 `dev.impl`，`rev.r1` 与 `rev.r2` 协作

拓扑共含 4 个 pod、8 个节点：6 个智能体运行壳和 2 个 terminal 基础设施节点。

## 前置条件

- Node.js 22+
- tmux 3+
- 已构建 zrig：在仓库根目录运行 `npm run build`
- 已安装 Claude Code 和/或 Codex CLI

## 快速开始

```bash
./demo/run.sh
```

`run.sh` 会启动拓扑，并为演示工作组建立可安全恢复的基线。如果新的运行时会话尚不能恢复，它会为每个智能体填充一轮预热消息，再次验证原生恢复能力，然后才把控制权交还。

## 恢复基线

在把恢复能力视为可信之前，应在一次全新启动上建立并验证运行时恢复基线：

```bash
npx tsx demo/scripts/check-demo-health.ts --rig demo-rig
npx tsx demo/scripts/verify-native-resume.ts --rig demo-rig
npx tsx demo/scripts/seed-resume-baseline.ts --rig demo-rig
npx tsx demo/scripts/verify-native-resume.ts --rig demo-rig
```

这个基线很重要，因为 Claude 与 Codex 的原生恢复语义不同。当前观察到的运行时注意事项见 `docs/planning/post-northstar-round/runtime-resume-semantics.md`。

macOS 上当前已知正常的规则：

- 此演示中新建的 Codex 会话可以立即恢复
- 刚执行 `zrig up` 后，新建的 Claude 会话还不能安全创建快照
- 对本 fixture 而言，每个智能体完成一轮预热对话后，当前保存的 Claude ID 即可恢复

## 完整验证包

```bash
./demo/run-proof.sh
```

该脚本会在 `demo/proof/` 中生成自动化验证产物：

| 产物 | 来源 | 类型 |
|----------|--------|------|
| `up-transcript.txt` | `zrig up demo/rig.yaml` 输出 | 自动 |
| `ps-nodes.txt` | 启动后执行 `zrig ps --nodes --rig <rig>` | 自动 |
| `health-after-boot.json` | 启动后执行 `check-demo-health.ts` | 自动 |
| `native-resume-after-boot.txt` | 启动后立即执行的原生探测 | 自动 |
| `native-resume-after-boot.json` | 立即执行的原生探测机器输出 | 自动 |
| `seed-resume-baseline.txt` | 恢复基线填充摘要 | 自动，仅在需要填充时生成 |
| `seed-resume-baseline.json` | 基线填充机器输出 | 自动，仅在需要填充时生成 |
| `native-resume-before-down.txt` | 停止前的原生 Claude/Codex 探测 | 自动 |
| `native-resume-before-down.json` | 原生探测机器输出 | 自动 |
| `down-transcript.txt` | `zrig down` 输出 | 自动 |
| `tmux-check.txt` | 拆除后执行 `tmux ls` | 自动 |
| `restore-transcript.txt` | `zrig restore <snapshotId> --rig <rigId>` 输出 | 自动 |
| `ps-restored.txt` | 恢复后执行 `zrig ps --nodes --rig <rig>` | 自动 |
| `browser-screenshot.png` | Explorer + Graph + Detail Panel | **手动** |
| `resume-test.txt` | 恢复后的智能体上下文检查 | **手动** |

### 手动步骤

`run-proof.sh` 完成后：

1. **浏览器截图：** 打开 `http://localhost:5173`，截取包含全部 pod 的 Explorer、带 pod 分组的 Graph，以及已经展开的 Node Detail Panel。保存到 `demo/proof/browser-screenshot.png`。

2. **恢复测试：** 运行 `tmux attach -t orch-lead@demo-rig`，询问“你刚才在做什么？”，并将回答复制到 `demo/proof/resume-test.txt`。

## 预期会话名称

启动后，`tmux list-sessions` 应显示：

```
orch-lead@demo-rig
dev-impl@demo-rig
dev-qa@demo-rig
dev-design@demo-rig
rev-r1@demo-rig
rev-r2@demo-rig
infra-daemon@demo-rig
infra-ui@demo-rig
```

## 预期启动时间

启动 6 个智能体运行壳和 2 个 terminal，按拓扑顺序串行执行。预计总耗时为 2–5 分钟，具体取决于硬件。

## 恢复说明

- 要生成准确验证或反复进行本地测试，优先使用显式恢复：`zrig restore <snapshotId> --rig <rigId>`
- 只有当历史上仅存在一个同名且已停止的工作组时，`zrig up demo-rig` 才能安全地用作恢复快捷方式。一旦存在多个名为 `demo-rig` 的历史实例，zrig 会正确返回歧义错误。
