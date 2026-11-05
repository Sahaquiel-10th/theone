import {useCallback,useMemo,useRef,useState} from 'react';
import type {TeachingActivity,TeachingCourse} from '../server/teachingTypes';
import {TeachingStoryStudio,TeachingStoryPlayer} from './TeachingStoryStudio';
import {TeachingStorySourceRepair} from './TeachingStorySourceRepair';
import {teachingStoryPreviewRequest} from './teachingStoryRequest';
type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
export function TeachingGameWorkshop({activity,courseId,request,shareBase,budgetConfirmed,onNeedBudget,onCourseSaved}:{activity:TeachingActivity;courseId:string;request:Request;shareBase:string;budgetConfirmed:boolean;onNeedBudget:()=>Promise<boolean>;onCourseSaved:(course:TeachingCourse)=>void}){
 const [storyId,setStoryId]=useState(''),[repair,setRepair]=useState(false),[notice,setNotice]=useState(''),[sourceRepairVersion,setSourceRepairVersion]=useState(0),base=`/api/teaching/courses/${courseId}`;
 const confirmed=useRef(budgetConfirmed);confirmed.current=budgetConfirmed;
 const onProblem=useCallback(()=>setRepair(true),[]);
 const previewRequest=useMemo(()=>teachingStoryPreviewRequest({base,activityId:activity.id,request,budgetConfirmed:()=>confirmed.current,confirmBudget:onNeedBudget,onKnowledgeProblem:onProblem}),[request,base,activity.id,onNeedBudget,onProblem]);
 return <>{notice?<p className="teaching-message" role="status">{notice}</p>:null}{repair?<TeachingStorySourceRepair courseId={courseId} request={request} onCancel={()=>setRepair(false)} onSaved={course=>{onCourseSaved(course);setSourceRepairVersion(value=>value+1);setRepair(false);setNotice('课程资料已更新，上传的剧本仍在。点击提交审核即可继续。');}}/>:null}<div hidden={repair}>{storyId?<><button type="button" onClick={()=>setStoryId('')}>返回剧本审核与构建</button><TeachingStoryPlayer storyId={storyId} activity={activity} base={base} sessionId="teacher-preview" request={previewRequest}/></>:<TeachingStoryStudio activity={activity} base={base} sessionId="teacher-preview" request={previewRequest} shareBase={shareBase} onPlay={setStoryId} onRepairSources={()=>setRepair(true)} sourceRepairVersion={sourceRepairVersion}/>}</div></>;
}
