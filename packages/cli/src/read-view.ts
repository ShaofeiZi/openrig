/** 读视图描述的是原始 JSON，绝不是一份被估算补全的完整台账。 */
export function omittedReadField(path: string, value: unknown) {
  return {
    path,
    jsonBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    ...(Array.isArray(value) ? { items: value.length } : {}),
  };
}

export function readView(original: unknown, fullCommand: string, omittedFields: ReturnType<typeof omittedReadField>[] = []) {
  return {
    complete: omittedFields.length === 0,
    fullJsonBytes: Buffer.byteLength(JSON.stringify(original), "utf8"),
    omittedFields,
    fullCommand,
  };
}
