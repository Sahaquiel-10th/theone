export type TaskCategory = 'active'|'review'|'ended'|'history';
/** Process exit is a returned receipt, not proof the user's goal was achieved. */
export function taskUiOutcome({paused,localStatus,receiptOutcome,receiptState}:{paused?:boolean;localStatus?:string;receiptOutcome?:string;receiptState?:string}) {
  if(paused)return 'paused';
  if(localStatus&&['queued','selecting_target','running'].includes(localStatus))return localStatus;
  return receiptOutcome||receiptState||(localStatus==='completed'?'returned':localStatus);
}
export function taskCategory({paused,active,unread,outcome,isTask}:{paused?:boolean;active?:boolean;unread?:boolean;outcome?:string;isTask?:boolean}):TaskCategory {
  if(paused)return 'review';
  if(active)return 'active';
  if(unread||['failed','interrupted','cancelled','needs_input','partial'].includes(outcome||''))return 'review';
  return isTask?'ended':'history';
}
