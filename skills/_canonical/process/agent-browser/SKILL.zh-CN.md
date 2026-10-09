---
name: agent-browser
description: "用于 AI 代理的浏览器自动化 CLI。当用户需要与网站交互时使用，包括导航页面、填写表单、单击按钮、截屏、提取数据、测试 Web 应用程序或自动执行任何浏览器任务。触发器包括“打开网站”、“填写表单”、“单击按钮”、“截取屏幕截图”、“从页面抓取数据”、“测试此 Web 应用程序”、“登录网站”、“自动浏览器操作”或任何需要编程 Web 交互的任务的请求。"
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
metadata:
  openrig:
    vendored_from: "Vercel agent-browser (https://github.com/vercel/agent-browser)"
    vendoring_pattern: add-supplementary-files
    last_upstream_check: "2026-05-13 (initial vendoring declaration)"
    divergence_notes: |
      Upstream SKILL.md content tracks upstream; a small "Local Dev Insights"
      pointer section was added near the end of the body to surface the sibling
      LOCAL-INSIGHTS.md companion file. See OPENRIG.md for the full OpenRig
      relationship to this skill.
---
# 使用 agent-browser 实现浏览器自动化

## 核心工作流程

每个浏览器自动化都遵循以下模式：

1. **导航**：`agent-browser open <url>`
2. **快照**：`agent-browser snapshot -i`（获取 `@e1`、`@e2` 等元素引用）
3. **交互**：使用 ref 点击、填充或选择
4. **重新快照**：导航或 DOM 变化后，获取新的 ref
```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```
## 命令链

命令可以在单个 shell 调用中与 `&&` 链接。浏览器通过后台守护程序在命令之间保持不变，因此链接比单独调用更安全且更有效。
```bash
# Chain open + wait + snapshot in one call
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser screenshot page.png
```
**何时链接：** 当您不需要在继续操作之前读取中间命令的输出时（例如，打开 + 等待 + 屏幕截图），请使用 `&&`。当您需要首先解析输出时（例如，快照以发现引用，然后使用这些引用进行交互），请单独运行命令。

## 基本命令
```bash
# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i -C          # Include cursor-interactive elements (divs with onclick, cursor:pointer)
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser scroll down 500         # Scroll page

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait 2000               # Wait milliseconds

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser pdf output.pdf          # Save as PDF

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --wait-until networkidle  # Custom wait strategy
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element
```
## 常见模式

### 表单提交
```bash
agent-browser open https://example.com/signup
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser select @e3 "California"
agent-browser check @e4
agent-browser click @e5
agent-browser wait --load networkidle
```
### 持久化认证状态
```bash
# Login once and save state
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Reuse in future sessions
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```
### 会话持久化
```bash
# Auto-save/restore cookies and localStorage across browser restarts
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ...
agent-browser close  # State auto-saved to ~/.agent-browser/sessions/

# Next time, state is auto-loaded
agent-browser --session-name myapp open https://app.example.com/dashboard

# Encrypt state at rest
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
agent-browser --session-name secure open https://app.example.com

# Manage saved states
agent-browser state list
agent-browser state show myapp-default.json
agent-browser state clear myapp
agent-browser state clean --older-than 7
```
### 数据提取
```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e5           # Get specific element text
agent-browser get text body > page.txt  # Get all page text

# JSON output for parsing
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```
### 并行会话
```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com

agent-browser --session site1 snapshot -i
agent-browser --session site2 snapshot -i

agent-browser session list
```
### 连接到现有的 Chrome
```bash
# Auto-discover running Chrome with remote debugging enabled
agent-browser --auto-connect open https://example.com
agent-browser --auto-connect snapshot

# Or with explicit CDP port
agent-browser --cdp 9222 snapshot
```
### 可视化浏览器（调试）
```bash
agent-browser --headed open https://example.com
agent-browser highlight @e1          # Highlight element
agent-browser record start demo.webm # Record session
agent-browser profiler start         # Start Chrome DevTools profiling
agent-browser profiler stop trace.json # Stop and save profile (path optional)
```
### 本地文件（PDF、HTML）
```bash
# Open local files with file:// URLs
agent-browser --allow-file-access open file:///path/to/document.pdf
agent-browser --allow-file-access open file:///path/to/page.html
agent-browser screenshot output.png
```
### iOS 模拟器（移动 Safari）
```bash
# List available iOS simulators
agent-browser device list

# Launch Safari on a specific device
agent-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same workflow as desktop - snapshot, interact, re-snapshot
agent-browser -p ios snapshot -i
agent-browser -p ios tap @e1          # Tap (alias for click)
agent-browser -p ios fill @e2 "text"
agent-browser -p ios swipe up         # Mobile-specific gesture

# Take screenshot
agent-browser -p ios screenshot mobile.png

# Close session (shuts down simulator)
agent-browser -p ios close
```
**要求：** 带有 Xcode、Appium (`npm install -g appium && appium driver install xcuitest`) 的 macOS

**真实设备：** 如果预先配置，可与物理 iOS 设备配合使用。使用 `--device "<UDID>"`，其中 UDID 来自 `xcrun xctrace list devices`。

## 比较（验证更改）

执行操作后使用 `diff snapshot` 来验证其是否具有预期效果。这会将当前的可访问性树与会话中拍摄的最后一个快照进行比较。
```bash
# Typical workflow: snapshot -> action -> diff
agent-browser snapshot -i          # Take baseline snapshot
agent-browser click @e2            # Perform action
agent-browser diff snapshot        # See what changed (auto-compares to last snapshot)
```
对于视觉回归测试或监控：
```bash
# Save a baseline screenshot, then compare later
agent-browser screenshot baseline.png
# ... time passes or changes are made ...
agent-browser diff screenshot --baseline baseline.png

# Compare staging vs production
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```
`diff snapshot` 输出使用 `+` 进行添加，使用 `-` 进行删除，类似于 git diff。 `diff screenshot` 生成一个差异图像，其中更改的像素以红色突出显示，以及不匹配百分比。

## 超时和慢速页面

对于本地浏览器，默认的 Playwright 超时为 60 秒。对于速度慢的网站或大页面，请使用显式等待而不是依赖默认超时：
```bash
# Wait for network activity to settle (best for slow pages)
agent-browser wait --load networkidle

# Wait for a specific element to appear
agent-browser wait "#content"
agent-browser wait @e1

# Wait for a specific URL pattern (useful after redirects)
agent-browser wait --url "**/dashboard"

# Wait for a JavaScript condition
agent-browser wait --fn "document.readyState === 'complete'"

# Wait a fixed duration (milliseconds) as a last resort
agent-browser wait 5000
```
当处理持续缓慢的网站时，请在 `open` 之后使用 `wait --load networkidle` 以确保在拍摄快照之前页面已完全加载。如果某个特定元素渲染速度较慢，则直接使用 `wait <selector>` 或 `wait @ref` 等待它。

## 会话管理和清理

同时运行多个代理或自动化时，请始终使用命名会话以避免冲突：
```bash
# Each agent gets its own isolated session
agent-browser --session agent1 open site-a.com
agent-browser --session agent2 open site-b.com

# Check active sessions
agent-browser session list
```
完成后请务必关闭浏览器会话，以避免泄露进程：
```bash
agent-browser close                    # Close default session
agent-browser --session agent1 close   # Close specific session
```
如果先前的会话未正确关闭，守护进程可能仍在运行。在开始新的工作之前，使用`agent-browser close`将其清理干净。

## Ref 生命周期（重要）

页面更改时，引用（`@e1`、`@e2` 等）无效。始终在以下时间后重新拍摄快照：

- 单击导航的链接或按钮
- 提交表单
- 动态内容加载（下拉菜单、模式）
```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```
## 带注释的屏幕截图（视觉模式）

使用 `--annotate` 截取屏幕截图，其中编号标签覆盖在交互元素上。每个标签 `[N]` 映射到引用 `@eN`。这也会缓存引用，因此您可以立即与元素交互，而无需单独的快照。
```bash
agent-browser screenshot --annotate
# Output includes the image path and a legend:
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"
agent-browser click @e2              # Click using ref from annotated screenshot
```
在以下情况下使用带注释的屏幕截图：
- 页面具有未标记的图标按钮或纯视觉元素
- 您需要验证视觉布局或样式
- 存在画布或图表元素（对于文本快照不可见）
- 您需要对元素位置进行空间推理

## 语义定位器（参考的替代）

当 ref 不可用或不可靠时，使用语义定位器：
```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```
## JavaScript 评估（eval）

使用 `eval` 在浏览器上下文中运行 JavaScript。 **Shell 引用可能会损坏复杂的表达式** - 使用 `--stdin` 或 `-b` 来避免出现问题。
```bash
# Simple expressions work with regular quoting
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Alternative: base64 encoding (avoids all shell escaping issues)
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```
**为什么这很重要：** 当 shell 处理您的命令时，内部双引号、`!` 字符（历史扩展）、反引号和 `$()` 都可能在 JavaScript 到达代理浏览器之前损坏它。 `--stdin` 和 `-b` 标志完全绕过 shell 解释。

**经验法则：**
- 单行，无嵌套引号 -> 常规 `eval 'expression'` 带单引号即可
- 嵌套引号、箭头函数、模板文字或多行 -> 使用 `eval --stdin <<'EVALEOF'`
- 编程/生成的脚本 -> 使用 `eval -b` 和 base64

## 配置文件

在项目根目录中创建 `agent-browser.json` 进行持久设置：
```json
{
  "headed": true,
  "proxy": "http://localhost:8080",
  "profile": "./browser-data"
}
```
优先级（从低到高）：`~/.agent-browser/config.json` < `./agent-browser.json` < 环境变量 < CLI 标志。使用 `--config <path>` 或环境变量 `AGENT_BROWSER_CONFIG` 指定自定义配置文件（文件缺失或无效时会报错退出）。所有 CLI 选项映射到 camelCase key（例如 `--executable-path` -> `"executablePath"`）。布尔标志接受 `true`/`false` 值（例如 `--headed false` 会覆盖配置）。用户配置与项目配置中的扩展会合并，而不是相互替换。

## 深入研究文档

|参考|何时使用 |
|------------|-------------|
| [references/commands.md](references/commands.md) |包含所有选项的完整命令参考 |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref 生命周期、失效规则、故障排除 |
| [references/session-management.md](references/session-management.md) |并行会话、状态持久性、并发抓取 |
| [references/authentication.md](references/authentication.md) |登录流程、OAuth、2FA 处理、状态重用 |
| [references/video-recording.md](references/video-recording.md) |记录调试和文档工作流程 |
| [references/profiling.md](references/profiling.md) |用于性能分析的 Chrome DevTools 分析 |
| [references/proxy-support.md](references/proxy-support.md) |代理配置、地理测试、轮换代理 |

## 即用型模板

|模板|描述 |
|----------|-------------|
| [templates/form-automation.sh](templates/form-automation.sh) |表格填写与验证 |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) |登录一次，重用状态 |
| [templates/capture-workflow.sh](templates/capture-workflow.sh) |内容提取与截图|
```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
## 本地开发见解

**重要提示：** 阅读此技能目录中的 `LOCAL-INSIGHTS.md`，了解通过实践使用发现的此上游技能未涵盖的陷阱、更正和测试工作流程。
