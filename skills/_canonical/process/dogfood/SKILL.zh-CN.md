---
name: dogfood
description: "系统地探索和测试 Web 应用程序以查找错误、UX 问题和其他问题。当被要求“dogfood”、“QA”、“探索性测试”、“查找问题”、“bug 搜寻”、“测试此应用程序/网站/平台”或审查 Web 应用程序的质量时使用。生成一份结构化报告，其中包含完整的重现证据（包括每个问题的分步屏幕截图、重现视频和详细的重现步骤），以便将调查结果直接交给负责的团队。"
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
metadata:
  openrig:
    vendored_from: "Vercel agent-browser ecosystem (https://github.com/vercel/agent-browser)"
    vendoring_pattern: vendored-as-is
    last_upstream_check: "2026-05-13 (diff against ~/.agents/skills/dogfood = identical)"
---
# Dogfood 测试

系统地探索 Web 应用、发现问题，并生成一份为每个问题提供完整复现证据的报告。

## 设置

只要求提供**目标 URL**。其他参数都有合理默认值，除非用户明确覆盖，否则直接使用默认值。

| 参数 | 默认值 | 覆盖示例 |
|------------|---------|-----------------|
| **目标 URL** | _（必填）_ | `vercel.com`、`http://localhost:3000` |
| **会话名称** | 域名转换成的 slug（例如 `vercel.com` -> `vercel-com`） | `--session my-session` |
| **输出目录** | `./dogfood-output/` | `Output directory: /tmp/qa` |
| **范围** | 完整应用 | `Focus on the billing page` |
| **身份验证** | 无 | `Sign in to user@example.com` |

如果用户说“dogfood vercel.com”之类的内容，请立即使用默认值开始。除非提到身份验证但缺少凭据，否则不要提出澄清问题。

始终直接使用 `agent-browser`，不要使用 `npx agent-browser`。直接执行文件使用速度更快的 Rust 客户端；`npx` 会经由 Node.js，明显更慢。

## 工作流程
```
1. Initialize    Set up session, output dirs, report file
2. Authenticate  Sign in if needed, save state
3. Orient        Navigate to starting point, take initial snapshot
4. Explore       Systematically visit pages and test features
5. Document      Screenshot + record each issue as found
6. Wrap up       Update summary counts, close session
```
### 1. 初始化
```bash
mkdir -p {OUTPUT_DIR}/screenshots {OUTPUT_DIR}/videos
```
将报告模板复制到输出目录并填写标题字段：
```bash
cp {SKILL_DIR}/templates/dogfood-report-template.md {OUTPUT_DIR}/report.md
```
启动命名会话：
```bash
agent-browser --session {SESSION} open {TARGET_URL}
agent-browser --session {SESSION} wait --load networkidle
```
### 2. 身份验证

如果应用程序需要登录：
```bash
agent-browser --session {SESSION} snapshot -i
# Identify login form refs, fill credentials
agent-browser --session {SESSION} fill @e1 "{EMAIL}"
agent-browser --session {SESSION} fill @e2 "{PASSWORD}"
agent-browser --session {SESSION} click @e3
agent-browser --session {SESSION} wait --load networkidle
```
对于 OTP/电子邮件代码：询问用户，等待他们的响应，然后输入代码。

成功登录后，保存状态以供将来重用：
```bash
agent-browser --session {SESSION} state save {OUTPUT_DIR}/auth-state.json
```
### 3. 熟悉产品

获取初始带注释的屏幕截图和快照以了解应用程序结构：
```bash
agent-browser --session {SESSION} screenshot --annotate {OUTPUT_DIR}/screenshots/initial.png
agent-browser --session {SESSION} snapshot -i
```
识别主要导航元素，并列出需要访问的区域。

### 4. 探索

请阅读 [references/issue-taxonomy.md](references/issue-taxonomy.md)，了解要寻找的内容和探索清单的完整列表。

**策略——系统地使用应用程序：**

- 从主导航开始。访问每个顶级部分。
- 在每个区域中测试交互元素：点击按钮、填写表单、打开下拉菜单和模态框。
- 检查边缘情况：空状态、错误处理、边界输入。
- 尝试真实的端到端工作流程（创建、编辑、删除流程）。
- 定期检查浏览器控制台是否有错误。

**每页：**
```bash
agent-browser --session {SESSION} snapshot -i
agent-browser --session {SESSION} screenshot --annotate {OUTPUT_DIR}/screenshots/{page-name}.png
agent-browser --session {SESSION} errors
agent-browser --session {SESSION} console
```
根据判断决定探索深度。把更多时间投入核心功能，减少在外围页面上的时间。如果某一区域集中出现多个问题，则深入调查。

### 5. 记录问题（复现优先）

第 4 步和第 5 步同时进行——一次完成探索和记录。当您发现问题时，请停止探索并立即将其记录下来，然后再继续。不要先探索整个应用程序，然后再记录。

每个问题都必须能够复现。发现问题后，不要只做文字记录，还要用证据证明。目标是让报告读者能准确看到发生了什么，并重放整个过程。

**为该问题选择正确的证据级别：**

#### 交互/行为问题（功能、用户体验、控制台操作错误）

这些需要用户交互来重现 - 使用带有视频和分步屏幕截图的完整重现：

1. **复现前开始录制视频**：
```bash
agent-browser --session {SESSION} record start {OUTPUT_DIR}/videos/issue-{NNN}-repro.webm
```
2. **按照人的节奏完成各个步骤。** 在操作之间暂停 1-2 秒，以便可以观看视频。每一步都截图：
```bash
agent-browser --session {SESSION} screenshot {OUTPUT_DIR}/screenshots/issue-{NNN}-step-1.png
sleep 1
# Perform action (click, fill, etc.)
sleep 1
agent-browser --session {SESSION} screenshot {OUTPUT_DIR}/screenshots/issue-{NNN}-step-2.png
sleep 1
# ...continue until the issue manifests
```
3. **捕获异常状态。** 稍作停顿，让观看者看清问题，然后拍摄带注释的截图：
```bash
sleep 2
agent-browser --session {SESSION} screenshot --annotate {OUTPUT_DIR}/screenshots/issue-{NNN}-result.png
```
4. **停止视频：**
```bash
agent-browser --session {SESSION} record stop
```
5. 在报告中写下编号的重现步骤，每个步骤都引用其屏幕截图。

#### 静态/加载时可见问题（拼写错误、占位符文本、剪切文本、未对齐、加载时控制台错误）

这些问题无需交互就能看到——一张带注释的截图即可，无需视频和多步复现：
```bash
agent-browser --session {SESSION} screenshot --annotate {OUTPUT_DIR}/screenshots/issue-{NNN}.png
```
写下简短的描述并参考报告中的屏幕截图。将 **Repro Video** 设置为 `N/A`。

---

**对于所有问题：**

1. **立即追加到报告。** 不要留到之后批量整理。发现一个就记录一个，这样即使会话中断也不会丢失。

2. **增加问题计数器**（ISSUE-001、ISSUE-002，...）。

### 6. 总结

目标是找到 **5–10 个证据完备的问题**，然后收尾。证据深度比问题总数更重要——5 个完整复现的问题胜过 20 个描述含糊的问题。

经过探索：

1. 重新阅读报告并更新摘要严重性计数，使其与实际问题相符。每个 `### ISSUE-` 块都必须反映在总数中。
2. 关闭会话：
```bash
agent-browser --session {SESSION} close
```
3. 告诉用户报告已准备就绪并总结结果：问题总数、按严重性细分以及最关键的项目。

## 指导

- **复现至关重要。** 每个问题都需要证据，但证据形式应与问题匹配。交互式 bug 需要视频和分步截图；静态问题（错别字、占位文本、加载即出现的视觉问题）只需一张带注释截图。
- **收集证据前先验证可复现性。** 在录制视频或截图前，至少重试一次以确认问题能够稳定复现。无法稳定复现的现象不能算作有效问题。
- **不要为静态问题录制视频。** 拼写错误或剪辑的文本不会从视频中受益。保存涉及用户交互、计时或状态更改的问题的视频。
- **对于交互问题，请对每个步骤进行屏幕截图。** 捕获之前、操作和之后的信息 - 这样人们就可以看到完整的序列。
- **编写映射到屏幕截图的重现步骤。** 报告中的每个编号步骤应引用其相应的屏幕截图。读者应该能够在不接触浏览器的情况下直观地遵循这些步骤。
- **使用正确的快照命令。**
  - `snapshot -i` — 用于查找可点击/可填充元素（按钮、输入、链接）
  - `snapshot`（无标志）——用于读取页面内容（文本、标题、数据列表）
- **既要全面，也要判断取舍。** 这不是照着测试脚本机械执行，而是像真实用户一样探索。任何不对劲的地方都值得调查。
- **持续记录发现。** 每发现一个问题就追加到报告，使会话中断时结果仍能保留。不要到最后才批量记录。
- **切勿删除输出文件。** 不要在会话中`rm` 屏幕截图、视频或报告。不要关闭会话并重新启动。向前努力，而不是向后努力。
- **永远不要阅读目标应用程序的源代码。**您正在以用户身份进行测试，而不是审核代码。不要读取被测应用的HTML、JS或配置文件。所有发现都必须来自您在浏览器中观察到的内容。
- **检查控制台。** 许多问题在 UI 中是不可见的，但显示为 JS 错误或失败的请求。
- **像用户一样测试，而不是机器人。** 端到端尝试常见的工作流程。单击真实用户会单击的内容。输入实际数据。
- **像人类一样打字。** 在视频录制期间填写表单字段时，请使用 `type` 而不是 `fill` - 它逐个字符地键入。仅当速度很重要时，才在视频录制之外使用 `fill`。
- **让复现视频适合人观看。** 操作之间加入 `sleep 1`，最终结果截图前加入 `sleep 2`。视频应当能以 1 倍速清楚观看——审查者需要看清发生了什么，而不是一连串瞬间切换。
- **高效使用命令。** 当多个 `agent-browser` 命令独立时，在单个 shell 调用中批处理多个命令（例如，`agent-browser ... screenshot ... && agent-browser ... console`）。使用 `agent-browser --session {SESSION} scroll down 300` 进行滚动 - 不要使用 `key` 或 `evaluate` 进行滚动。

## 参考文献

|参考|何时阅读 |
|------------|--------------|
| [references/issue-taxonomy.md](references/issue-taxonomy.md) |会议开始——校准要寻找的内容、严重程度、探索清单|

## 模板

|模板|目的|
|----------|---------|
| [templates/dogfood-report-template.md](templates/dogfood-report-template.md) |复制到输出目录作为报告文件 |
