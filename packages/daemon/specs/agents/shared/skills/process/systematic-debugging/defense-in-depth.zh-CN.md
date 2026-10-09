# 纵深防御验证

## 概述

修复由无效数据造成的缺陷时，只在一个位置添加验证似乎已经足够。但不同代码路径、重构或 mock 都可能绕过这项检查。

**核心原则：**在数据经过的每一层都进行验证，让缺陷从结构上不可能发生。

## 为什么需要多层验证

单层验证：“我们修复了缺陷。”
多层验证：“我们让缺陷无法发生。”

不同层负责捕获不同情况：
- 入口验证捕获大多数缺陷
- 业务逻辑捕获边界情况
- 环境防护避免特定上下文中的危险
- 调试日志在其他层失效时帮助排查

## 四个层级

### 第 1 层：入口点验证
**目的：**在 API 边界拒绝明显无效的输入

```typescript
function createProject(name: string, workingDirectory: string) {
  if (!workingDirectory || workingDirectory.trim() === '') {
    throw new Error('workingDirectory cannot be empty');
  }
  if (!existsSync(workingDirectory)) {
    throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
  }
  if (!statSync(workingDirectory).isDirectory()) {
    throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
  }
  // ... 继续处理
}
```

### 第 2 层：业务逻辑验证
**目的：**确保数据对于当前操作具有合理含义

```typescript
function initializeWorkspace(projectDir: string, sessionId: string) {
  if (!projectDir) {
    throw new Error('projectDir required for workspace initialization');
  }
  // ... 继续处理
}
```

### 第 3 层：环境防护
**目的：**防止在特定上下文中执行危险操作

```typescript
async function gitInit(directory: string) {
  // 测试期间，拒绝在临时目录之外执行 git init
  if (process.env.NODE_ENV === 'test') {
    const normalized = normalize(resolve(directory));
    const tmpDir = normalize(resolve(tmpdir()));

    if (!normalized.startsWith(tmpDir)) {
      throw new Error(
        `Refusing git init outside temp dir during tests: ${directory}`
      );
    }
  }
  // ... 继续处理
}
```

### 第 4 层：调试插桩
**目的：**捕获用于取证的上下文

```typescript
async function gitInit(directory: string) {
  const stack = new Error().stack;
  logger.debug('About to git init', {
    directory,
    cwd: process.cwd(),
    stack,
  });
  // ... 继续处理
}
```

## 应用此模式

发现缺陷时：

1. **追踪数据流**——错误值源自何处？在哪里使用？
2. **绘制所有检查点**——列出数据经过的每个位置
3. **在每一层添加验证**——入口、业务、环境、调试
4. **测试每一层**——尝试绕过第 1 层，确认第 2 层能够捕获

## 会话中的示例

缺陷：空 `projectDir` 导致在源码中执行 `git init`

**数据流：**
1. 测试设置 → 空字符串
2. `Project.create(name, '')`
3. `WorkspaceManager.createWorkspace('')`
4. `git init` 在 `process.cwd()` 中运行

**添加的四层防护：**
- 第 1 层：`Project.create()` 验证非空、存在且可写
- 第 2 层：`WorkspaceManager` 验证 projectDir 非空
- 第 3 层：NODE_ENV 防护拒绝测试期间在 tmpdir 之外执行 git init
- 第 4 层：git init 前记录 stack trace

**结果：**全部 1847 项测试通过，缺陷无法复现

## 关键认识

四层全部必需。测试期间，每一层都捕获了其他层遗漏的缺陷：
- 不同代码路径绕过了入口验证
- Mocks 绕过了业务逻辑检查
- 不同平台上的边界情况需要环境防护
- 调试日志识别出结构性误用

**不要停在单一验证点。**在每一层都添加检查。
