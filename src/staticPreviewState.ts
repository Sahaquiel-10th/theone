export type PreviewReply = {status: string; url?: string};
export function previewReceiptMatches(expectedURL: string, reply: PreviewReply) {
  return reply.status === 'ready' && reply.url === expectedURL;
}
export function previewUnavailableMessage(reply?: PreviewReply) {
  return reply?.status === 'stopped' ? '预览已停止，可以重新启动。'
    : reply?.status === 'unknown' ? '当前启动器不能确认预览状态，请更新 ONE 后重新启动预览。'
    : '预览连接尚未确认，已隐藏旧链接；请确认 Key 和授权目录后重新启动。';
}
