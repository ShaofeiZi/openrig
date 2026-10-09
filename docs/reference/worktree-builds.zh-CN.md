# Worktree 构建：每个 worktree 单独安装，绝不要用符号链接的 `node_modules`

**最初登记为**构建摩擦（一个 TS2688 `@types/node` 失败）。**后来判定为**更严重的问题：为省掉安装而做的符号链接捷径，会让构建和类型检查静默地消费**另一个代码树**的源码——这是一个假绿（false-green）发生器，而不是一点不便。

## 实际发生了什么

在 worktree 里 `npm install` 会把 `node_modules/@openrig/<pkg>` 建成一个**相对**符号链接（`-> ../../packages/<pkg>`）。相对链接是相对于它所在目录解析的，所以：

| 设置 | `@openrig/daemon` 解析到 | 结论 |
|---|---|---|
| 每个 worktree 单独 `npm install` | 该 worktree 自己的 `packages/daemon` | 正确 |
| `ln -s <主检出>/node_modules node_modules` | **主代码树**的 `packages/daemon` | **跨树** |

这一点是用判别实验验证的，不是靠推断：在符号链接 `node_modules` 的情况下，故意在 **worktree** 的 `packages/daemon` 里引入一个类型错误，该包自己的 `tsc` 能看到它，但 `packages/cli` 的 `tsc` 看不到、退出码为 0——因为它类型检查的是主树的 daemon。于是一个 worktree 可以对着自己根本不包含的代码报绿。

## 规则

1. **在每个 worktree 里都跑 `npm install`**，让工作区包解析到 worktree 自己的源码。
2. **绝不从主检出符号链接 `node_modules`。** 它看起来能用——构建过、类型检查过——这恰恰是危险所在。
3. **没有 `node_modules` 时跑 `npx tsc` 会装上一个不相干的 `tsc` 包**，并打印 "This is not the tsc command you are looking for"。那句话的意思是*没装依赖*，不是 TypeScript 报错。
4. 在全新 worktree 里**先构建 `@openrig/daemon`，再类型检查 `@openrig/cli`**：cli 会 import `@openrig/daemon/crash-cart` 等，它们解析到 daemon 的 `dist`。没有 dist 时会报 TS2307 "Cannot find module" 以及一连串隐式 any——这是环境准备产物，不是代码缺陷。

## 信任任何 worktree 构建之前的自检

    [ "$(readlink -f packages/daemon)" = "$(readlink -f node_modules/@openrig/daemon)" ] \
      || echo "跨树：这个 worktree 把 @openrig/* 解析到了另一个代码树"
