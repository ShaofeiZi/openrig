# Chain 文件约定（CE-v2）

**本文件是 chain 文件的 SSOT（单一真源）**：它们怎么命名、每个高度（altitude）承载什么、从叶子到根的 trace 如何解析。两棵树的 walker 都消费这里定义的路径。如果 walker 和本文件不一致，必有一方有缺陷——报出来，不要分叉约定。

## 唯一一条规则

**一个文件名，在一棵树的每个高度上完全相同。** 读者从自己站的位置朝根走，在每一层读同名文件即可。没有指针要跟、没有分支、没有按层命名。发明一个按层命名会破坏所有 walker。

Chain 文件挂在**节点**上（一个实例、一个工作组、一个 pod、一个席位；一个任务目标、一个 slice）——绝不挂在层架（shelf）上（`rigs/`、`seats/`、`missions/` 是容器，不是节点，不挂 chain 文件）。

## 两棵树，两个问题

| 树 | 路径形状 | 承载 | 是否随包发布？ |
|---|---|---|---|
| **拓扑树** | 实例 → 工作组 → pod → 席位 | 工作在这里*怎么做* | **是** —— 通用默认值随源码发布 |
| **项目树** | 项目 → 任务目标 → slice | 正在构建*什么* | **否** —— 取决于用户在构建什么；见下 |

### 拓扑树

根在带类型的配置键 **`topology.root`**（解析顺序：`env OPENRIG_TOPOLOGY_ROOT > config file > 派生默认 $OPENRIG_HOME/topology`）。绝不要硬编码路径——在任何机器上，`zrig config get topology.root` 就是答案。实例高度**就是根的顶端**（没有一个要去找的实例目录；根就是实例）：

```
<topology.root>/<NAME>.md                         # 实例高度
<topology.root>/rigs/<rig>/<NAME>.md              # 工作组高度
<topology.root>/rigs/<rig>/pods/<pod>/<NAME>.md   # pod 高度
<topology.root>/rigs/<rig>/seats/<seat>/<NAME>.md # 席位高度
```

引擎在物化拓扑时会创建实例根、工作组目录和每个声明的 pod 目录，即使没有手写的 chain 默认值。Pod 上下文仍是可选的：只在一个上下文域内共享知识时才用这个高度。跨 pod 的指引仍属于工作组高度。

拓扑树上已确立的 chain 名：

- `LEARNED.md` —— 一个位置（POSITION）学到了什么；绝不原样共享或发布。一个席位的 LEARNED 由它的**路径**标识：两个工作组里同名席位是两个不同文件。
- `CULTURE.md` —— 启动时分发到成员身上的规范。

### 项目树

根在工作区键（`workspace.root`、`workspace.slices_root`）。那里的 chain 名：`SPEC.md`（frontmatter 里的意图沿链向上组合；规格是叶子属性）、`PROOF.md`、`PROGRESS.md`。

**项目树上下文不能随包发布。** 它描述*你*在构建什么——任务目标意图、slice 规格、证明契约。没有厂商能提前写它，而发布一个默认值会把别人的项目装成你的上下文。演示项目带了一个可照抄的完整示例；真实项目自己写。（拓扑树上下文相反：一个智能体团队如何跑得好，大体是通用的，所以自带工作组才发布默认值。）

## 旧位置与 advisory

在本约定之前，拓扑树位于 `~/.openrig/shared-docs/rigs/`（设计决策 2026-08-14：某台机器上的一个任意文件夹，不是产品路径）。那个位置**保持可读**，作为逐层回退，让既有工作组平滑迁移而不是崩掉——但每次解析到那里的读取都会发一个具名 advisory（`legacy-topology-read: …`），说明旧来源、`topology.root` 下的规范目标和配置键。静默的旧位置读取是缺陷。旧字面量在每个 settings 孪生里只存在于一个 helper（`resolveLegacyTopologyRigsRoot`）中；walker import 它，自己不带路径字面量。

## trace

`zrig context trace --rig <rig> [--pod <pod>] [--seat <seat>] --name <NAME>.md` 执行这次行走：它按根在前（一般 → 具体）的顺序打印每个选定高度，标记内容来自 `topology.root`、旧树（在 stderr 带 advisory），还是缺失；它不需要 daemon 在跑—— orientation（定位）恰恰是 daemon 可能挂掉的时候。既有工作组/席位 trace 仍然有效；选 `--pod` 会在两者之间加入那个上下文域。`--json` 返回结构化结果。

你的读取**就是**这次行走：凭记忆拼出来的 trace 只是背诵，会复刻它本要抓住的漂移。跑它，别回忆它。

## 随包默认值与策展路径

自带工作组（product-team 优先）在适用的实例、工作组、pod、席位高度发布合理默认 chain 文件，在工作组启动时装到 `topology.root` 下。
随包默认是一个**起点**，占用它的团队在上面追加——后续工作组启动绝不覆盖它（已有文件赢）。

把一个新发现的最佳实践加进随包默认值，刻意做得很轻：

1. **发现** —— 这个实践出现在它被挣得的地方：某席位的 `LEARNED.md`、一条现场笔记、一次评审观察。
2. **策展** —— 有人判断它*通用适用*吗（它在陌生人的机器上、在另一个项目里还成立吗）？如果是项目特定的，就留在挣得它的那个高度。
3. **发布** —— 把它加进源码里该工作组的默认 chain 文件（`packages/daemon/specs/rigs/…/topology/`），一行说明动机事件。它在下个发布到达新安装；运行中的工作组只通过显式投递拿到它（见 refocus 通道）——**编辑一个文件不等于投递给一个运行中的席位。**

## 本文件不覆盖什么

chain 文件如何到达一个*运行中*席位（refocus 通道）在 refocus 文档里规定；工作本身的质量门槛在该工作组的 operating-model skill 和文化文件里。
