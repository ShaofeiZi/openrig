// OPR.0.4.3.05 seat-forking 收尾 —— 顶层 `rig fork` 动词。
//
// 一个可被发现的命令，把运行中席位的上下文分支到一个新席位。它是随附
// agent-image fork 基础之上的薄客户端：POST 到窄的后台服务 fork 编排器
// （/api/agent-images/fork），后者在服务端解析原生 resume id 并拼装
// add_member。原生 id 在每一条网络边界都被脱敏，从不到达 CLI。
//
//   默认            一次性 fork，不增长镜像库（模式：fork，native_id）
//   --keep-image    同时捕获一份持久、已钉住（防裁剪）的镜像

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ForkResponse {
  ok?: boolean;
  code?: string;
  error?: string;
  message?: string;
  errors?: string[];
  result?: {
    podNamespace?: string;
    node?: { logicalId: string; status: string; error?: string; sessionName?: string };
    warnings?: string[];
  };
  image?: { id: string; name: string; version: string; pinned: boolean };
}

export function forkCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("fork")
    .description("把运行中席位的上下文 fork 到新席位（拼装随附的 agent-image fork 路径）")
    .argument("<source-session>", "源会话规范名（例如 dev-impl@openrig-delivery）")
    .requiredOption("--rig <rig-id>", "目标工作组 id")
    .requiredOption("--pod <pod-namespace>", "目标已有 Pod 命名空间")
    .requiredOption("--member <member-id>", "fork 出的后继者的新成员 id")
    .option("--keep-image", "同时捕获一份持久、已钉住的智能体镜像（默认一次性 fork，不增长镜像库）")
    .option("--image-name <name>", "所保留镜像的名称（配合 --keep-image；默认 fork-<member>）")
    .option("--image-version <version>", "所保留镜像的版本（默认 1）")
    .option("--rig-root <path>", "智能体解析的根目录")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig fork dev-impl@openrig-delivery --rig openrig-delivery --pod dev --member dev-impl-fork
  zrig fork dev-impl@openrig-delivery --rig openrig-delivery --pod dev --member dev-impl-2 --keep-image --image-name impl-primed
`)
    .action(async (sourceSession: string, opts: {
      rig: string;
      pod: string;
      member: string;
      keepImage?: boolean;
      imageName?: string;
      imageVersion?: string;
      rigRoot?: string;
      json?: boolean;
    }) => {
      try {
        const deps = depsOverride ?? {
          lifecycleDeps: realDeps(),
          clientFactory: (url: string) => new DaemonClient(url),
        };
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (!daemonStatusGuard(status)) return;
        const client = deps.clientFactory(getDaemonUrl(status));

        const body: Record<string, unknown> = {
          sourceSession,
          rigId: opts.rig,
          pod: opts.pod,
          member: opts.member,
        };
        if (opts.keepImage) body["keepImage"] = true;
        if (opts.imageName) body["imageName"] = opts.imageName;
        if (opts.imageVersion) body["imageVersion"] = opts.imageVersion;
        if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

        const res = await client.post<ForkResponse>("/api/agent-images/fork", body);
        const data = res.data;

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          if (res.status >= 400 || !data.ok || (data.result?.node && data.result.node.status !== "launched")) {
            process.exitCode = 1;
          }
          return;
        }

        if (res.status >= 400 || !data.ok) {
          const msg = data.message
            ?? (data.errors && data.errors.length > 0 ? data.errors.join("；") : data.error)
            ?? `fork 失败（HTTP ${res.status}）`;
          console.error(msg);
          process.exitCode = 1;
          return;
        }

        const node = data.result?.node;
        const icon = node?.status === "launched" ? "OK" : "FAIL";
        const session = node?.sessionName ? `（${node.sessionName}）` : "";
        const error = node?.error ? ` - ${node.error}` : "";
        console.log(`已把 ${sourceSession} fork 到工作组 ${opts.rig}`);
        console.log(`  Pod：${data.result?.podNamespace ?? opts.pod}`);
        console.log(`  新席位：[${icon}] ${node?.logicalId ?? opts.member}${session}${error}`);
        if (data.image) {
          console.log(`  已保留镜像：${data.image.name} v${data.image.version}（已钉住，受保护不被裁剪）`);
        } else {
          console.log("  一次性 fork（未保留镜像）");
        }
        for (const w of data.result?.warnings ?? []) console.log(`  警告：${w}`);

        if (node && node.status !== "launched") process.exitCode = 1;
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
