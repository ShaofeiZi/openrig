# OpenRig 实例布局

一个 OpenRig 实例把它受管的状态放在一个配置好的 `$OPENRIG_HOME` 下。`zrig daemon start` 以及 daemon 首次直接启动，都会在打开数据库或绑定监听之前，把这套增量布局对齐到一致状态。

```text
$OPENRIG_HOME/
  config.json             # 带类型的实例设置；创建为空对象
  state/                  # 运行时拥有的持久状态
  context/                # 可寻址的上下文库（`context.root`）
    system/
      system-world.yaml   # 选定的基线上下文 + skill 身份
  skills/                 # 受管 skill 目录（`skills.root`）
  workspace/              # 项目工作树（`workspace.root`）
    SPEC.md                # 项目意图
    project.yaml           # 项目上下文与 skill 选择
    workspace.yaml         # 项目位置目录
    .gitignore
    missions/
    exhaust/
  specs/                  # 规范的实例 spec 库
  topology/               # 实例、工作组、pod、席位连续性树
  plugins/                # 已安装的 OpenRig 插件
  run/                    # 进程协调文件
  logs/                   # daemon 和操作日志
  transcripts/            # 持久的逐席位终端转录
  backups/                # 操作员创建的恢复产物
  secrets/                # 本地连接器和主机 secrets
```

初始化器只创建缺失的受管条目。它绝不覆盖已有文件，并在首次写入前检查每条受管路径。类型不对的路径会按其确切位置报错；无关的用户自有内容原样保留。对一个已收敛的实例再跑一次，什么都不写。

workspace 子树由[项目工作区契约](project-workspace.md)拥有。实例初始化器调用那个 owner，而不是再带一份它的文件字节。`skills/` 和 `topology/` 创建为空根；它们各自的目录和拓扑工作流拥有其内容。

## 上下文库设置

可寻址上下文库有一个带类型设置和一个环境变量覆盖：

| 面 | 值 |
| --- | --- |
| 配置键 | `context.root` |
| 环境变量 | `OPENRIG_CONTEXT_ROOT` |
| 默认 | `$OPENRIG_HOME/context` |
| 解析后属性 | `contextRoot` |

已移除的 `context.packs_root`、`context.packsRoot` 和 `OPENRIG_CONTEXT_PACKS_ROOT` 拼写会被拒绝，并提示改用 `context.root`；它们不是兼容别名。bundle 安装和 `zrig context add` 都解析到同一个配置好的落地根。

## System World

System World 是实例范围的基线，在拓扑/角色和 Project World 内容之前选定。它带版本的 manifest 包含有序的 context-pack 引用，外加受管 skill 身份；绝不包含权威的 skill 字节。默认 manifest 以增量方式安装在 `$OPENRIG_HOME/context/system/system-world.yaml`。

| 面 | 值 |
| --- | --- |
| 配置键 | `context.system_world` |
| 环境变量 | `OPENRIG_CONTEXT_SYSTEM_WORLD` |
| 默认 | `default` |
| 解析后属性 | `systemWorld` |

`default` 选择已安装的 manifest；一个安全的相对或绝对路径选择一个显式替代；`disabled` 是显式关闭状态。缺失或畸形的选择会失败；绝不能把"缺失"推断为"关闭"。`zrig context work-install --json` 报告生效状态、来源、manifest、上下文选择器和 skills。加 `--runtime` 时，它受管的 skill 装载随后会把 System World、拓扑和 Project World 选择器按来源合并。

对于 0.5.9 之前的家目录，用 `openrig-upgrade` skill 的 `migrate-telemetry-state-0.5.9.mjs` helper 做一次智能体操作的迁移。顺序是 plan → `--apply-state` → 分别激活目标运行时 → 成对新根采样比任何有界旧尾部都新 → `--verify` → 非破坏性收尾器 `--apply-library`。激活期间，运行时读取者是"规范路径优先、旧路径回退"，自定义上下文库根保持稳定。校验绑定确切接受的尾部字节；收尾重新校验它们，不覆盖地拷贝，最后切配置。它从不删除旧遥测或上下文库。`--rollback` 只撤销 helper 自有的配置、System World、空目录和拷贝库效果。如果无法证明写入者/读取者收敛、恢复的旧写入、字节漂移、冲突或任何迁移自有路径，helper 必须停下，而不是声称成功。`--help` 打印阶段语法而不清点实例；不带任何阶段标志是有意的只读计划，未知选项在计划或变更之前以非零码失败。

## 既有 spec 库

创建 `$OPENRIG_HOME/specs` 不会迁移既有的启动时代 spec。升级过的安装可能仍有一个独立的旧 spec 库，运行时为兼容而读。把"两个家并存"当作一个显式限制：用实时 spec 库命令判断某个 spec 从哪里提供，不要因为规范目录存在就推断已收敛。
