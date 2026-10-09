---
name: openrig-upgrade
description: 当智能体准备或执行 OpenRig CLI/后台服务升级，并且必须保留运行中的席位、验证每一次变更，或在不覆盖本地工作的前提下协调托管插件与 skill 文件时使用。
metadata:
  cli_surfaces_referenced:
    - capture
    - daemon start
    - daemon status
    - daemon stop
    - plugin list
    - ps
    - restore-check
    - snapshot
    - version
  openrig:
    stage: factory-approved
    sibling_skills:
      - openrig-user
      - openrig-operator
      - forming-an-openrig-mental-model
---

# 升级 OpenRig

升级是一套由智能体观察并推进的工作流，不是隐藏在一条命令背后的事务。主机之间存在差异，进程状态会漂移，本地插件文件会不断积累，而某一步失败后应该如何响应，取决于当时哪些部分仍在运行。

**智能体负责整个顺序。每次变更后都要停下来观察实际效果，再决定下一步。** 因此系统有意不提供端到端的升级子命令。

## 安全模型

保持以下平面相互分离：

- 席位通常运行在 tmux 中，可以在后台服务重启期间继续存活。
- 后台服务、数据库、包装脚本和托管插件投影构成正在变更的控制平面。
- `zrig down` 会拆除席位，不属于保持连续性的升级流程。

执行任何操作前，先明确哪些工作组和席位的连续性必须保留。在生产主机上，应遵循该主机的常规操作员流程。在便于恢复的构建 VM 上，编排者可以直接采用已测试的运行时，但仍必须观察每一步，并在出现无法解释的漂移时停止。

## 恢复跨越实例边界时

任一执行路径变更运行时状态之前，都要记录一个带主机限定的执行者，并显式选择拥有恢复裁定的队列存储。说明原 owner 是继续、等待还是移交；另一个存储中的开放义务并不等于独占持有本次裁定。如果原存储已停止运行，应在仍存活的裁定记录中保留原 owner 的处置方式，并在竞争执行者采取行动前通知该 owner。

认领被拒绝意味着：在继续执行任何运行时操作前，必须与裁定 owner 协调所有权；它不允许你沿用另一条更旧的记录继续操作。返回记录必须写出执行者完整地址和经过有意选择的存储。恢复工作前，应在该处读取最终记录，包括 source、destination、body 和原 owner 的处置方式。仅仅创建回执并不能证明等待中的执行路径已经收到或接受移交。

## 操作循环

每一步都执行：

1. **检查。** 从当前主机推导实时事实。
2. **决策。** 选择一个有界变更，并说明预期效果。
3. **只执行一次。** 不要把下一项变更捆绑进来。
4. **观察。** 检查这一步可能改变的进程、监听器、数据库、插件和席位入口。
5. **继续、调整或停止。** 预期落空是提供给智能体的信息，不是盲目重试的许可。

## 有界辅助工具

令 `SKILL_DIR` 表示此 `SKILL.md` 所在目录。以下脚本输出 JSON，但不会代替智能体决定升级顺序。

### 检查当前事实

```bash
node "$SKILL_DIR/scripts/inspect-upgrade.mjs"
```

该脚本向已安装的 `zrig` 查询版本、后台服务状态、节点清单和插件清单。缺失的入口会保持可见，并附带建议的下一项探测。`ready: false` 表示智能体必须解决该缺口，或有意识地界定它；不表示脚本应该修改任何内容。

### 备份 SQLite

先创建连续性快照：

```bash
zrig snapshot <rig-id>
node "$SKILL_DIR/scripts/backup-sqlite.mjs" \
  --source "$OPENRIG_HOME/openrig.sqlite" \
  --destination "/safe/path/openrig-before-upgrade.sqlite"
```

辅助工具拒绝覆盖目标文件，使用 SQLite 的备份操作，并通过 `PRAGMA integrity_check` 验证备份。它不会停止后台服务，也不会恢复数据库。

### 规划或应用安全的托管插件刷新

插件树可能同时包含 skill、hook 和元数据。比较上一个已打包祖先、目标包和实时安装树：

```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor /path/to/previous/package/plugin \
  --target /path/to/target/package/plugin \
  --live "$OPENRIG_HOME/plugins/<plugin>"
```

审查排序后的决策。若只应用 `refresh-safe` 和 `add-safe` 文件：

```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor /path/to/previous/package/plugin \
  --target /path/to/target/package/plugin \
  --live "$OPENRIG_HOME/plugins/<plugin>" \
  --apply-safe
```

辅助工具绝不会删除实时文件，也不会覆盖本地修改。它会报告本地删除、仅存在于实时树的文件、目标删除和类型不明确的条目，交由智能体解决。手动解决任何问题后，应重新运行规划。

### 迁移 0.5.9 之前的实例布局

0.5.9 版将 context-usage 遥测放在 `$OPENRIG_HOME/state/context-usage`，将提供方遥测放在 `state/provider-usage`，将可寻址库放在 `context/` 下，并将默认 System World 放在 `context/system/system-world.yaml`。已有的 0.5.8 主目录通过**智能体操作迁移**跨越这一边界：目标运行时读取时优先使用 canonical 路径、回退到 legacy 路径，而所有新写入都使用 canonical 状态根目录。显式配置的自定义 context-library 根目录在整个激活过程中保持不变。

辅助工具提供有界、可检查的操作。智能体负责它们的执行顺序，以及夹在这些操作之间的目标运行时激活。指定准确且受保护的 preimage 路径后，先检查，再准备 canonical 目录、默认 System World，并在配置中固定现有库。准备阶段不会复制遥测、重写实时收集器设置，也不会执行生命周期操作。

`--help` 会直接打印阶段语法，不盘点实例。不带阶段标志时，辅助工具会有意运行只读规划；未知选项会在规划或变更前以非零状态退出。

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --help

node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME"

node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --apply-state \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before"
```

按常规升级工作流激活准确的目标运行时。随后等待每一个有界的 apply 后 legacy 尾样本，都在同一席位的新根目录中出现时间更晚的配对样本。这能在不全量替换进程的前提下证明时间收敛；之后若再出现 legacy 写入，仍必须立即停止。保存验证 JSON；复制的旧 sidecar 不能充当证据：

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --verify \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before" \
  > /safe/path/layout-0.5.9-verify.json
```

只有成功回执才会授权单独调用非破坏性收尾程序。该程序把未配置的 legacy 库复制到 canonical 根目录，并且不会覆盖任何内容；自定义 context-library 根目录仍保持不变：

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --apply-library \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before" \
  --verification /safe/path/layout-0.5.9-verify.json
```

遇到任何报告的问题都应停止：格式异常或外来遥测、保留路径冲突、库冲突、配置漂移、恢复的 legacy 写入、字节漂移或缺失新的双份样本，都必须先按所指明的方法修复再继续。验证会把准确的已接受尾部字节与对应的较新样本绑定；收尾程序会在切换配置前立即重新验证它们。辅助工具绝不会移除 legacy 遥测或库。只有在运行时、写入方、读取方和恢复验证稳定后，智能体才能单独决定之后是否将它们退役。该工具不会停止/启动后台服务、启动席位、修改数据库，也不会决定是否继续升级。

若要恢复，应先按智能体主导工作流的要求恢复原运行时，然后仅撤销辅助工具负责的配置、System World、空目录和已复制库影响。真实状态样本和两个 legacy 恢复源都保留供检查：

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --rollback "$OPENRIG_HOME/backups/layout-0.5.9-before"
```

## 智能体主导的连续性升级

这是一份决策指南，不是照抄命令的操作手册。请根据面前的主机调整路径与检查。

1. 使用辅助工具检查当前 CLI、后台服务、节点和插件。
2. 为活动工作建立检查点，并记录需要保护的准确 tmux/会话清单。
3. 对每个受保护工作组运行 `zrig snapshot <rig-id>`。
4. 创建并验证 SQLite 备份。
5. 单独构建或准备目标运行时。在接触实时后台服务前，证明其版本和来源身份。
6. 运行 `zrig daemon stop`。确认监听器和已识别后台服务进程均已消失。如果命令返回后任一对象仍存在，立即停止：检查身份，并使用该主机已获授权的恢复流程。不要盲目向 PID 发送信号。
7. 使用 `zrig daemon start` 或主机已有的已知包装器启动目标。验证后台服务状态、进程路径、监听器、版本和数据库完整性。
8. 以规划模式运行插件刷新辅助工具。只有在三个根目录及其分类均合理后才应用安全写入；必要时逐个解决保留路径。
9. 使用 `zrig ps --nodes -A --json`、有代表性的 `zrig capture`，以及适用时的 `zrig restore-check` 验证受保护席位。必须带 `-A`：不带时节点读取只覆盖**当前**工作组，而后台服务升级要保护主机上的所有工作组；狭窄形式可能在其他工作组席位漏检时仍报告成功。
10. 只有在推导出该主机如何管理包装器后才进行对齐。沿用其现有机制；本 skill 不重写启动器。
11. 记录观察到的结果、尚待决定的本地保留项，以及准确的回滚运行时与备份。

## 应停止并交还的情形

- 升级前发现受保护的 tmux 会话缺失；
- 数据库完整性或备份验证失败；
- 运行中的进程或监听器与预期运行时不符；
- 后台服务停止命令报告成功，但已识别进程或监听器仍存在；
- 目标无法基于现有数据库启动；
- 无法把插件根目录关联到已知祖先与目标；
- 必需的插件路径被分类为本地修改或删除，但正确的所有权决策不明确；
- 继续操作需要执行 `zrig down`、破坏性恢复、修改凭据，或需要超出操作员权限的授权。

停止时，应报告最后一个已证明正常的状态、第一个未满足的预期、准确证据，以及 owner 需要做出的最小决策。除非恢复明确要求，否则保留实时席位和数据库。

## 回滚也由智能体主导

优先让上一个已知正常的运行时继续使用仍有效的数据库。只有迁移或损坏发现确实要求时才恢复数据库备份；仅仅投影降级不足以证明应替换数据库。回滚后，重复前进路径中使用的同一组进程、监听器、数据库、插件和席位观察。
