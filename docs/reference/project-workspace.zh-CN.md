# 项目工作区契约

OpenRig 的项目 TUI 是一个架在工作区根之上、文件支撑的视图。目录形状刻意做得简单，好让人和智能体不需要 daemon 内部知识就能创建或修复它。

这个子树是更宽的 [OpenRig 实例布局](instance-layout.md) 的一部分。实例初始化器把这些确切的工作区字节委托给本 owner。

## 默认形状

`zrig config init-workspace` 在 `~/.openrig/workspace` 创建默认工作区，除非 `--root` 或 `workspace.root` 指向别处。

```text
workspace/
  SPEC.md
  project.yaml
  workspace.yaml
  .gitignore
  missions/
  exhaust/
```

脚手架是增量的：它创建缺失的规范条目，绝不覆盖已有文件（即使是已废弃的 `--force` 标志也不覆盖）。`exhaust/` 和本地 `.openrig/` 运行时投影被忽略；撰写的项目上下文和任务目标/slice 文件保持可版本化。`workspace.yaml` 是项目位置目录。项目 manifest 暴露空的 `install.context` 和 `install.skills` 选择器，分别用于有序 Markdown 地址和稳定的受管目录 skill ID，但 skill 源字节和 System World 都不属于这棵树。

## 项目世界安装

`project.yaml` 可以同时选择项目上下文和受管 skills：

```yaml
schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context:
    - conventions.md
  skills:
    - repository-maintenance
```

`install.context` 含项目相对的 Markdown 地址。`install.skills` 只含稳定 skill 身份。skill 源字节住在唯一配置好的受管目录（`skills.root`，默认 `$OPENRIG_HOME/skills`），绝不放在项目或工作区下。`zrig context work-install --runtime <claude-code|codex>` 解析这两部分；加 `--apply-skills` 把选定的确切字节对账到调用者当前工作目录下的 `.claude/skills/` 或 `.agents/skills/`。当接收智能体在别处工作时用 `--cwd`；项目世界元数据根绝不被假定为它的代码工作目录。

生成的运行框架目录和 `.openrig/skill-loadouts/` 归属收据是投影，不是源。产品仓库应当忽略它们。对账只在某个被取消条目的当前字节仍匹配 OpenRig 上次拥有的投影时才删除它；无关的和本地改过的条目被保留或报为冲突。

同一运行时的席位通常共享一个工作目录。它们的拓扑选择器按规范席位身份保留，并以并集投影，所以启动一个角色不会移除另一个角色的 skill。投影变更只对新的运行框架进程可见；对账会报告这个边界，而不是声称一个运行中席位热加载了它。

已安装的项目选择也保留在那个工作目录的归属收据里。之后一次不带项目世界输入的席位启动保留它；一个 `install.skills` 为空的显式安装清掉它。这让"未提供项目"和"项目刻意不选 skill"区分开。

## TUI 项目选择

打开 **PROJECTS**（或输入 `projects`）从配置好的工作区目录选一个 ID 和根。`project <id>` 选一个确切目录条目；随后 `mission <directory>` 打开该项目的执行视图。历史的 `scopes` 机器段 ID 仍有效。项目选择及其规范根随 mission、slice、源文件和 Back 导航一路携带。改一个目录根需要重新选它。缺失或畸形的源保持不可用；另一个项目的匹配工作 ID 绝不作为回退。

`source` 通过既有的文件读取白名单打开当前项目、mission 或 slice 的真实源码。目录成员身份不授予文件读或执行权限。这些视图只读；它们不选生命周期操作，也不激活 mission。执行和 slice 队列成员身份需要一个确切的 `project:<id>` 标签；生命周期实例用它撰写的项目身份。无范围的历史队列行和没有项目绑定的全局评审产物，不参与项目特定的主张。

读取 API 新增 `GET /api/scopes/projects`，并在 scopes、执行和 slice 详情读取上加可选的 `project` 和 `projectRoot` 参数。slice 详情还要求选中的 mission 目录。不带 project 参数的既有读取保持其旧契约。

## UI 映射

- `workspace.root` 映射到 Project 工作区。
- `workspace.catalog_path` 映射到 `workspace.yaml` 项目目录。
- `workspace.projects_root` 是已编目项目世界的默认住所。
- `workspace.root/missions/<mission-id>` 映射到一个 Project mission。
- `workspace.root/missions/<mission-id>/slices/<slice-id>` 映射到一个 Project slice。
- 当文件根在白名单里时，mission 的 `PROGRESS.md` frontmatter 提供 mission 状态徽章。
- mission 和 slice 的 `SPEC.md` frontmatter 提供意图、建议性的同级构建顺序 `depends_on`、生命周期状态和队列链接提示。
- slice 的 `PROGRESS.md` 是持久验收清单；`PROOF.md` 和 `proof/` 保留与 SPEC 证明契约配对的证据。

mission 和 slice ID 应是稳定的 kebab-case 字符串。让 slice ID 在工作区内唯一，好让 `/project/slice/<slice-id>` 无歧义解析。

## 队列映射

队列条目在其正文或标签提到以下之一时挂到一个 slice：

- slice ID；
- mission ID；
- slice frontmatter 里旧的 `rail-item` 值。

新工作请在队列条目正文或标签里同时带上 mission 和 slice ID。示例：

```text
Mission: idea-ledger
Slice: capture-product-ideas
```

这让 Story、Queue、Tests、Topology 标签页和文件系统 slice 对齐，而不用另起一个项目数据库 schema。

## 兼容性

默认发现根是 `workspace.slices_root=<workspace.root>/missions`。slice 索引器也支持旧的扁平根，如 `workspace.slices_root=<workspace.root>/slices`，那里每个直接子文件夹是一个 slice。扁平根保持可读，但 mission 感知形状是默认设置契约。

## 修复清单

如果 Project 显示一个 mission 发现警告：

1. 跑 `zrig config get workspace.root --show-source`。
2. 跑 `zrig config get workspace.catalog_path --show-source`。
3. 跑 `zrig config get workspace.slices_root --show-source`。
4. 确认 `workspace.slices_root` 指向一个含 mission 目录、且 mission 目录下有 `slices/` 子目录的文件夹。
5. 确认 `files.allowlist` 含 `workspace:<workspace.root>`，好让 TUI 能读 mission 的 `PROGRESS.md`。
6. 如果工作区缺失，在操作员批准后跑 `zrig config init-workspace`。

大多数配置读取不需要重启 daemon。改启动时根（如 `files.allowlist` 或进度扫描根）时才重启。
