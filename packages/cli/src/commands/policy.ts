// B7 (0.5.2, RULING-rig-mode-rig-policy-naming) —— `rig policy`：顶层的权限策略
// 动词，在 context-mode 动词占用其自然名（`rig mode`）之后引入。
//
// 绑定诚实钉（按裁决逐字从 setup.ts 沿用）：OpenRig 不内置任何
// allow/ask/deny 权限策略——harness 原生权限才是控制面。
// `rig policy` 只教学并把选择记录进 RigSpec（`permission_policy: builtin:<name> | none`）；
// 绝不在运行时强制执行。OpenRig 把姿态记录进 RigSpec，由 harness 原生权限
// 强制执行——绝不运行时强制。
//
// 按裁决的 v1 范围（读多 + 一条写路径）：
//   rig policy list [--spec]              —— 内置项 + 保留的 deliberate-none + 在给定
//                                           spec 上下文中可见的自定义策略
//   rig policy show <name-or-ref> [--spec]—— 一个内置项或一个自定义策略 spec（已校验）
//   rig policy current --spec <path>      —— 生效的已记录策略 + 实际会应用什么，
//                                           经权威校验器/解析器
//   rig policy apply <name> --spec <path> —— 记录选择（与 `rig setup --policy` 同一流程，
//                                           后者保留为 setup 流程组合，而非别名）
//
// 权威语义，而非私有分类器（r2 HIGH-2）：本动词报告的每个引用都经过
// validatePermissionPolicyRef + resolvePermissionPolicyAttachment——它们是后台服务
// 权限策略模块（lib/permission-policy/*、lib/path-safety.ts）的字节级 CLI 孪生
// （由 permission-policy-parity.test.ts 钉住）。非法引用以权威错误退出 1——
// 本接口绝不能放行后台服务自身校验拒绝的 spec 缺陷。

import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import path from "node:path";
import {
  defaultDeps,
  recordPermissionPolicyStep,
  resolveExistingSpecPath,
  POLICY_CHOICES,
} from "./setup.js";
import {
  BUILTIN_POLICY_NAMES,
  validatePermissionPolicyRef,
  resolvePermissionPolicyAttachment,
  type ResolvedPolicyAttachment,
} from "../lib/permission-policy/policy-ref.js";
import { parsePolicySpec, validatePolicySpec } from "../lib/permission-policy/policy-spec.js";

const HONESTY_PIN =
  "zrig 不内置任何 allow/ask/deny 权限策略——harness 原生权限才是控制面。" +
  "zrig 把姿态记录进 RigSpec；由 harness 原生权限强制执行——绝不运行时强制。";

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  locked: "最严格的打包姿态——用于任何时候都不能无人值守触碰任何东西的席位",
  standard: "受管工作席位的打包默认姿态",
  open: "面向受信任、高自主席位的宽松打包姿态",
  yolo: "操作者/无护栏姿态——harness 允许的一切都放行（启动姿态：full_bypass）",
  none: "保留的 deliberate-none 选择：记录为 permission_policy: none——姿态等同于缺失（地板），但缺失是被主动选择且可见的",
};

function refFor(name: string): string {
  return name === "none" ? "none" : `builtin:${name}`;
}

const readFileDep = { readFile: (p: string) => fs.readFileSync(p, "utf-8") };

interface SpecRefSite {
  site: string; // "rig" | "pods[i].members[j]（<逻辑 id>）"
  /** 原始声明值：undefined = 该键真正缺失；其他任何值（包括非字符串 YAML 值）都算
   *  存在并送交权威校验器——存在的非字符串必须显示为 INVALID，绝不能悄悄变成
   *  "缺失 → 地板"（r2 round 3）。 */
  ref: unknown;
}

/** 收集一个已解析 rig spec 中所有 permission_policy 声明点（rig 级 + 各成员）。
 *  存在性以"键是否存在"为准，而非值是否为字符串。 */
function collectRefSites(doc: Record<string, unknown>): SpecRefSite[] {
  const sites: SpecRefSite[] = [{
    site: "rig",
    ref: Object.prototype.hasOwnProperty.call(doc, "permission_policy") ? doc["permission_policy"] : undefined,
  }];
  const pods = Array.isArray(doc["pods"]) ? (doc["pods"] as Array<Record<string, unknown>>) : [];
  pods.forEach((pod, pi) => {
    const members = Array.isArray(pod["members"]) ? (pod["members"] as Array<Record<string, unknown>>) : [];
    members.forEach((member, mi) => {
      if (member && typeof member === "object" && Object.prototype.hasOwnProperty.call(member, "permission_policy")) {
        const id = [pod["id"], member["id"]].filter(Boolean).join(".");
        sites.push({ site: `pods[${pi}].members[${mi}]${id ? ` (${id})` : ""}`, ref: member["permission_policy"] });
      }
    });
  });
  return sites;
}

function loadSpec(specPath: string): { resolved: string; doc: Record<string, unknown> } | { error: string } {
  const resolved = resolveExistingSpecPath(defaultDeps(), specPath);
  if (!resolved) {
    return { error: `在 ${specPath} 未找到工作组规范（先查找该文件，再查找其中的 rig.yaml/rig.yml/agent.yaml/agent.yml）。` };
  }
  try {
    const doc = (parseYaml(fs.readFileSync(resolved, "utf-8")) ?? {}) as Record<string, unknown>;
    return { resolved, doc };
  } catch (err) {
    return { error: `无法解析 ${resolved}：${(err as Error).message}` };
  }
}

/** 为一个已解析的挂载渲染"实际会应用什么"。 */
function describeAttachment(a: ResolvedPolicyAttachment): string {
  const parts = [
    `origin=${a.origin}`,
    a.builtinName ? `builtin=${a.builtinName}` : null,
    a.resolvedTarget ? `target=${a.resolvedTarget}` : null,
    a.surface ? `surface=${a.surface}` : null,
    `launch_posture=${a.launchPosture}`,
    `content_resolved=${a.contentResolved}`,
  ].filter(Boolean);
  const advisory = a.origin === "custom" && !a.contentResolved
    ? " —— 未解析的自定义内容：在策略 spec 可读并校验前，应用建议地板"
    : "";
  return parts.join(" · ") + advisory;
}

export function policyCommand(): Command {
  const cmd = new Command("policy").description(
    `教学并记录工作组级权限策略。${HONESTY_PIN}（原先占用此名的 context-mode 动词现为：rig mode。）`,
  );

  const permissions = new Command("permissions").description(
    "原生权限策略：list、show、current 与 apply。工作姿态是另一回事；本命令不会重启席位。",
  );
  registerPermissionCommands(permissions);
  cmd.addCommand(permissions);
  // 兼容别名共享完全相同的动作与输出，包括 JSON 与退出码。
  registerPermissionCommands(cmd);
  return cmd;
}

function registerPermissionCommands(cmd: Command): void {

  cmd
    .command("list")
    .description(`列出内置权限策略模板，以及在某 spec 上下文中可见的自定义策略。${HONESTY_PIN}`)
    .option("--spec <path>", "定义自定义策略上下文的工作组规范（文件或目录）")
    .option("--json", "机器可读输出")
    .action((opts: { spec?: string; json?: boolean }) => {
      const builtins = POLICY_CHOICES.map((name) => ({ name, ref: refFor(name), origin: name === "none" ? "deliberate_none" : "builtin", description: BUILTIN_DESCRIPTIONS[name] ?? "" }));
      const custom: Array<Record<string, unknown>> = [];
      let specError: string | null = null;
      if (opts.spec) {
        const loaded = loadSpec(opts.spec);
        if ("error" in loaded) {
          specError = loaded.error;
        } else {
          const declaringDir = path.dirname(loaded.resolved);
          for (const { site, ref } of collectRefSites(loaded.doc)) {
            if (ref === undefined) continue; // truly absent
            if (typeof ref === "string" && (ref === "none" || ref.startsWith("builtin:"))) continue;
            const invalid = validatePermissionPolicyRef(ref, `${site}.permission_policy`);
            if (invalid) {
              custom.push({ site, ref, invalid });
              continue;
            }
            const a = resolvePermissionPolicyAttachment(ref as string, declaringDir, readFileDep);
            custom.push({ site, ref, resolvedTarget: a.resolvedTarget, surface: a.surface ?? null, launchPosture: a.launchPosture, contentResolved: a.contentResolved });
          }
        }
      }
      if (opts.json) {
        console.log(JSON.stringify({ policies: builtins, custom, ...(specError ? { specError } : {}), note: HONESTY_PIN }));
      } else {
        for (const r of builtins) console.log(`${r.name.padEnd(10)} ${r.ref.padEnd(18)} ${r.description}`);
        if (opts.spec && !specError) {
          console.log(custom.length > 0 ? "\n规范集中的自定义策略：" : "\n（规范集中未引用自定义策略）");
          for (const c of custom) {
            console.log(c.invalid
              ? `  ${String(c.site).padEnd(28)} ${c.ref} —— 无效：${c.invalid}`
              : `  ${String(c.site).padEnd(28)} ${c.ref} → ${c.resolvedTarget}（surface=${c.surface ?? "?"}, launch_posture=${c.launchPosture}, content_resolved=${c.contentResolved}）`);
          }
        }
        if (specError) console.error(specError);
        console.log(`\n${HONESTY_PIN}`);
      }
      if (specError) process.exitCode = 1;
    });

  cmd
    .command("show <nameOrRef>")
    .description("查看一个内置策略选择，或按引用校验并打开一个自定义策略 spec（相对 --spec 所在目录，否则 cwd）。")
    .option("--spec <path>", "其目录用于锚定自定义引用的工作组规范（文件或目录）")
    .option("--json", "机器可读输出")
    .action((nameOrRef: string, opts: { spec?: string; json?: boolean }) => {
      if ((POLICY_CHOICES as readonly string[]).includes(nameOrRef)) {
        const out = {
          name: nameOrRef,
          ref: refFor(nameOrRef),
          origin: nameOrRef === "none" ? "deliberate_none" : "builtin",
          description: BUILTIN_DESCRIPTIONS[nameOrRef] ?? "",
          recordedAs: `permission_policy: ${refFor(nameOrRef)}`,
          launchPosture: nameOrRef === "yolo" ? "full_bypass" : "floor",
          enforcement: HONESTY_PIN,
        };
        if (opts.json) console.log(JSON.stringify(out));
        else {
          console.log(`${out.name} — ${out.description}`);
          console.log(`记录为：${out.recordedAs}（launch_posture: ${out.launchPosture}）`);
          console.log(out.enforcement);
        }
        return;
      }
      // 自定义引用路径——先做权威校验；非法引用是显式拒绝。
      const ref = nameOrRef.startsWith("builtin:") ? nameOrRef : nameOrRef;
      const invalid = validatePermissionPolicyRef(ref, "policy ref");
      if (invalid) {
        console.error(invalid);
        console.error(`已知内置项：${POLICY_CHOICES.join(", ")}。`);
        process.exitCode = 1;
        return;
      }
      let declaringDir = process.cwd();
      let anchor = "cwd";
      if (opts.spec) {
        const loaded = loadSpec(opts.spec);
        if ("error" in loaded) {
          console.error(loaded.error);
          process.exitCode = 1;
          return;
        }
        declaringDir = path.dirname(loaded.resolved);
        anchor = loaded.resolved;
      }
      const resolvedTarget = path.resolve(declaringDir, ref);
      let raw: string;
      try {
        raw = fs.readFileSync(resolvedTarget, "utf-8");
      } catch {
        console.error(`自定义策略 '${ref}' 无法解析：${resolvedTarget} 缺失或不可读（锚定于 ${anchor}）。将应用建议地板。`);
        process.exitCode = 1;
        return;
      }
      const parsed = parsePolicySpec(raw);
      if ("error" in parsed) {
        console.error(`位于 ${resolvedTarget} 的自定义策略 '${ref}' 无效：${parsed.error}`);
        process.exitCode = 1;
        return;
      }
      const contract = validatePolicySpec(parsed.frontmatter);
      const attachment = resolvePermissionPolicyAttachment(ref, declaringDir, readFileDep);
      const out = {
        ref,
        origin: "custom",
        resolvedTarget,
        declaringDir,
        surface: attachment.surface ?? null,
        launchPosture: attachment.launchPosture,
        contentResolved: attachment.contentResolved,
        contractValid: contract.ok,
        contractErrors: contract.errors,
        enforcement: HONESTY_PIN,
      };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`${ref} → ${resolvedTarget}`);
        console.log(describeAttachment(attachment));
        if (!contract.ok) for (const e of contract.errors) console.log(`  契约：${e}`);
        console.log(HONESTY_PIN);
      }
      if (!contract.ok) process.exitCode = 1;
    });

  cmd
    .command("current")
    .description("展示一个工作组规范的生效权限策略、以及逐站点（rig + 成员覆盖）实际会应用什么，经权威校验器/解析器。")
    .requiredOption("--spec <path>", "工作组规范文件，或包含 rig.yaml/agent.yaml 的目录")
    .option("--json", "机器可读输出")
    .action((opts: { spec: string; json?: boolean }) => {
      const loaded = loadSpec(opts.spec);
      if ("error" in loaded) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      const declaringDir = path.dirname(loaded.resolved);
      const sites = collectRefSites(loaded.doc);
      const rigRef = sites[0]!.ref;
      let anyInvalid = false;
      const report = sites.map(({ site, ref }) => {
        // 成员 > rig 的存在性优先级（存在的成员值覆盖，即使它非法——
        // 它必须作为自身的缺陷浮现，绝不能悄悄消失在 rig 引用背后）。
        const effective = site === "rig" ? ref : (ref !== undefined ? ref : rigRef);
        if (effective === undefined) {
          return { site, ref: null, effective: null, applies: "缺失——地板（诚实的缺失；未记录任何内容）" };
        }
        const invalid = validatePermissionPolicyRef(effective, `${site}.permission_policy`);
        if (invalid) {
          anyInvalid = true;
          return { site, ref: ref ?? null, effective, invalid };
        }
        const a = resolvePermissionPolicyAttachment(effective as string, declaringDir, readFileDep);
        return { site, ref: ref ?? null, effective, applies: describeAttachment(a), attachment: a };
      });
      const out = { spec: loaded.resolved, sites: report, enforcement: HONESTY_PIN };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`规范：${loaded.resolved}`);
        for (const r of report) {
          if ("invalid" in r && r.invalid) console.log(`${r.site}：${r.effective} —— 无效：${r.invalid}`);
          else console.log(`${r.site}：${r.effective ?? "（缺失）"} —— ${String((r as { applies?: string }).applies)}`);
        }
        console.log(HONESTY_PIN);
      }
      // 非法引用是 spec 缺陷（后台服务自身校验会拒绝）——绝不退出 0。
      if (anyInvalid) process.exitCode = 1;
    });

  cmd
    .command("apply <name>")
    .description(`把一个策略选择记录进已存在的工作组规范（与 \`zrig setup --policy\` 同一记录流程，后者保留为 setup 步骤组合）。${HONESTY_PIN}`)
    .requiredOption("--spec <path>", "工作组规范文件，或包含 rig.yaml/agent.yaml 的目录")
    .option("--json", "机器可读输出")
    .action((name: string, opts: { spec: string; json?: boolean }) => {
      const step = recordPermissionPolicyStep(defaultDeps(), name, opts.spec);
      if (opts.json) console.log(JSON.stringify(step));
      else {
        console.log(step.message);
        if (step.status === "fail") {
          if (step.reason) console.log(step.reason);
          if (step.fixHint) console.log(`修复：${step.fixHint}`);
        }
      }
      if (step.status === "fail") process.exitCode = 1;
    });

}

// 重新导出，使对等测试无须深层导入即可断言孪生界面。
export { BUILTIN_POLICY_NAMES };
