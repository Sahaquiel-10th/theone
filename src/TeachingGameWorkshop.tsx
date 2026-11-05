import {useCallback,useState} from 'react';
import type {TeachingActivity} from '../server/teachingTypes';
import {TeachingStoryStudio,TeachingStoryPlayer} from './TeachingStoryStudio';
type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
export function TeachingGameWorkshop({activity,courseId,request,shareBase,budgetConfirmed,onNeedBudget}:{activity:TeachingActivity;courseId:string;request:Request;shareBase:string;budgetConfirmed:boolean;onNeedBudget:()=>void}){
 const [storyId,setStoryId]=useState(''),base=`/api/teaching/courses/${courseId}`;
 const previewRequest=useCallback(async<T,>(path:string,options?:RequestInit):Promise<T>=>{
  if(options?.method==='POST'&&path===`${base}/questions`){if(!budgetConfirmed){onNeedBudget();throw Object.assign(new Error('请先确认本次教师试玩使用电力，再继续原提交。'),{status:400});}return request<T>(`${base}/ai`,{...options,body:JSON.stringify({...JSON.parse(String(options.body)),budgetConfirmed:true,preview:true,conversationId:`workshop-${activity.id}`})});}
  return request<T>(path,options);
 },[request,base,budgetConfirmed,activity.id,onNeedBudget]);
 return <><p>以老师身份上传一份研究卡，体验与学生相同的审核、五次选择、结局和作图流程。试玩按教师用量设置结算，不计入学生学情。</p>{storyId?<><button type="button" onClick={()=>setStoryId('')}>返回剧本审核与构建</button><TeachingStoryPlayer storyId={storyId} activity={activity} base={base} sessionId="teacher-preview" request={previewRequest}/></>:<TeachingStoryStudio activity={activity} base={base} sessionId="teacher-preview" request={previewRequest} shareBase={shareBase} onPlay={setStoryId}/>}</>;
}
