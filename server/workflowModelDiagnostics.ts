import type {WorkRun} from './coordinatorTypes.js';
import type {WorkflowBinding} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';
import {coordinatorRecoveryCopy,parseCoordinatorFailure,type CoordinatorFailure} from '../src/coordinatorRecovery.js';

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Owner-scoped, code-owned explanations. Model text and tool arguments never
 * enter this projection, including when reading checkpoints from older runs. */
export function workflowModelDiagnostic(run:Pick<WorkRun,'workflow'|'steps'|'state'>,binding:WorkflowBinding){
 const workflow=run.workflow;
 if(!workflow?.binding||!Array.isArray(workflow.steps)||!Array.isArray(workflow.spec?.steps)||workflow.binding.workspaceId!==binding.workspaceId||workflow.binding.userId!==binding.userId||workflow.binding.operationId!==binding.operationId)return;
 const index=workflow.steps.findIndex(step=>step.state==='failed');
 const step=workflow.spec.steps[index];
 if(!step||step.kind!=='model')return;
 const namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:${step.id}`;
 const key=taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
 const matches=(run.steps??[]).filter(checkpoint=>checkpoint.key===key);
 if(matches.length!==1)return;
 const checkpoint=matches[0],output=object(checkpoint.output),marker=object(output?.workflow),result=object(output?.result);
 if(checkpoint.namespace!==namespace||checkpoint.scopeId!==binding.operationId||checkpoint.tool!==tool||checkpoint.effect!=='model'||checkpoint.state!=='failed'
  ||marker?.version!==1||marker.runId!==workflow.id||marker.revision!==workflow.revision||marker.stepId!==step.id||!result)return;
 const diagnostic=object(result.responseDiagnostic),finishReason=result.finishReason;
 const unexpectedTools=diagnostic?.kind==='unexpected_tool_call'||finishReason==='tool_calls';
 const inferredCode=unexpectedTools?'model_invalid_response':finishReason==='filtered'?'model_filtered':finishReason==='length'?'model_incomplete':typeof result.content==='string'&&!result.content.trim()?'model_empty':undefined;
 const failure=parseCoordinatorFailure(result.failure)??(inferredCode?{code:inferredCode,stage:'model' as const,outcome:output?.outcome==='partial'?'partial' as const:'failed' as const}:undefined);
 if(!failure||failure.stage!=='model')return;
 const summary=unexpectedTools?'模型返回了操作指令，这一步还没有交付正文。':coordinatorRecoveryCopy(failure);
 const next=unexpectedTools?'喵，这一步已停下，需要 ONE 检查模型连接。已取得的资料会保留，你暂时不用补材料。'
  :failure.code==='model_filtered'?'可以调整这一步的写作要求后继续，已有资料会保留。'
  :failure.code==='model_incomplete'&&failure.outcome==='partial'?'可以先看已返回的正文，再从结尾接着写。'
  :'这一步已停下，已有资料会保留。请联系 ONE 检查模型连接。';
 return {stepId:step.id,failure:failure as CoordinatorFailure,summary,next,automaticRetryScheduled:false,
  ...(typeof result.content==='string'?{returnedTextChars:result.content.length}:{}),
  ...(['stop','length','filtered','tool_calls','unknown'].includes(String(finishReason))?{finishReason:String(finishReason)}:{})};
}
