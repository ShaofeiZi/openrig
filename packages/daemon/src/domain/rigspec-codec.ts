import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  RigSpec,
  LegacyRigSpec,
  SessionSourceSpec,
  RigServicesSpec,
  RigServicesWaitTarget,
  RigServicesSurface,
  RigServicesCheckpointHook,
} from "./types.js";

// OPR.0.5.6.23——sessionSource 联合类型的“存在性不变量”序列化接缝：
// 联合类型可选 ref 字段只枚举一次并据此输出；下方编译期完备性检查会让任一
// 联合分支新增但未枚举的可选字段在此成为构建错误，而不是在往返后静默变成 undefined。
// 本 slice 正是要消除这种静默擦除。
type SessionSourceRefKeys<T> = T extends { ref: infer R } ? (R extends unknown ? keyof R : never) : never;
type SessionSourceOptionalRefKey = Exclude<SessionSourceRefKeys<SessionSourceSpec>, "kind">;
const SESSION_SOURCE_OPTIONAL_REF_FIELDS = ["value", "version"] as const satisfies readonly SessionSourceOptionalRefKey[];
type UnenumeratedRefField = Exclude<SessionSourceOptionalRefKey, (typeof SESSION_SOURCE_OPTIONAL_REF_FIELDS)[number]>;
// 若联合分支新增了上方未枚举的可选 ref 字段，此行会编译失败，并在类型中点名缺失字段。
const _sessionSourceEnumerationComplete: UnenumeratedRefField extends never ? true : ["unserialized sessionSource ref field:", UnenumeratedRefField] = true;
void _sessionSourceEnumerationComplete;

function serializeSessionSource(ss: SessionSourceSpec): Record<string, unknown> {
  const srcRef = ss.ref as Record<string, unknown>;
  const ref: Record<string, unknown> = { kind: ss.ref.kind };
  for (const field of SESSION_SOURCE_OPTIONAL_REF_FIELDS) {
    if (srcRef[field] !== undefined) ref[field] = srcRef[field];
  }
  return { mode: ss.mode, ref };
}

// OPR.0.5.6.23（桌面裁决，slice 整体目标行上的 transition 45061）：
// services 家族复用同一存在性不变量接缝。下方映射记录必须点名每个
// RigServicesSpec 键；类型新增字段会在此编译失败并点名缺失键，绝不会静默往返为缺失。
const SERVICES_FIELD_EMITTERS: {
  [K in keyof Required<RigServicesSpec>]: (v: NonNullable<RigServicesSpec[K]>) => [string, unknown];
} = {
  kind: (v) => ["kind", v],
  composeFile: (v) => ["compose_file", v],
  projectName: (v) => ["project_name", v],
  profiles: (v) => ["profiles", v],
  downPolicy: (v) => ["down_policy", v],
  waitFor: (v) => ["wait_for", v.map(serializeWaitTarget)],
  surfaces: (v) => ["surfaces", serializeServicesSurfaces(v)],
  checkpoints: (v) => ["checkpoints", v.map(serializeCheckpointHook)],
};

function serializeServices(services: RigServicesSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SERVICES_FIELD_EMITTERS) as (keyof RigServicesSpec)[]) {
    const value = services[key];
    if (value === undefined) continue;
    const [yamlKey, yamlValue] = SERVICES_FIELD_EMITTERS[key](value as never);
    out[yamlKey] = yamlValue;
  }
  return out;
}

function serializeWaitTarget(target: RigServicesWaitTarget): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (target.service !== undefined) t["service"] = target.service;
  if (target.condition !== undefined) t["condition"] = target.condition;
  if (target.url !== undefined) t["url"] = target.url;
  if (target.tcp !== undefined) t["tcp"] = target.tcp;
  return t;
}

function serializeServicesSurfaces(surfaces: RigServicesSurface): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (surfaces.urls !== undefined) s["urls"] = surfaces.urls.map((u) => ({ name: u.name, url: u.url }));
  if (surfaces.commands !== undefined) {
    s["commands"] = surfaces.commands.map((c) => ({ name: c.name, command: c.command }));
  }
  return s;
}

function serializeCheckpointHook(hook: RigServicesCheckpointHook): Record<string, unknown> {
  const h: Record<string, unknown> = { id: hook.id, export: hook.exportCommand };
  if (hook.importCommand !== undefined) h["import"] = hook.importCommand;
  return h;
}

/**
 * Pod 感知的 RigSpec 编解码器，是 AgentSpec 重启的权威契约。
 */
export class RigSpecCodec {
  static parse(yamlString: string): unknown {
    return parseYaml(yamlString);
  }

  static serialize(spec: RigSpec): string {
    const doc: Record<string, unknown> = {
      version: spec.version,
      name: spec.name,
    };
    if (spec.summary) doc["summary"] = spec.summary;
    if (spec.cultureFile) doc["culture_file"] = spec.cultureFile;
    // OPR.0.4.8.3 接缝 B：工作组级 permission_policy 引用经序列化无损往返。
    if (spec.permissionPolicy) doc["permission_policy"] = spec.permissionPolicy;
    if (spec.managedBlocks) doc["managed_blocks"] = { ...spec.managedBlocks };
    if (spec.docs && spec.docs.length > 0) doc["docs"] = spec.docs.map((d) => ({ path: d.path }));
    if (spec.startup) doc["startup"] = serializeStartupBlock(spec.startup);
    if (spec.services) doc["services"] = serializeServices(spec.services);
    // PL-007：可选的工作组级 workspace 块。repo 使用归一化绝对路径往返；
    // 编解码器无法知道作者原先是否写了相对路径，因此不会还原为 workspace 相对路径。
    if (spec.workspace) {
      const ws: Record<string, unknown> = {
        workspace_root: spec.workspace.workspaceRoot,
        repos: spec.workspace.repos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
      };
      if (spec.workspace.defaultRepo !== undefined) ws["default_repo"] = spec.workspace.defaultRepo;
      if (spec.workspace.knowledgeRoot !== undefined) ws["knowledge_root"] = spec.workspace.knowledgeRoot;
      doc["workspace"] = ws;
    }

    doc["pods"] = spec.pods.map((pod) => {
      const p: Record<string, unknown> = {
        id: pod.id,
        label: pod.label,
      };
      if (pod.summary) p["summary"] = pod.summary;
      if (pod.continuityPolicy) {
        const cp: Record<string, unknown> = { enabled: pod.continuityPolicy.enabled };
        if (pod.continuityPolicy.syncTriggers) cp["sync_triggers"] = pod.continuityPolicy.syncTriggers;
        if (pod.continuityPolicy.artifacts) {
          const a: Record<string, unknown> = {};
          if (pod.continuityPolicy.artifacts.sessionLog !== undefined) a["session_log"] = pod.continuityPolicy.artifacts.sessionLog;
          if (pod.continuityPolicy.artifacts.restoreBrief !== undefined) a["restore_brief"] = pod.continuityPolicy.artifacts.restoreBrief;
          if (pod.continuityPolicy.artifacts.quiz !== undefined) a["quiz"] = pod.continuityPolicy.artifacts.quiz;
          cp["artifacts"] = a;
        }
        if (pod.continuityPolicy.restoreProtocol) {
          const rp: Record<string, unknown> = {};
          if (pod.continuityPolicy.restoreProtocol.peerDriven !== undefined) rp["peer_driven"] = pod.continuityPolicy.restoreProtocol.peerDriven;
          if (pod.continuityPolicy.restoreProtocol.verifyViaQuiz !== undefined) rp["verify_via_quiz"] = pod.continuityPolicy.restoreProtocol.verifyViaQuiz;
          cp["restore_protocol"] = rp;
        }
        p["continuity_policy"] = cp;
      }
      if (pod.startup) p["startup"] = serializeStartupBlock(pod.startup);

      p["members"] = pod.members.map((m) => {
        const member: Record<string, unknown> = {
          id: m.id,
          agent_ref: m.agentRef,
          profile: m.profile,
          runtime: m.runtime,
          cwd: m.cwd,
        };
        if (m.label) member["label"] = m.label;
        if (m.codexConfigProfile) member["codex_config_profile"] = m.codexConfigProfile;
        if (m.model) member["model"] = m.model;
        // OPR.0.4.6.FAC1：role 经规格序列化无损往返。
        if (m.role) member["role"] = m.role;
        // OPR.0.4.8.3 接缝 B：逐席位 permission_policy 引用经规格序列化无损往返。
        if (m.permissionPolicy) member["permission_policy"] = m.permissionPolicy;
        if (m.restorePolicy) member["restore_policy"] = m.restorePolicy;
        if (m.startup) member["startup"] = serializeStartupBlock(m.startup);
        // OPR.0.5.6.20 字段，OPR.0.5.6.23 修复：parse 会携带它（schema 归一化），
        // serialize 也必须如此——仍是同一类静默擦除问题。
        if (m.compactionStrategy) member["compaction_strategy"] = m.compactionStrategy;
        if (m.sessionSource) {
          member["session_source"] = serializeSessionSource(m.sessionSource);
        }
        // rebuild 的 ref.value 是数组；编解码器通过同一 `ref.value` 槽位原样重发，
        // 数组输出由 YAML 序列化器处理。
        if (m.starterRef) {
          member["starter_ref"] = { name: m.starterRef.name };
        }
        return member;
      });

      p["edges"] = pod.edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to }));
      return p;
    });

    doc["edges"] = spec.edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to }));

    return stringifyYaml(doc);
  }
}

function serializeStartupBlock(startup: import("./types.js").StartupBlock): Record<string, unknown> {
  return {
    files: startup.files.map((f) => {
      const file: Record<string, unknown> = { path: f.path };
      if (f.deliveryHint !== "auto") file["delivery_hint"] = f.deliveryHint;
      if (!f.required) file["required"] = false;
      if (f.appliesOn.length !== 2 || !f.appliesOn.includes("fresh_start") || !f.appliesOn.includes("restore")) {
        file["applies_on"] = f.appliesOn;
      }
      return file;
    }),
    actions: startup.actions.map((a) => {
      const action: Record<string, unknown> = {
        type: a.type,
        value: a.value,
        phase: a.phase,
        idempotent: a.idempotent,
      };
      if (a.appliesOn.length !== 2 || !a.appliesOn.includes("fresh_start") || !a.appliesOn.includes("restore")) {
        action["applies_on"] = a.appliesOn;
      }
      return action;
    }),
  };
}

/**
 * 旧版扁平节点 RigSpec 编解码器（重启前）。
 * TODO：待 AS-T08b/AS-T12 迁移所有消费者后移除。
 */
export class LegacyRigSpecCodec {
  static parse(yamlString: string): unknown {
    return parseYaml(yamlString);
  }

  static serialize(spec: LegacyRigSpec): string {
    const doc = {
      schema_version: spec.schemaVersion,
      name: spec.name,
      version: spec.version,
      nodes: spec.nodes.map((node) => {
        const n: Record<string, unknown> = { id: node.id, runtime: node.runtime };
        if (node.role != null) n["role"] = node.role;
        if (node.model != null) n["model"] = node.model;
        if (node.cwd != null) n["cwd"] = node.cwd;
        if (node.surfaceHint != null) n["surface_hint"] = node.surfaceHint;
        if (node.workspace != null) n["workspace"] = node.workspace;
        if (node.restorePolicy != null) n["restore_policy"] = node.restorePolicy;
        if (node.packageRefs && node.packageRefs.length > 0) n["package_refs"] = node.packageRefs;
        return n;
      }),
      edges: spec.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    };

    return stringifyYaml(doc);
  }
}
