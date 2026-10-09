# zrig Skills

本目录是随 zrig 一同发布的 canonical skills 的**公开镜像**。这些渐进式披露的上下文清单会由 zrig 智能体按需加载，以便正确完成工作。

这些 skill 从后台服务的内置 skill 目录 `packages/daemon/specs/agents/shared/skills/` **镜像**到此处的 `_canonical/`。因此，阅读 zrig 仓库的人可以直接在仓库根目录找到它们，无需深入查找 `packages/daemon/specs/`。

## 目录内容

| 路径 | 内容 |
|---|---|
| `_canonical/` | 按类别（`core/`、`pm/`、`pods/`、`process/`）组织的镜像 skill，以及少量位于根目录的未分类 skill。不要直接编辑这里的文件——参见下方“编写”一节。 |
| `CHANGELOG.md` | 每个策展周期结束时追加的 skill 变更日志。手工维护。 |
| `LICENSE` | Apache-2.0，与父项目保持一致。 |

## 什么是 skill

在 zrig 中，skill 是一种**渐进式披露上下文注入原语**，不是字典意义上的能力单位。Frontmatter 位于智能体的热层，用于依据触发描述进行低成本模式匹配；正文在激活时加载；目录内引用的文件则按需加载。阅读几份 `_canonical/*/SKILL.md` 即可了解其结构：frontmatter 中的 `description` 是触发器，正文是触发条件匹配时智能体加载的内容。

zrig 智能体会自动发现 skill，通常不需要显式调用。编写 skill 的关键，是为反复出现的需求命名，并提供足够准确的触发描述，使智能体能在正确时机使用它。

## 使用这些 skill

如果你正在运行 zrig（通过 `npm install -g @openrig/cli` 或 tarball 安装），这些 skill 已安装到你启动的每个工作组中——它们随后台服务一起发布，无需额外操作。

如果你只把本目录当作参考阅读（未安装 zrig），这些 SKILL.md 文件就是带 YAML frontmatter 的纯 Markdown；人可以直接阅读，文件也能自我描述。每个 frontmatter 中的 `description` 字段都会说明何时应使用该 skill。

## 编写

Skill 在生命周期中存在于两个位置：

1. **Substrate factory**：`substrate/shared-docs/openrig-work/skills/`
   新 skill 在这里通过策展周期编写、审计和完善。每个 skill 包含 `feedback.md`（策展记录）和 `evals/`（eval-pilot 基础设施）。这里是 skill 团队持续工作的事实来源。

2. **产品源**：`packages/daemon/specs/agents/shared/skills/`
   这里保存随后台服务发布的 skill 子集。Skill 一旦进入产品源，就会被打包进 npm 包。

`<repo-root>/skills/_canonical/`（本目录中的 `_canonical/`）通过 `npm run mirror-skills` **从**产品源生成镜像。镜像必须严格复制——绝不要直接编辑 `_canonical/`；产品源中的修改必须在提交前重新运行镜像脚本来传播。

## 漂移检测

`npm run test:repo` 会运行 `mirror-skills --check`，检测产品源与 `_canonical/` 之间的漂移。如果修改产品源中的 skill 后没有重新生成镜像，测试会失败，并明确提示需要运行的脚本。GitHub Actions 接入后，CI 也可能强制执行此门禁。

## 未来状态

本目录的结构**就像它已经是一个独立仓库**，因此未来规模扩大时，可以直接执行 `git subtree split --prefix=skills HEAD`。在此之前，仓库内镜像仍是正确边界：skill 变更与加载它们的后台服务二进制以原子方式一同发布，不存在版本偏差风险，两部分通过同一个 PR 交付。
