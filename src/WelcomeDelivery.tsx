import {Gift,LoaderCircle,X} from 'lucide-react';
import type {WelcomeDelivery as Delivery} from '../server/onboardingHandbook';

export function WelcomeDelivery({delivery,busy,error,onOpen,onCheck,onRetry,onDismiss}:{delivery:Delivery;busy:boolean;error?:string;onOpen:(id:string)=>void;onCheck:()=>void;onRetry:()=>void;onDismiss:()=>void}) {
  const pending=['preparing','queued','running'].includes(delivery.state);
  return <section className="welcome-delivery" role="status" aria-label="欢迎礼物进度">
    {pending?<LoaderCircle size={18} className="welcome-delivery-spinner"/>:<Gift size={18}/>}
    <div><strong>{delivery.message}</strong>{error?<small role="alert">{error}</small>:null}</div>
    <div className="welcome-delivery-actions">
      {delivery.taskId?<button type="button" onClick={()=>onOpen(delivery.taskId!)}>查看任务 ↗</button>:<button type="button" disabled={busy} onClick={delivery.canRetry?onRetry:onCheck}>{busy?'正在确认…':delivery.canRetry?'重试安排':'检查状态'}</button>}
      {!pending?<button type="button" className="welcome-delivery-dismiss" aria-label="收起欢迎礼物提示" onClick={onDismiss}><X size={15}/></button>:null}
    </div>
  </section>;
}
