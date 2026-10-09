// Living Notes Packet 2 —— CHAT 前导语（OPR.0.4.4.20 FR-4 / BR-12）。
//
// CHAT 是既有的终端族——本界面唯一的新增是入口和这一个预填文本框。那条常驻的
// “记录结果”前导语是一条钉死的合同字符串（不是各驱动自由发挥）：它指示智能体把
// 对话结果持久记录到被引用的条目上，并以“begins-here”标记结尾，使创始人紧接着打字、
// 单次回车就把前导语 + 消息一起提交（本界面从不发送单独的回车帧）。

// 注意：以下契约字符串会注入智能体提示，并显示在预填的终端输入中，因此也使用中文。
export const CHAT_PREAMBLE_SUFFIX = "用户消息从这里开始：";

export interface ChatTarget {
  /** 所属智能体的会话（真正的目的地）。 */
  sessionName: string;
  /** 平实语言引用：本次聊天所围绕的 slice 和/或 qitem。 */
  itemRef: string;
}

/** 钉死的常驻前导语。一个文本框，无回车（delta-C）。 */
export function buildChatPreamble(target: ChatTarget): string {
  return (
    `[评审 ${target.itemRef}] 常驻契约：对话得出结果后，请把结果持久记录到引用项上` +
    `（用决策文本解决、提交裁定证明，或将 qitem 路由回交付流程）；对话本身不等于问题已解决。` +
    CHAT_PREAMBLE_SUFFIX
  );
}
