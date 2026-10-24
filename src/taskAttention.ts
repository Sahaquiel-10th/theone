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

/** One arrival has one destination. Remember the user's selection when possible;
 * otherwise show active work before reviewable receipts and older conversation.
 * This only chooses an id: opening an overview must not mark a receipt read. */
export function taskEntrySelection(items:readonly {id:string;archived?:boolean;taskState?:TaskCategory;updatedAt:string}[],preferredId='') {
  const visible=items.filter(item=>!item.archived);
  if(visible.some(item=>item.id===preferredId))return preferredId;
  const priority:Record<TaskCategory,number>={active:0,review:1,ended:2,history:3};
  return [...visible].sort((a,b)=>priority[a.taskState||'history']-priority[b.taskState||'history']||b.updatedAt.localeCompare(a.updatedAt))[0]?.id||'';
}
