import type {Database} from './types.js';

export type PreparationScope = {workspaceId:string;userId:string;operationId:string};
/** Re-read INSIDE the execution insert transaction: a compiler may have started before admission failed. */
export function assertPreparedLocalExecutionActive(db:Pick<Database,'chatOperations'>,scope:{workspaceId:string;userId:string;conversationId:string;sourceMessageId:string}){
 const stopped=db.chatOperations?.find(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.conversationId===scope.conversationId&&o.workRun?.inputMessageId===scope.sourceMessageId
   &&(o.workRun.state==='cancelled'||o.workRun.failureCode==='task_local_not_started'));
 if(stopped)throw new Error(stopped.workRun!.state==='cancelled'?'此任务已停止，未开始本机操作。':'此任务的本机准入未通过，未开始本机操作。不会自动重跑。');
}
/** Stop-before-start fence, scoped to the authenticated request. */
export class ExecutionPreparationStops {
 private stops=new Map<string,number>();
 private key(s:PreparationScope){return JSON.stringify([s.workspaceId,s.userId,s.operationId]);}
 cancel(s:PreparationScope){if(!/^[A-Za-z0-9_-]{16,128}$/.test(s.operationId))throw new Error('执行编号无效');for(const [k,t] of this.stops)if(Date.now()-t>3600000)this.stops.delete(k);this.stops.set(this.key(s),Date.now());}
 assertActive(s:PreparationScope){if(this.stops.has(this.key(s)))throw new Error('已停止执行准备，未继续发送本机操作；已产生的用量仍保留。');}
}
