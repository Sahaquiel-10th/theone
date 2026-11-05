import type {TeachingRequest} from './teachingUploads';
export function isTeachingKnowledgeProblem(error:unknown){const code=String((error as {code?:unknown})?.code??'');return code.startsWith('TEACHING_KNOWLEDGE_');}
/** This gate waits for the teacher's explicit dialog confirmation. Cancelling or
 * leaving the page resolves false; it never leaves a delayed paid request. */
export function createTeachingBudgetGate(){
 let pending:{promise:Promise<boolean>;resolve:(confirmed:boolean)=>void}|undefined;
 return {wait(){if(!pending){let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(r=>{resolve=r;});pending={promise,resolve};}return pending.promise;},settle(confirmed:boolean){const p=pending;pending=undefined;p?.resolve(confirmed);},get waiting(){return !!pending;}};
}
export function teachingStoryPreviewRequest(options:{base:string;activityId:string;request:TeachingRequest;budgetConfirmed:()=>boolean;confirmBudget:()=>Promise<boolean>;onKnowledgeProblem:(error:unknown)=>void}):TeachingRequest{
 return async<T,>(path:string,init?:RequestInit):Promise<T>=>{
  if(init?.method!=='POST'||path!==options.base+'/questions')return options.request<T>(path,init);
  // No retrieval/model call, credential refresh or authorization write here.
  try{await options.request(`/api/teaching/knowledge/status?courseId=${encodeURIComponent(options.base.split('/').at(-1)!)}&activityId=${encodeURIComponent(options.activityId)}&purpose=script`);}catch(e){if(isTeachingKnowledgeProblem(e))options.onKnowledgeProblem(e);throw Object.assign(e instanceof Error?e:new Error('课程资料暂不可用'),{notStarted:true});}
  if(!options.budgetConfirmed()&&!await options.confirmBudget())throw Object.assign(new Error('已取消本次审核，上传的剧本仍保留。'),{status:400,code:'TEACHING_PREVIEW_CANCELLED',notStarted:true});
  try{return await options.request<T>(options.base+'/ai',{...init,body:JSON.stringify({...JSON.parse(String(init.body)),budgetConfirmed:true,preview:true,conversationId:`workshop-${options.activityId}`})});}catch(e){if(isTeachingKnowledgeProblem(e))options.onKnowledgeProblem(e);throw e;}
 };
}
