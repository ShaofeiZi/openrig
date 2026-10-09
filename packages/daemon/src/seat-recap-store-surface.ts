// OPR.0.5.3.5 mini-req 7——seat-recap-store 子路径 surface：CLI 的 recap-write 动词
//（离任 occupant 的边界写入）通过此导出消费唯一存储，使 supersession 与可寻址性门禁只有一个
// 归属位置。与旁边其他子路径 surface 使用相同模式。
export {
  writeSeatRecap,
  listRecapChain,
  validateRecapContract,
  RECAP_FILENAME,
  RecapWriteError,
  type RecapChainEntry,
  type RecapContractFinding,
} from "./domain/context-packs/seat-recap-store.js";
