/** Official recipes are code-owned, versioned and callable as one capability.
 * A recipe controls its internal order; the outer dispatcher need not invent it. */
export const onboardingWorkflow = {
  id:'onboarding_guide',version:1,name:'个人使用说明',
  description:'完成新手资料设置后，按固定流程整理专属说明、生成插画、完整流程图和交互网页。重新制作从设置进入，遵守首次赠送和再次确认规则。',
  entryPoints:['onboarding.complete','onboarding.remake'] as const,
  stages:[{id:'oneManual',name:'整理专属说明'},{id:'image_generation',name:'生成使用插画'},
    {id:'oneFlowchart',name:'生成完整流程图'},{id:'oneHtml',name:'生成交互网页'}],
  inputs:['称呼','主要用途','已连接平台名称','本机就绪状态','已开放功能名称'],
  outputs:['插画','完整流程图','交互网页'],
} as const;
export type FixedWorkflowInvocation={id:typeof onboardingWorkflow.id;version:1;trigger:typeof onboardingWorkflow.entryPoints[number]};

/** An adapter invokes the existing durable task engine, never a second runner. */
export async function invokeFixedWorkflow<T>(input:{id:string;trigger:string;scope:{workspaceId:string;userId:string}},
  deps:{authorize:()=>Promise<void>;run:(invocation:FixedWorkflowInvocation)=>Promise<T>}) {
  if(input.id!==onboardingWorkflow.id||!onboardingWorkflow.entryPoints.some(trigger=>trigger===input.trigger)
    ||!input.scope.workspaceId||!input.scope.userId)throw new Error('这个固定流程不能从当前入口运行');
  await deps.authorize();
  return deps.run({id:onboardingWorkflow.id,version:onboardingWorkflow.version,trigger:input.trigger as FixedWorkflowInvocation['trigger']});
}
export function validateFixedWorkflowInvocation(value:FixedWorkflowInvocation|undefined){
  if(value&&(value.id!==onboardingWorkflow.id||value.version!==onboardingWorkflow.version||!onboardingWorkflow.entryPoints.includes(value.trigger)))throw new Error('固定流程版本或入口无效');
}
export const onboardingArtifactStages=[{tool:'oneFlowchart',key:'flowId'},{tool:'oneHtml',key:'pageId'}] as const;
