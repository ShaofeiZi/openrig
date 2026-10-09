# 为 OpenRig 做贡献

感谢你来到这里。OpenRig 以开源方式构建，而且它本身就是它所描述的那个东西：一组编程智能体组成的工作组（rig）加一小群人。外部 pull request 和 issue 来得比我们预想的更快——这是最好的那种烦恼。本页说明如何让一次改动以对双方都最小的摩擦合入。

## 开始之前

- **Bug：** 使用 bug 模板新建 issue。请附上你的 OpenRig 版本（`zrig --version`）、操作系统、Node 版本、涉及哪些运行框架（harness，或说明未涉及），以及相关命令和输出。报告是公开的：发帖前请删除凭据、私密提示词、个人信息和私有路径。请分享一个最小复现，而不是完整日志或整份实例转储。
- **新功能与行为变更：** 先在 *Ideas* 中开一个 issue 或 Discussion。短短一句"我想做什么、是什么挡住了我"能帮双方省掉一次重写。小而明确的修复不需要开 issue。
- **提问：** 请使用 [Discussions › Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a)，而不是 issue。

## 环境准备

需要 Node `^22 || ^24` 和一个可用的 `tmux`。然后：

```bash
git clone https://github.com/mvschwarz/openrig.git
cd openrig
npm install
npm run build          # 所有工作区
npm test               # 仓库检查 + daemon、cli、tui 测试套件
npm run lint           # 对每个包做类型检查
```

`npm test` 会先构建 daemon 并运行仓库检查，再跑各包套件。请读懂具体失败原因：`npm run mirror-skills` 会更新 skill 镜像，`npm run generate-context-packs` 会更新生成的 context pack。当它们的源文件发生变化时运行这两个命令，并审查生成的 diff；这两个命令并不能修掉所有文档类失败。UI 单元测试套件是建议性的、独立的：`npm run test:ui`。

动手开发前，请阅读[检查项要求](docs/reference/developing.md)、[worktree 设置](docs/reference/worktree-builds.md)以及[对机器的改动](README.md#what-openrig-changes-on-your-machine)。对于会启动 daemon 或智能体的改动，请使用隔离环境；仅靠 `OPENRIG_HOME` 并不能隔离服务商配置。权限配置是一项[明确的选择](docs/reference/getting-started.md#have-your-agent-configure-permissions)。检出的代码树并不是已安装的 daemon；重启已安装的 daemon 并不会采用你的工作副本。

## 做改动

- 每个 pull request 只解决一个问题。把无关的重构分开；若修复必须附带重构，请说明原因。
- 保持 diff 小到可以一次坐下来审完。如果做不到，请在描述里说明原因。
- 在可测试处新增或更新测试。尽量使用聚焦、确定的测试。对于终端或服务商行为，请说明哪些是用真实运行时验证的、哪些是模拟的；单靠 stub 并不能证明原生交互可用。
- 不要编辑 `CHANGELOG.md`。维护者会在打 tag 时撰写发布说明。
- 不要升级版本号。
- 与周围风格保持一致。`npm run lint` 做类型检查，不做代码格式化。
- 按提交日志已有的风格写提交信息：`fix(cli): …`、`feat(daemon): …`、`docs(reference): …`、`harness: …`。

## 提交 pull request

填写模板。评审者需要的三样东西是：用户能获得什么、你如何验证、你还有哪些不确定。说明你测试的是哪个版本和哪些本地改动、你实际运行了什么、以及哪些检查你没能运行。从证据材料中隐去私密信息。

贡献遵循仓库的 [Apache-2.0 许可证](LICENSE)。改编第三方素材时，请保留署名和适用的许可声明。

## 可以期待我们做什么

- 我们力争在**一天内**回应 issue 和 pull request。回应不等于完成评审或合并决定。
- 我们对外部 PR 的首个实质性评审决定目标是**七天**。如果更久，我们会在 PR 上说明卡在哪一步。这是目标，不是承诺的期限。
- 你会看到的标签：`needs-repro`（我们还没能复现，在等版本或步骤）、`fixed-on-main`（已合并，但还没发到 npm）、`good first issue`、`help wanted`、`discussion`（方向类问题，转到 Discussions 继续）。

这里的评审由人，也由项目自己的智能体完成。智能体可能先问出第一个澄清问题或跑复现；合并决定由维护者做出。

## 东西都放在哪

- 仓库参考文档：`docs/reference/`；用户文档：[openrig.dev/docs](https://openrig.dev/docs)。
- Skills：`packages/daemon/specs/agents/shared/skills/`，以及 `packages/daemon/assets/plugins/` 下的插件 skill；静态 context-pack 源：`packages/daemon/context-packs-src/`。生成的 pack 位于 `packages/daemon/context-packs/`，不要手工编辑或提交它们。
- 发布：[GitHub Releases](https://github.com/mvschwarz/openrig/releases) 与 npm 上的 `@openrig/cli`。
