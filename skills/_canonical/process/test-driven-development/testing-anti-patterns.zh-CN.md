# 测试反模式

**以下情况加载此参考：**编写或修改测试、添加 mocks，或想在生产代码中添加仅供测试使用的方法时。

## 概述

测试必须验证真实行为，而不是 mock 行为。Mocks 是隔离手段，不是测试对象。

**核心原则：**测试代码的实际行为，而不是 mocks 的行为。

**严格遵循 TDD 可以避免这些反模式。**

## 铁律

```
1. 绝不测试 mock 行为
2. 绝不向生产类添加仅供测试使用的方法
3. 不理解依赖时绝不 mock
```

## 反模式 1：测试 Mock 行为

**违规示例：**
```typescript
// ❌ 错误：测试 mock 是否存在
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**错误原因：**
- 你验证的是 mock 是否工作，而非组件是否工作
- mock 存在时测试通过，不存在时失败
- 无法说明真实行为

**人类伙伴的纠正：**“我们是在测试 mock 的行为吗？”

**修复：**
```typescript
// ✅ 正确：测试真实组件，或不要 mock 它
test('renders sidebar', () => {
  render(<Page />);  // 不 mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// 或者，如果为了隔离必须 mock sidebar：
// 不要断言 mock——测试 sidebar 存在时 Page 的行为
```

### 门禁函数

```
断言任何 mock 元素前：
  询问：“我是在测试真实组件行为，还是只测试 mock 是否存在？”

  如果只测试 mock 是否存在：
    停止——删除断言，或取消组件 mock

  改为测试真实行为
```

## 反模式 2：生产代码中的仅测试方法

**违规示例：**
```typescript
// ❌ 错误：destroy() 只在测试中使用
class Session {
  async destroy() {  // 看起来像生产 API！
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... 清理
  }
}

// 测试中
afterEach(() => session.destroy());
```

**错误原因：**
- 仅测试代码污染生产类
- 如果在生产环境中误调用，会很危险
- 违反 YAGNI 与关注点分离原则
- 混淆对象生命周期和实体生命周期

**修复：**
```typescript
// ✅ 正确：测试工具负责测试清理
// Session 没有 destroy()——它在生产环境中无状态

// test-utils/ 中
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// 测试中
afterEach(() => cleanupSession(session));
```

### 门禁函数

```
向生产类添加任何方法前：
  询问：“它是否只被测试使用？”

  如果是：
    停止——不要添加
    改放入测试工具

  询问：“这个类是否拥有该资源的生命周期？”

  如果否：
    停止——该方法不属于这个类
```

## 反模式 3：不理解就 Mock

**违规示例：**
```typescript
// ❌ 错误：Mock 破坏测试逻辑
test('detects duplicate server', () => {
  // Mock 阻止了测试依赖的配置写入！
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // 本应抛出错误——但不会！
});
```

**错误原因：**
- 被 mock 的方法具有测试依赖的副作用（写入配置）
- 为了“安全”过度 mock，反而破坏真实行为
- 测试因错误原因通过，或以难以解释的方式失败

**修复：**
```typescript
// ✅ 正确：在正确层级 Mock
test('detects duplicate server', () => {
  // Mock 缓慢部分，保留测试需要的行为
  vi.mock('MCPServerManager'); // 只 mock 缓慢的 server 启动

  await addServer(config);  // 配置已写入
  await addServer(config);  // 检测到重复 ✓
});
```

### 门禁函数

```
Mock 任何方法前：
  停止——先不要 mock

  1. 询问：“真实方法有哪些副作用？”
  2. 询问：“测试是否依赖其中任何副作用？”
  3. 询问：“我是否完全理解测试需要什么？”

  如果依赖副作用：
    在更低层级 mock（真正缓慢/外部的操作）
    或使用保留必要行为的 test doubles
    不要 mock 测试依赖的高层方法

  如果不确定测试依赖什么：
    先用真实实现运行测试
    观察实际需要发生什么
    然后在正确层级添加最小 mock

  危险信号：
    - “为了安全，我来 mock 它”
    - “这可能很慢，最好 mock”
    - 不理解依赖链就 mock
```

## 反模式 4：不完整的 Mocks

**违规示例：**
```typescript
// ❌ 错误：局部 mock——只包含你认为需要的字段
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // 缺少：下游代码使用的 metadata
};

// 后续：代码访问 response.metadata.requestId 时失败
```

**错误原因：**
- **局部 mocks 会隐藏结构假设**——你只 mock 自己知道的字段
- **下游代码可能依赖遗漏字段**——静默失败
- **测试通过但集成失败**——mock 不完整，真实 API 完整
- **虚假信心**——测试无法证明真实行为

**铁律：**按照现实中的完整数据结构创建 mock，而不是只提供当前测试使用的字段。

**修复：**
```typescript
// ✅ 正确：镜像真实 API 的完整性
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // 包含真实 API 返回的所有字段
};
```

### 门禁函数

```
创建 mock 响应前：
  检查：“真实 API 响应包含哪些字段？”

  操作：
    1. 检查文档/示例中的真实 API 响应
    2. 包含系统下游可能使用的所有字段
    3. 验证 mock 与真实响应 schema 完全一致

  关键：
    创建 mock 时，必须理解完整结构
    代码依赖遗漏字段时，局部 mocks 会静默失效

  如不确定：包含所有已记录字段
```

## 反模式 5：把集成测试当作事后工作

**违规示例：**
```
✅ 实现完成
❌ 没有编写测试
“可以测试了”
```

**错误原因：**
- 测试是实现的一部分，不是可选后续工作
- TDD 本可以发现这一点
- 没有测试就不能声称完成

**修复：**
```
TDD 循环：
1. 编写失败测试
2. 实现并使其通过
3. 重构
4. 然后才能声称完成
```

## Mocks 何时过于复杂

**危险信号：**
- Mock 设置比测试逻辑更长
- 为了让测试通过而 mock 一切
- Mocks 缺少真实组件拥有的方法
- Mock 一变化，测试就失败

**人类伙伴的问题：**“这里真的需要使用 mock 吗？”

**考虑：**使用真实组件的集成测试通常比复杂 mocks 更简单。

## TDD 如何防止这些反模式

**TDD 有效的原因：**
1. **先写测试** → 迫使你思考实际在测试什么
2. **观察它失败** → 确认测试验证的是真实行为，而非 mocks
3. **最小实现** → 不会混入仅测试方法
4. **真实依赖** → 在 mock 前先看到测试实际需要什么

**如果你正在测试 mock 行为，就违反了 TDD**——你没有先观察测试针对真实代码失败，就添加了 mocks。

## 快速参考

| 反模式 | 修复 |
|--------|------|
| 断言 mock 元素 | 测试真实组件，或取消 mock |
| 生产代码中仅测试方法 | 移入测试工具 |
| 不理解就 mock | 先理解依赖，最小化 mock |
| 不完整 mocks | 完整镜像真实 API |
| 测试成为事后工作 | TDD——测试优先 |
| 过于复杂的 mocks | 考虑集成测试 |

## 危险信号

- 断言检查 `*-mock` test IDs
- 方法只在测试文件中调用
- Mock 设置占测试的 50% 以上
- 移除 mock 时测试失败
- 无法解释为什么需要 mock
- “为了安全”而 mock

## 底线

**Mocks 是用于隔离的工具，不是测试对象。**

如果 TDD 暴露出你正在测试 mock 行为，说明方向错了。

修复方式：测试真实行为，或重新思考为什么需要 mock。
