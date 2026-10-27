import {ArrowUpRight,MessageSquare} from 'lucide-react';

export function LocalTaskEmptyState({unavailable,canExecute,onCompose,onSettings,onRetry}:{
 unavailable:boolean;canExecute:boolean;onCompose:()=>void;onSettings:()=>void;onRetry:()=>void;
}) {
 return <div className="fluid-panel-empty local-task-empty" data-state={unavailable?'unavailable':'empty'}>
  <p>{unavailable?'本机任务状态尚未确认':'暂无接管任务'}</p>
  <small>{unavailable?'刷新后查看，或到本机设置检查连接。':canExecute?'在主对话输入框里描述要求，再点「本机执行」。':'这里显示交给这台电脑执行的任务。'}</small>
  <div className="local-task-empty-actions">
   {unavailable?<button type="button" onClick={onRetry}>刷新任务状态</button>:<button type="button" onClick={onCompose}><MessageSquare size={13}/>在主对话中填写要求</button>}
   <button type="button" className="local-task-settings" onClick={onSettings}>本机设置 <ArrowUpRight size={12}/></button>
  </div>
 </div>;
}
