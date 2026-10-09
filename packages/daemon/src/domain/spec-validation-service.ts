import { parseAgentSpec, validateAgentSpec } from "./agent-manifest.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";

/**
 * 验证原始 YAML 文本中的 AgentSpec。
 * 不访问文件系统，也不产生副作用。
 * @param yaml - 原始 agent.yaml 内容
 * @returns 验证结果
 */
export function validateAgentSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = parseAgentSpec(yaml);
    return validateAgentSpec(raw);
  } catch (err) {
    return { valid: false, errors: [`解析错误：${(err as Error).message}`] };
  }
}

/**
 * 验证原始 YAML 文本中支持 pod 的 RigSpec。
 * 不访问文件系统，也不产生副作用。
 * @param yaml - 原始 rig.yaml 内容
 * @returns 验证结果
 */
export function validateRigSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = RigSpecCodec.parse(yaml);
    return RigSpecSchema.validate(raw);
  } catch (err) {
    return { valid: false, errors: [`解析错误：${(err as Error).message}`] };
  }
}
