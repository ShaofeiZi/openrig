# 开发 OpenRig —— 门禁与泳道

本文件面向贡献者，说明哪些检查会**阻断**一次改动合入，哪些只是建议性的。当前 tip 没有外部 CI：根 `package.json` 里的脚本链本身就是门禁，发布清单会调用它。

## 阻断门禁（候选版本移动前必须通过）

| 门禁 | 命令 | 覆盖范围 |
|---|---|---|
| 类型检查 | `npm run lint` | daemon + **ui** + cli + tui 的 tsconfig —— UI 类型检查保持阻断 |
| 构建 | `npm run build` | 所有工作区 —— UI 的 dist 会随包发布，因此其构建保持阻断 |
| 仓库脚本 | `npm run test:repo` | 脚本自测、文档守卫、skill 镜像检查 |
| 单元测试 | `npm run test:workspaces` | `packages/daemon` + `packages/cli` + `packages/tui` |

`npm test` 会跑 `test:repo` 和 `test:workspaces` —— 阻断集合在脚本本身里一目了然。

## 建议性泳道

| 泳道 | 命令 | 含义 |
|---|---|---|
| UI 单元测试 | `npm run test:ui` | 按需运行 `packages/ui` 的 vitest；不属于 `npm test` |

## 现状（0.5.0 起冻结 Web UI）

Daemon API 变更不再要求 UI 同步或 UI 验证；`packages/ui/src/hooks/` 下的契约镜像不再主动维护；新出现的 `test:ui` 失败意味着 API 契约动了，而不是门禁破了。

Web UI 的浏览器/交互测试不是贡献者门禁。（打包进入门工作组、用来跑 UI 的智能体 skill 是面向用户工作组的产品内容，不属于本仓库的门禁。）

## 措辞规则

Web UI 是**实验性**的，处于**维护模式**，支持是**尽力而为**的；**CLI 才是主力**。没有计划中的下线时间，欢迎 PR。不要用比本节更强烈的"终止"措辞来描述 UI。
