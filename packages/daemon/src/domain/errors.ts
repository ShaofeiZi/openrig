export class RigNotFoundError extends Error {
  constructor(rigId: string) {
    super(`未找到工作组 ${rigId}`);
    this.name = "RigNotFoundError";
  }
}
