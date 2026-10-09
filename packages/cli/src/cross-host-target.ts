import { loadHostRegistry, resolveHost } from "./host-registry.js";
import { loadHostBindings, describeBindingConflict, type HostBindingsFile } from "./host-bindings.js";

/**
 * OPR.0.4.6.MH4 §4 — 主机限定目标简写 + 优先级契约，
 * 在跨主机协调动词间统一（send / capture / transcript；
 * broadcast 没有会话目标操作数——它的位置参数是消息文本，
 * 绝不能被简写解析——因此只接受 `--host` + 持久化选择）。
 *
 * 简写解析规则（仅 CLI 端——BR-1：后台服务无论如何都不会看到三段式
 * 会话字符串）：
 *   - 形如 `X@Y@Z` 的目标，当 `Z` 在注册表加载后匹配一个已注册的
 *     主机 id 时，才是主机限定的；此时 target=`X@Y`，host=`Z`。
 *   - 如果 `Z` 不匹配任何已注册主机（或注册表无法加载），字符串原样
 *     透传——它会像今天一样失败（包含 `@` 的已采用/原始会话名继续工作）。
 *     返回的 `hint` 附加到最终失败表面，使得拼写错误的三段式始终响亮失败
 *     并指出主机名（绝不静默穿透）。这刻意不同于 MH-3 的队列规则
 *     （仅规范目标在分类器后总是剥离）；逐动词类的拆分记录在
 *     cli-reference.md 中。
 *   - 保留 id（kernel/host/local）永远不能被注册
 *     （RESERVED_HOST_IDS），因此 `@kernel`/`@host` 人类席位形式
 *     永远不会被简写捕获。
 *
 * 优先级（调用方与持久化选择组合）：
 *   显式 `--host` > 目标简写 > 持久化选择
 *   （`resolveEffectiveHost`）。`--host X` + 简写 `@Y` 且 X≠Y 是
 *   结构化冲突——绝不静默选择优先级。同一个主机命名两次没问题。
 */
export interface CrossHostTargetResolution {
  ok: true;
  /** 去除已匹配主机限定符后的目标。 */
  target: string;
  /** 简写派生的主机 id（已注册后缀），如果有。 */
  sugarHost: string | undefined;
  /**
   * 当目标是三段式形状但后缀不匹配任何已注册主机时的响亮失败提示。
   * 调用方将其附加到该目标的失败表面；它在成功路径上永不改变行为。
   */
  hint: string | undefined;
  /**
   * 非致命的响亮表面：当解析经过一个注册表条目，其学习到的
   * 身份绑定有记录的矛盾时设置（known_hosts 响亮失败属性）。
   * 调用方打印到 stderr 并继续——矛盾是警告，绝不阻塞。
   */
  warning?: string;
}

export interface CrossHostTargetConflict {
  ok: false;
  error: string;
}

export function resolveCrossHostTarget(
  rawTarget: string,
  explicitHost: string | undefined,
  registryLoader?: () => ReturnType<typeof loadHostRegistry>,
  selfHostId?: string | undefined | null,
  bindingsLoader?: () => HostBindingsFile,
): CrossHostTargetResolution | CrossHostTargetConflict {
  const atCount = rawTarget.split("@").length - 1;
  if (atCount < 2) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: undefined };
  }

  const lastAt = rawTarget.lastIndexOf("@");
  const base = rawTarget.slice(0, lastAt);
  const suffix = rawTarget.slice(lastAt + 1);

  const unregisteredHint = suffix.length > 0
    ? `无已注册主机 '${suffix}'——如果 '${suffix}' 想作为主机，请检查 \`zrig host ls\``
    : undefined;

  if (suffix.length === 0 || base.length === 0) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  // 51-09 增量 3（架构裁定 2e1b737f）：等于后台服务字面启动自协调
  // 自身主机 id 的后缀路由回本地——这是后台服务 resolvesToLocalHost
  // 的 CLI 端孪生。本地回复提示自 2026-08-27 根不变量以来就是裸的，
  // 但跨主机到达的回复提示仍携带来源三元组——从来源自身主机回复它时
  // 复制 `member@rig@selfId`，如果没有这个剥离，三段式字符串会作为
  // unknown_destination_rig 死信（反向死信）。
  // C2：仅字面、大小写敏感的自身 id 匹配——无别名/前缀/注册表回退，
  // 绝不 'local' 别名（匹配 resolvesToLocalHost 的自身 id 分支）。
  // 附加条款 (a)：非自身后缀不在此匹配，穿透到下面的注册表查找 +
  // 响亮未注册提示——简写绝不变成"任意未知都穿透到本地"。
  // C1 故障开放：当 selfHostId 缺失时（后台服务宕机/预协调/未知），
  // 此分支被跳过，字符串完全像今天一样透传。
  if (typeof selfHostId === "string" && selfHostId.length > 0 && suffix === selfHostId) {
    if (explicitHost !== undefined && explicitHost !== suffix) {
      return {
        ok: false,
        error: `主机歧义：--host ${explicitHost} 与目标的主机限定符 @${suffix} 冲突——请只指定一个主机`,
      };
    }
    // 路由回本地：剥离自身后缀，无跨主机 sugarHost（本地发送）。
    return { ok: true, target: base, sugarHost: undefined, hint: undefined };
  }

  const loader = registryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    // 无注册表 = 无已注册后缀可匹配；原样透传
    // （普通目标行为不得获得新的失败模式）。
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  // Sidecar 学习到的绑定加入匹配集：等于学习到的自身 id 的后缀
  // 解析为它所学习的别名（故障开放——sidecar 缺失/损坏只是空集）。
  const bindings = (bindingsLoader ?? loadHostBindings)().bindings;
  const resolved = resolveHost(registry.registry, suffix, bindings);
  if (!resolved.ok) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  // 同一主机的两种拼写不是冲突。`--host remote-host` 旁边有目标后缀
  // `@host-84c37990`，一旦后缀能匹配连接键就命名同一台机器——
  // 拒绝它会惩罚操作员粘贴我们打印给他们的回复提示，
  // 而这正是本 slice 要支持的工作流。比较解析后的条目，不是原始字符串。
  // 真正不同的主机，或解析为空的显式主机，仍然响亮冲突。
  const explicitResolved = explicitHost !== undefined
    ? resolveHost(registry.registry, explicitHost, bindings)
    : undefined;
  const namesSameEntry = explicitResolved?.ok === true && explicitResolved.host.id === resolved.host.id;

  if (explicitHost !== undefined && explicitHost !== suffix && !namesSameEntry) {
    return {
      ok: false,
      error: `主机歧义：--host ${explicitHost} 与目标的主机限定符 @${suffix} 冲突——请只指定一个主机`,
    };
  }

  // 规范化为别名。后缀可能匹配了条目的连接键而非其 id
  // （对等方的回复提示携带该对等方的自身 id）。下游把 sugarHost 当作
  // 注册表 id 并与 `h.id` 比较，因此交回规范别名，而不是输入的内容。
  // 解析后条目的学习绑定携带记录的矛盾时响亮警告（绝不阻塞）。
  const binding = bindings[resolved.host.id];
  const warning = binding?.conflict ? describeBindingConflict(resolved.host.id, binding) : undefined;
  return { ok: true, target: base, sugarHost: resolved.host.id, hint: undefined, ...(warning ? { warning } : {}) };
}
