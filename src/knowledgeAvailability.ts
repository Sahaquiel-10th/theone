export function waitingForOfficialApproval(provider: string, configured: boolean, status: string): boolean {
  return provider === "yinxiang" && !configured && status !== "connected";
}

export const officialApprovalLabel = "等待官方开通";
export const officialApprovalHint = "正在等待印象笔记官方开通应用及已有笔记读取权限，暂不可连接，无需反复重试。";
