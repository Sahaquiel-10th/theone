import type {TeachingRequest} from './teachingUploads';
export function isTeachingKnowledgeProblem(error:unknown){const code=String((error as {code?:unknown})?.code??'');return code.startsWith('TEACHING_KNOWLEDGE_');}
export function teachingStoryPreviewRequest(options:{base:string;activityId:string;request:TeachingRequest;onKnowledgeProblem:(error:unknown)=>void}):TeachingRequest{
 return async<T,>(path:string,init?:RequestInit):Promise<T>=>{
  if(init?.method!=='POST'||path!==options.base+'/questions')return options.request<T>(path,init);
  // No retrieval/model call, credential refresh or authorization write here.
  try{await options.request(`/api/teaching/knowledge/status?courseId=${encodeURIComponent(options.base.split('/').at(-1)!)}&activityId=${encodeURIComponent(options.activityId)}&purpose=script`);}catch(e){if(isTeachingKnowledgeProblem(e))options.onKnowledgeProblem(e);throw Object.assign(e instanceof Error?e:new Error('课程资料暂不可用'),{notStarted:true});}
  try{return await options.request<T>(options.base+'/ai',{...init,body:JSON.stringify({...JSON.parse(String(init.body)),preview:true,conversationId:`workshop-${options.activityId}`})});}catch(e){if(isTeachingKnowledgeProblem(e))options.onKnowledgeProblem(e);throw e;}
 };
}
