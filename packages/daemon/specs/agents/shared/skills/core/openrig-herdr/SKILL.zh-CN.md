---
name: openrig-herdr
description: >
  用于以 herdr wall 形式打开 zrig 舰队终端——通过 `rig terminal` 把工作组、pod、任务目标、切片或保存视图变成实时交互式智能体 tile；以只读方式观察另一工作组；或应智能体请求驱动 herdr（“把我的所有工作组和一个任务目标打开为视图”）。涵盖 `rig terminal open|views|status` 动词、对结果的诚实 partial/degrade 解读、跨工作组视图在结构上只读的护栏、开箱即用的滚动/复制，以及重复 pane 必须同尺寸的限制。herdr 是默认且经过证明门禁的提供方。
metadata:
  openrig:
    stage: candidate
    sibling_skills:
      - openrig-cmux
      - openrig-user
---

# openrig-herdr

zrig 决定一个视图由**哪些**智能体组成（一个工作组、pod、任务目标、切片或已保存分组）；**herdr** 负责渲染像素。视图会以实时交互式终端 tile 打开——每个 tile 都是对后台服务所拥有智能体会话执行的嵌套 `tmux attach`，所以你得到的是真实会话，不是快照。zrig 负责语义；herdr 负责界面。你完全通过 `zrig terminal` CLI 驱动它；该 CLI 与已安装的 herdr 二进制保持边界调用——绝不要链接、嵌入或将其插件化。

## 完整界面——三个动词

```bash
zrig terminal open <view> [--provider herdr|cmux] [--json]   # herdr 是默认提供方
zrig terminal views [--json]                                 # 列出可打开视图（保存 + 推导）
zrig terminal status [--provider] [--json]                   # 提供方存活/健康状态
```

`<view>` 按以下顺序解析为其中一种：

- **工作组名称**——该工作组内所有实时智能体，自动布局；
- **`pod:<rig>/<podNamespace>`**——工作组某一 pod 内所有实时智能体（按 pod 筛选工作组清单）；
- **`mission:<id>`**——处理该任务目标的智能体（从拓扑实时推导）；
- **`slice:<id>`**——处理该切片的智能体（实时推导）；
- **保存视图名称**——用户定义的分组（见“保存视图”）。

## 根据一句话组合视图

如果智能体请求“把我的所有工作组和一个任务目标打开为视图”，应为每个目标运行一次 `open`：

```bash
zrig terminal open acme-web                     # 整个工作组，实时智能体作为 tile
zrig terminal open mission:site-relaunch        # 正在处理该任务目标的准确智能体集合
zrig terminal open slice:search-filters         # 正在处理一个切片的智能体
```

无需手工列出席位：打开时会根据实时拓扑推导任务目标/切片成员。

## 诚实读取结果——partial 与 degrade

结果是一个分区——每个席位恰好落入一个具名 bucket：

- **opened**——目前已作为 tile 展示的实时智能体。
- **absent**——视图中当前不在线的席位：**会具名并跳过，绝不静默丢弃。** 只要视图成功打开*部分*席位，就算成功（同时披露 partial）并以 **0** 退出。只有**没有任何** pane 打开的视图才以**非零**退出。
- **degraded**——结构上无法作为 tile 展示的智能体，会**连同原因一起具名**。v1 中的情况是：智能体所在主机通过 HTTP 注册，没有 ssh 路径，因此无法组合其 tile——结果会显示 **“host `<id>` is http-registered; tiles need ssh”** 并跳过，绝不会丢弃。（可通过 ssh 到达的主机使用 ssh 包装的 attach 显示 tile；完整 HTTP 主机 tile 延后到跨主机传输边界。）

使用 `--json` 可根据分区进行程序化分支；退出码本身只表示打开了内容（0）或什么都没打开（非零）。

## 只读——谁可交互，谁只能观察

只读属性会在打开时组合进 pane——只读 tile 使用 `tmux attach -r`，客户端报告 `readonly=1`，并且**物理上无法发送输入**。当前策略按视图类型划分：

- **工作组视图或 `pod:` 视图可交互**——你直接请求了该工作组（或 pod），所以可以驱动其中的智能体。
- **`mission:` 与 `slice:` 视图在结构上只读**——这些推导视图横跨工作组；你可以观察和滚动，但不能向其中输入。
- **保存视图按成员设置**——每个成员都带自己的 `readOnly`（省略 = 可交互；`true` = `attach -r`）。

因此无需时时提醒自己谨慎：视图类型（保存视图则是按成员 flag）会在打开时设置只读属性。

## 安全护栏（硬约束——舰队安全护栏）

- Tile 是后台服务所拥有会话的一个**视图**（嵌套 `tmux attach`）。**绝不要**移动、join、kill 或重新指定后台服务所拥有 pane 的父级。关闭 tile 只会断开一个 tmux 客户端——后台服务会话不受影响，其寻址（send/capture/nudge）也保持不变。
- 主机本地只读观察不会修改任何内容。凡是会改变**实时**后台服务会话共享状态的操作（例如切换运行中席位的 tmux 选项）都属于配置/设计变更——必须在隔离环境中证明，绝不要在生产中实时切换。

## 开箱即用的滚动与复制

在刚启动的智能体 tile 上，鼠标滚轮可以滚动 pane 历史，拖动选择会复制到**系统**剪贴板——无需输入 tmux 命令。这依赖后台服务的终端默认值（启动时设置的按会话滚动选项，以及后台服务 tmux server 的剪贴板默认值）。准确的生效时机是：此功能交付前已运行的智能体会在**下一次自然重启**时获得滚轮滚动（滚动默认值按会话设置，运行中的席位绝不会被事后切换）；系统剪贴板复制会立即生效（它属于 server 级设置）。

## 限制——明确说明，不要掩盖

- **Tile chrome v1 只是普通标签**（智能体 + 切片）。更丰富的按 tile 状态属于 roadmap。
- **重复 / 多视图成员关系**（同一智能体同时存在于两个视图）可以工作——但重复项必须放在**相同尺寸的 pane** 中。不同尺寸的重复 pane 存在 tmux 多客户端尺寸不匹配这一固有限制（tmux 会收缩到最小客户端）；这是**已记录但未修复**的问题——不要期待某项设置能消除它。
- **内部 tmux 状态栏**默认隐藏（由 herdr 提供 chrome）；一个配置键（`terminal.status_bar`）可为原始 tmux / 无提供方界面重新打开它，且该变更**只对未来启动生效**。

## 保存视图——库（`terminal-views.yaml`）

在 v1 中，保存视图通过**手工编写** `terminal-views.yaml` **创建**——不存在 save/write 动词（`open` / `views` / `status` 是完整界面；`zrig terminal save <id>` 是具名延伸/后续事项）。与其他视图一样，使用 `zrig terminal open <id>` **重新打开**。

文件位于 zrig 主目录根部（通过 `getDefaultOpenRigPath()` 解析），采用原子写入（tmp + rename），且字节稳定。**只有手工编写的保存视图位于这里——推导视图（工作组、`pod:<rig>/<pod>`、`mission:<id>`、`slice:<id>`）都实时计算，绝不会写入此文件。**

Schema——字段名和顺序必须**完全一致**；可选字段不存在时应**省略**（绝不要写 `null`）：

```yaml
version: 1
views:
  - id: my-view-id             # 必填——zrig terminal open <id> 接受的 ID
    name: Human Name           # 必填
    members:
      - seat: pod-member@rig    # 必填——规范会话名
        label: agent . slice    # 可选——pane 标签
        host: some-host-id      # 可选——结构化主机 ID（绝不能写成 member@rig@host 字符串）；
                                #       本地成员省略。ssh 注册主机可显示 tile；
                                #       http 注册主机会诚实降级（具名 + 跳过并说明原因）
        tmuxSession: sessname   # 可选——默认值为 seat
        readOnly: true          # 可选——省略 = 可交互；true = tmux attach -r
```

智能体应用户请求组合保存视图时，先**写入此 YAML**，再打开对应 ID：`zrig terminal open my-view-id`（cmux 需添加 `--provider cmux`）。库与提供方无关——同一保存视图可以在 herdr 或 cmux 中打开。

## AGPL / 净室

通过 `zrig terminal` CLI 驱动 herdr（CLI 通过命令行/socket 与已安装的 herdr 二进制通信）属于边界调用，可以使用。**不要**链接 herdr 源代码、将其嵌入进程，或交付 herdr 插件——插件需要法律审查。此 Skill 及其文档采用净室方式编写：只记录模式，绝不使用 herdr 源代码文本。
