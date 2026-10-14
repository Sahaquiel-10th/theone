export type TaskCategory = 'active'|'review'|'ended'|'history';
export function taskCategory({paused,active,unread,outcome,isTask}:{paused?:boolean;active?:boolean;unread?:boolean;outcome?:string;isTask?:boolean}):TaskCategory {
  if(paused)return 'review';
  if(active)return 'active';
  if(unread||['failed','interrupted','cancelled','needs_input','partial'].includes(outcome||''))return 'review';
  return isTask?'ended':'history';
}
