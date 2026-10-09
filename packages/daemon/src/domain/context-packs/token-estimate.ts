/** store 与 assembly 投影共用的低成本稳定 token 估算。 */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}
