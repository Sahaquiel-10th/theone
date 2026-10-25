type Meta={id:string;updatedAt:string;running:boolean;queued:number;reconciling?:boolean};
type Notice={id:string;taskId:string;updatedAt?:string;state:string;outcome?:string;resultMessageId?:string;reported?:boolean;read?:boolean;notionReceipt?:import('./taskRecovery').NotionReceiptView};
type Detail={conversation:{updatedAt:string}};
export type CoordinatorDetailVersion={updatedAt?:string;receipts:string};

export function coordinatorDetailVersion(id:string,tasks:readonly Meta[],notices:readonly Notice[]):CoordinatorDetailVersion{
  const receipts=notices.filter(notice=>notice.taskId===id).map(notice=>[notice.id,notice.updatedAt,notice.state,notice.outcome,notice.resultMessageId,notice.notionReceipt?.state,notice.notionReceipt?.url,notice.notionReceipt?.error,notice.notionReceipt?.delivery,notice.notionReceipt?.verification?.state,notice.notionReceipt?.verification?.version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return{updatedAt:tasks.find(task=>task.id===id)?.updatedAt,receipts:JSON.stringify(receipts)};
}

/** Stable terminal results need one detail read, not another fan-out on every poll. */
export function coordinatorDetailRefreshPlan(input:{selected:string|null;tasks:readonly Meta[];notices:readonly Notice[];details:Readonly<Record<string,Detail>>;loadedVersions:ReadonlyMap<string,CoordinatorDetailVersion>}):{id:string;version:CoordinatorDetailVersion}[]{
  const tasks=new Map(input.tasks.map(task=>[task.id,task]));
  const ids=[...new Set([input.selected,...input.tasks.map(task=>task.id),...input.notices.map(notice=>notice.taskId)].filter((id):id is string=>Boolean(id)))];
  return ids.flatMap(id=>{
    const task=tasks.get(id),detail=input.details[id],previous=input.loadedVersions.get(id);
    const version=coordinatorDetailVersion(id,input.tasks,input.notices);
    const hasReceipt=version.receipts!=='[]';
    const missingDetail=hasReceipt&&!detail;
    const changedMeta=Boolean(detail&&task&&(previous?previous.updatedAt!==task.updatedAt:detail.conversation.updatedAt!==task.updatedAt));
    const changedReceipt=hasReceipt&&previous?.receipts!==version.receipts;
    return input.selected===id||task?.running||task?.reconciling||Boolean(task?.queued)||missingDetail||changedMeta||changedReceipt?[{id,version}]:[];
  });
}

/** Retain the latest generation even after its in-flight promise has been removed. */
export function coordinatorDetailReadIsCurrent(revisions:ReadonlyMap<string,number>,id:string,revision:number){return revisions.get(id)===revision;}
