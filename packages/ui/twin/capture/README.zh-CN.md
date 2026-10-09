# twin:capture——意图/证明产物工具（OPR.0.4.1.11.2）

该工具把 11.1 digital twin（以及实际发布的 UI）转换为视觉“意图 → 证明”约定所需的持久**意图**和**证明**产物。11.1 twin 已经可以为每个界面生成单个自包含 `intent.html`；本工具让捕获和附加成为常规操作，并从截图扩展到适合每种切片媒介、信息密度最高的产物。

## 一条命令完成捕获

```
npm run twin:capture -- \
  --slice opr-0.4.1.11.2 \
  --surface "Topology Graph" \
  --route /topology/rig/rig_delivery \
  --out-root <abs path>/openrig-work/digital-twin
```

| Flag | 必填 | 含义 |
|---|---|---|
| `--slice` | 是 | 切片 id；也是逐切片目录名，保留其中的点，例如 `opr-0.4.1.11.2`。 |
| `--surface` | 是 | 界面/mockup 标签；经 slugify 后成为产物文件 basename。 |
| `--route` | 否（默认 `/`） | 透传 `TWIN_ROUTE`，指定要进入的 twin 界面。 |
| `--out-root` | 是 | `digital-twin/` 根目录，逐切片目录会放在这里。 |
| `--proof-url` | 否 | 构建后：在该 URL 捕获**真实已发布 UI**，作为配对证明（FR-6）。 |
| `--chrome` | 否 | 覆盖 Headless Chrome 二进制路径；未提供时使用 `CHROME_BIN` 或 macOS 默认值。 |

单次运行流程：`twin:build`（TWIN_ROUTE）→ Headless Chrome 截图 → 将产物放入 `digital-twin/<slice-id>/` → 捕获 `change.diff` → 强制执行 **D-1 确定性**检查（截图两次、逐字节比较，发现漂移时明确失败）。每次只处理一个界面，因此 `emptyOutDir` 清理构建输出时不会与产物发生竞争；产物会在同一次运行中复制出去。

## 产物约定（FR-5——由 pm + brief1-curator 批准）

位置：**`digital-twin/<slice-id>/`**——每个切片一个目录；保留带点的切片 id（使用 `opr-0.4.1.11.2`，绝不能写成 `opr-0-4-1-11-2`）。每个界面包含：

| 文件 | 是否持久 | 内容 |
|---|---|---|
| `<surface>.intent.png` | 是 | 意图截图（来自构建前的 twin）。 |
| `<surface>.proof.png` | 是 | 证明截图（来自构建后的真实已发布 UI；FR-6）。 |
| `<surface>.change.diff` | 是 | fixture/variant override diff，即变更的持久核心。 |
| `<surface>.intent.html` | 否 | 可重新生成的单文件原型，无需提交；`twin-out/` 已被 gitignore。 |

**只向前生效。**此约定适用于新的 capture。现有临时集合（`slice-15-batch-N`、`full-harness`、`gate-0`）保持**冻结**，不得重命名或迁移；其中 slice-15 集合仍受正在进行的创始人设计 gate 约束。任何规范化都应作为以后单独的清理工作。

## 媒体（为切片选择信息密度最高的形式）

- **截图**（FR-2）——`twin:capture`、headless Google Chrome、零新增依赖。由于 twin 使用缓存种子数据（无后台服务、无时序波动；D-2），且 Chrome flag 集固定，因此具备确定性（D-1）。确定性会在运行时强制检查，而不是靠假设。
- **CLI / asciicast**（FR-3）——`asciicast.ts` 直接生成有文档说明的 asciicast v2 格式（零依赖），`captureCommandCast` 将命令输出封装成有效 `.cast`。不要求安装 asciinema，且当前主机没有安装；只有需要交互式计时录制时才安装，cast 格式保持一致。绝不能伪造 capture；能力不足时应如实降级。
- **数据 / payload-diff**（FR-4）——`payload-diff.ts` 生成规范化的前后 JSON，以及排序后的变更路径集合，适用于非视觉或数据结构切片。

## 意图与证明——同一种格式，并排比较（FR-6）

意图和证明使用**完全相同**的捕获机制，即同一个 `buildChromeScreenshotArgs`；区别只有 URL：意图使用 `file://` twin，证明使用 `http://` 真实 UI。两者通过相同 basename 配对（`<surface>.intent.png` ↔ `<surface>.proof.png`），因此创始人可以直接比较。

证明标准（OPR.0.4.0.37）：创始人级证明必须来自真实上下文中的**真实** zrig UI，而不是无标签或 stub 环境。因此，证明路径需要正在运行的构建/后台服务，属于**构建后**步骤（`--proof-url`）；默认特意关闭，以保持意图路径不依赖后台服务。

## 范围外（边界）

- twin 本身（11.1）——本工具只负责捕获，不会修改它。`--route`（`TWIN_ROUTE`）是已经证明有效的落地机制；tab landing（`TWIN_TAB`）尚不是已合并的 twin 能力，因此不在范围内。
- IMPL-PRD / brief 模板槽位（11.3）和约定原则（11.4）。
- 动画 / scripted-SSE 视频（已暂缓；twin 只会把 EventSource stub 为种子事件）。
