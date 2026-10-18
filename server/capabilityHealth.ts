import type {Database,ModelUsageRecord} from './types.js';
import type {CapabilityCard} from './capabilityCatalog.js';
import type {ChatOperation} from './chatOperations.js';
import {toolSucceeded} from './taskSteps.js';

type Outcome='completed'|'failed'|'partial'|'blocked'|'stopped'|'pending'|'unknown';
export type CapabilityHealth={configured:boolean;windowDays:7;samples:number;deliveries:number;status:'unverified'|'observed'|'attention';counts:Record<Outcome,number>;calls:{success:number;failed:number;pending:number;unconfirmed:number};lastSuccessAt?:string;averageCallMs?:number;commonIssues:{label:string;count:number}[]};
const issueLabels:Record<string,string>={task_step_limit:'步骤用尽，尚未交齐',task_empty_response:'没有拿到完整回复',task_tool_call_limit:'工具步骤超出本轮限制',task_result_limit:'结果过大，未完成交付',image_upstream_error:'图片服务返回异常',image_no_result:'没有拿到图片'};
const inScope=(item:{workspaceId:string;userId:string},s?:{workspaceId:string;userId:string})=>!s||item.workspaceId===s.workspaceId&&item.userId===s.userId;
/** Read-only projection of durable receipts. No prompts, titles, user IDs or
 * provider messages cross this admin aggregate boundary. No paid health probes. */
export function capabilityHealth(db:Database,cards:CapabilityCard[],now=Date.now(),scope?:{workspaceId:string;userId:string}){
  const cutoff=now-7*86400000,operations=(db.chatOperations??[]).filter(o=>inScope(o,scope));
  const keyOf=(o:{workspaceId:string;userId:string},id:unknown)=>JSON.stringify([o.workspaceId,o.userId,id]);
  const byOperation=new Map(operations.map(op=>[keyOf(op,op.operationId),op]));
  const usage=new Map<string,ModelUsageRecord[]>();for(const row of db.modelUsageRecords??[]){if(!inScope(row,scope))continue;const key=keyOf(row,[row.requestId,row.conversationId]),list=usage.get(key)??[];list.push(row);usage.set(key,list);}
  const ownRows=(op:ChatOperation)=>usage.get(keyOf(op,[op.requestId,op.conversationId]))??[];
  const root=(op:ChatOperation)=>{let current=op;const seen=new Set<string>();for(let i=0;i<32;i++){const parentId=current.workRun?.retryOfOperationId??current.featureRun?.retryOf;if(!parentId||seen.has(parentId))break;seen.add(parentId);const parent=byOperation.get(keyOf(op,parentId));if(!parent)break;current=parent;}return current.operationId;};
  const hasDelivery=(op:ChatOperation)=>{const c=db.conversations.find(c=>c.id===op.conversationId&&c.workspaceId===op.workspaceId&&c.userId===op.userId);const m=c?.messages.find(m=>m.id===(op.workRun?.resultMessageId??op.assistantMessageId)&&m.role==='assistant');return !!m&&(!!m.content.trim()||!!m.attachments?.some(a=>db.attachments.some(f=>f.id===a.id&&f.workspaceId===op.workspaceId&&f.userId===op.userId&&f.conversationId===op.conversationId&&f.status==='ready'&&f.size>0)));};
  const output:Record<string,CapabilityHealth>={};
  for(const card of cards){
    const h:CapabilityHealth={configured:card.available,windowDays:7,samples:0,deliveries:0,status:'unverified',counts:{completed:0,failed:0,partial:0,blocked:0,stopped:0,pending:0,unknown:0},calls:{success:0,failed:0,pending:0,unconfirmed:0},commonIssues:[]};
    const groups=new Map<string,{op:ChatOperation;rows:ModelUsageRecord[];outcome:Outcome}>();
    for(const op of operations){
      const time=Date.parse(op.updatedAt||op.createdAt);if(!Number.isFinite(time)||time<cutoff||time>now)continue;
      const run=op.workRun,rows=ownRows(op),skills=Array.isArray(run?.skills)?run.skills:[];let relevant=false,outcome:Outcome='unknown',matchedRows:ModelUsageRecord[]=rows;
      if(card.kind==='feature'){
        const index=skills.findIndex(f=>f.id===card.featureId&&f.version===card.version);
        matchedRows=rows.filter(u=>u.featurePriceSnapshot&&u.featurePriceSnapshot.id===card.featureId&&u.featurePriceSnapshot.version===card.version);
        const step=index<0?undefined:run?.steps?.find(s=>s.namespace==='worker'&&s.tool===`feature_${index}`);
        relevant=!!op.featureRun&&op.featureRun.featureId===card.featureId&&op.featureRun.version===card.version||index>=0&&(!!step||matchedRows.length>0)||!!run?.directVisual&&skills.some(f=>f.id===card.featureId&&f.version===card.version);
        if(step?.state==='completed'&&toolSucceeded(step.output))outcome='completed';
        else if(step?.state==='failed')outcome='failed';
      }else if(card.kind==='workflow')relevant=!!run?.fixedWorkflow&&run.fixedWorkflow.id===card.workflowId&&run.fixedWorkflow.version===card.version;
      else if(card.kind==='executor')relevant=!!run&&run.executorId===card.executorId&&run.executorVersion===card.version&&(!card.modelId||run.modelId===card.modelId);
      else if(card.taskKind==='image_generation'){relevant=run?.kind==='image'&&run.executorVersion===card.version&&run.modelId===card.modelId;matchedRows=rows.filter(u=>u.activity==='image_generation');}
      else if(card.taskKind==='welcome_manual'){relevant=!!run?.welcomeManual&&run.welcomeManual.version===card.version&&run.welcomeManual.model.id===card.modelId;matchedRows=rows.filter(u=>u.activity==='welcome_manual');if(run?.welcomeManual?.document)outcome='completed';}
      if(!relevant)continue;
      if(run?.state==='cancelled'||op.executionCancelled)outcome='stopped';
      else if(run?.resultOutcome==='needs_input'||run?.dependencyBlocked||['task_key_required','task_budget_required','task_authorization_required'].includes(run?.failureCode??''))outcome='blocked';
      else if(outcome==='unknown'){
        if(run?.state==='queued'||run?.state==='running'||run?.state==='prepared'||op.status==='pending')outcome='pending';
        else if((run?.resultOutcome==='completed'||!run&&op.status==='completed')&&hasDelivery(op))outcome='completed';
        else if(run?.resultOutcome==='partial')outcome='partial';
        else if(run?.resultOutcome==='failed'||op.status==='failed')outcome='failed';
      }
      const key=JSON.stringify([op.workspaceId,op.userId,root(op)]),old=groups.get(key);
      const mergedRows=[...new Map([...(old?.rows??[]),...matchedRows].map(row=>[row.id,row])).values()];
      if(!old||op.updatedAt>=old.op.updatedAt)groups.set(key,{op,rows:mergedRows,outcome});else old.rows=mergedRows;
    }
    const issues=new Map<string,number>();let duration=0,timed=0;
    for(const {op,rows,outcome} of groups.values()){
      h.counts[outcome]++;
      if(hasDelivery(op)&&(op.workRun?.resultOutcome==='completed'||!op.workRun&&op.status==='completed'))h.deliveries++;
      if(outcome==='completed'&&(!h.lastSuccessAt||op.updatedAt>h.lastSuccessAt))h.lastSuccessAt=op.updatedAt;
      for(const row of rows){if(row.status==='success'||row.status==='waived')h.calls.success++;else if(row.status==='failed')h.calls.failed++;else if(row.status==='pending')h.calls.pending++;else h.calls.unconfirmed++;if(Number.isFinite(row.durationMs)&&row.durationMs!>=0){duration+=row.durationMs!;timed++;}}
      if(['failed','partial','unknown'].includes(outcome)){const code=op.workRun?.failureCode;const label=code&&Object.hasOwn(issueLabels,code)?issueLabels[code]:'结果尚未交齐，原因待核对';issues.set(label,(issues.get(label)??0)+1);}
    }
    h.samples=groups.size;const measured=h.counts.completed+h.counts.failed+h.counts.partial;
    h.status=h.counts.failed+h.counts.partial>0?'attention':measured>=3&&h.counts.completed>=3?'observed':'unverified';
    if(timed)h.averageCallMs=Math.round(duration/timed);
    h.commonIssues=[...issues].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([label,count])=>({label,count}));output[card.id]=h;
  }
  return output;
}
