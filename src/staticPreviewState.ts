import type {LocalDeviceReadiness} from './localDeviceReadiness';
export type PreviewReply = {status: string; url?: string};
export function staticPreviewAvailability(value?:LocalDeviceReadiness):{canStart:boolean;message:string}{
  if(value?.platform==='windows'&&!value.capabilities?.staticPreview)return{canStart:false,message:'当前 Windows 启动器暂不支持内置网页预览，可以直接打开项目里的网页文件查看。'};
  if(!value?.connected)return{canStart:false,message:'当前预览能力尚未确认，请保持 ONE Key 连接后检查本机状态。'};
  if(!value.capabilities)return{canStart:false,message:'当前启动器的预览能力尚未确认，请先检查本机状态。'};
  if(!value.capabilities.staticPreview||!value.capabilities.taskDirectoryBinding)return{canStart:false,message:value.platform==='macos'?'请更新 ONE for Mac 后使用绑定本轮工作文件夹的预览。':'当前启动器暂不支持本轮网页预览，可以直接打开项目里的网页文件。'};
  return{canStart:true,message:''};
}
export function previewReceiptMatches(expectedURL: string, reply: PreviewReply) {
  return reply.status === 'ready' && reply.url === expectedURL;
}
export function previewUnavailableMessage(reply?: PreviewReply) {
  return reply?.status === 'stopped' ? '预览已停止，可以重新启动。'
    : reply?.status === 'unknown' ? '当前启动器不能确认预览状态，请更新 ONE 后重新启动预览。'
    : '预览连接尚未确认，已隐藏旧链接；请检查 Key 和 ONE 工作文件夹，再启动预览。';
}
