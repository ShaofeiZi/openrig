# 后台服务停止时的故障诊断 E2E + LOOK gate（主机端、真实运行）

本手册用于端到端证明整个后台服务停止时的操作界面：包括 `zrig crash-cart --json` 动词（真实检测器 + C2 读取）以及渲染该结果的 TUI，并生成 LOOK-gate capture drop，供 PM 与 Mock-2（3d3c90a0）比较。全程只读，绝不能 push。

## 构建前提（该动词在进程内运行）

```bash
npm run build -w packages/daemon   # 生成 dist，包括 crash-cart-surface.d.ts（CLI 子路径从这里解析）
npm run build -w packages/cli      # zrig bin
npm run build -w packages/tui      # openrig-tui bin
```

## L1——动词：DOWN + discovery（关键链路）

启动一个 stub 工作组，然后**停止**后台服务（down = daemon.json 存在、pid 已停止、DB 留在磁盘）：

```bash
export OPENRIG_HOME="$(mktemp -d)/.openrig"; mkdir -p "$OPENRIG_HOME"
zrig daemon start --db "$OPENRIG_HOME/openrig.sqlite" --no-kernel   # 随后启动一个 stub 工作组（在 stub 工作区中执行 zrig up）
zrig daemon stop                                                     # 后台服务 DOWN；daemon.json + DB 保留
zrig crash-cart --json | tee cc-down.json
```

**PASS：**JSON 为 `{ "state": "down", "discovery": { header{lastActivityAt…}, foundOnHost:[{rigName,seatCount,resumableCount,…}], whereWorkStopped:[…] } }`。header 中的 `stopReason`/`priorUptimeMs` 为 `null`，这是诚实结果，因为没有 shutdown record。**只读证明：**分别捕获 `openrig.sqlite`/`-wal`/`-shm` 在操作前后的 sha256，两者应逐字节相同，因为 copy-then-read 从未修改它们。

**FAIL：**该动词从在线后台服务渲染数据（此时应拒绝并返回 `refusal`），或修改 DB。

## L2——动词：UNVERIFIED（卡住的后台服务绝不能显示为 DOWN）

使用 pid 存活但 `/healthz` 挂起的后台服务，或将 `OPENRIG_URL` 指向黑洞端口：

```bash
OPENRIG_URL="http://127.0.0.1:9  " zrig crash-cart --json    # 目标会超时，而不是拒绝连接
```

**PASS：**返回 `{ "state": "unverified", "evidence": { pidState, probeResult:"timeout", failedSignal } }`，不包含 discovery，也不显示操作界面。**FAIL：**将 timeout 提升为 `down`。

## L3——动词：首次运行（DOWN + 无 DB → 入门，而非崩溃）

使用全新的 `OPENRIG_HOME`（无 daemon.json、无 DB），执行 `zrig crash-cart --json`。

**PASS：**返回 `{ "state": "down", "discovery": { foundOnHost: [] , header{lastActivityAt:null} } }`，TUI 显示下述首次运行界面，绝不能显示崩溃 header。

## L4——TUI 渲染 + LOOK-gate capture drop

在固定 viewport（120x32）的 tmux 中启动裸 `zrig`（后台服务停止），等待探测，然后捕获 pane：

```bash
tmux new-session -d -x 120 -y 32 -s cc 'OPENRIG_HOME='"$OPENRIG_HOME"' zrig'   # 裸 zrig → TUI → 探测 crash-cart
sleep 2; tmux capture-pane -t cc -e -p > cc-live-cockpit.ans; tmux kill-session -t cc
```

**PASS：**pane 显示操作界面，按 header（包括如实显示为 null 的 uptime/reason 位置）→ FOUND ON THIS HOST → WHERE WORK STOPPED → `⏎ RESTORE EVERYTHING` + `s/i/n` 操作行的顺序排列；结构、顺序和强调方式与 Mock 2 一致。

### 确定性 LOOK-gate drop（PM Mock-2 对比）——作为内置能力提供

```bash
node --import tsx packages/tui/scripts/capture-crash-cart.mjs \
  "$OPENRIG_WORKSPACE/artifacts/crash-cart-captures"   # 3 个屏幕（.ans + .txt）+ SHA256SUMS
```

输出 `cockpit-populated`、`unverified` 和 `first-run`（`.ans` 是真实终端字节，可用 `cat` 查看；`.txt` 是纯文本），以及 `SHA256SUMS`。该过程是**确定性的**（使用固定 fixture + truecolor）：再次运行会生成逐字节一致的 hash。PM 将每个 `.ans` 与 **APPROVED-MOCKS-pulse-view-crash-cart-2026-08-05-source.html Mock 2** 比较；结构、顺序和强调方式由 PM 检查，mock 之外的品味问题属于创始人停止类别。（实时 L4 tmux capture 应与这些 capture 一致。）

## 边界

全程只读；操作界面仅在 DOWN 状态可用；UNVERIFIED 绝不提供恢复操作；恢复（RESTORE → C1 batch）是有明确标记的 seam，本轮不包含 C1；该动词绝不修改状态。绝不能 push。
