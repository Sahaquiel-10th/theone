import {useEffect,useRef,useState} from 'react';
import {Check,Download,FileText,RefreshCw,Save,X} from 'lucide-react';
import type {TeachingActivity,TeachingCourse} from '../server/teachingTypes';
import {RubricEditor} from './TeachingActivityEditors';
import {TeachingFileBatch} from './TeachingFileBatch';
import {TeachingKnowledgePicker} from './TeachingKnowledgePicker';
import {currentApiIdentity} from './oneApi';
import {courseViewKey} from './teacherCourseState';
import {activityDraft} from './teachingState';
import {decodeGradingEditor,gradingDraftChanged,gradingFields,gradingUpdatePayload} from './teachingGradingState';
import {sameTeacherIdentity} from './teacherTaskState';
import {teachingDownload} from './teachingDownload';
import type {TeachingRequest,TeachingUpload} from './teachingUploads';

const studyAccept='.docx,.pdf,.png,.jpg,.jpeg,.webp,.txt,.md';
const message=(error:unknown)=>error instanceof Error?error.message:'评分要求暂时未能保存，请核对后重试。';

/** Teacher references can change while a student assignment remains live. */
export function TeachingGradingSettings({request,course,activity,onSaved,onBusy,onDirty,open,onOpenChange}:{request:TeachingRequest;course:TeachingCourse;activity:TeachingActivity;onSaved:(course:TeachingCourse)=>void;onBusy:(value:boolean)=>void;onDirty:(value:boolean)=>void;open:boolean;onOpenChange:(value:boolean)=>void}){
  const owner=useRef(currentApiIdentity()).current,mounted=useRef(true),locked=useRef(false);
  const storageKey=courseViewKey(owner,course.id)+':grading:'+activity.id;
  const [restored]=useState(()=>{try{return decodeGradingEditor(localStorage.getItem(storageKey),owner,course.id,activity);}catch{return;}});
  const [draft,setDraft]=useState(()=>restored?.draft??activityDraft(activity)),[baseRevision,setBaseRevision]=useState(restored?.revision??activity.revision);
  const [files,setFiles]=useState<TeachingUpload[]>([]),[saving,setSaving]=useState(false),[uploading,setUploading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const changed=gradingDraftChanged(draft,activity),stale=baseRevision!==activity.revision;
  useEffect(()=>{mounted.current=true;void request<{attachments:TeachingUpload[]}>(`/api/teaching/courses/${course.id}/uploads`).then(result=>{if(mounted.current)setFiles(result.attachments);}).catch(error=>{if(mounted.current)setError(message(error));});return()=>{mounted.current=false;};},[request,course.id]);
  useEffect(()=>{onBusy(saving||uploading);return()=>onBusy(false);},[saving,uploading,onBusy]);
  useEffect(()=>{onDirty(changed);return()=>onDirty(false);},[changed,onDirty]);
  useEffect(()=>{if(!sameTeacherIdentity(owner,currentApiIdentity()))return;try{if(changed)localStorage.setItem(storageKey,JSON.stringify({workspaceId:owner.workspaceId,userId:owner.userId,courseId:course.id,activityId:activity.id,revision:baseRevision,form:gradingFields(draft)}));else localStorage.removeItem(storageKey);}catch{setError('本机暂时不能保留评分草稿，请保存评分要求后再离开。');}},[draft,baseRevision,changed,storageKey]);
  async function save(){
    if(locked.current)return;locked.current=true;setSaving(true);setError('');setNotice('');
    try{
      if(stale)throw new Error('本活动已更新，请先核对当前评分要求，再保存本机修改。');
      const result=await request<{course:TeachingCourse;activity:TeachingActivity}>(`/api/teaching/courses/${course.id}/activities/${activity.id}/grading`,{method:'PATCH',body:JSON.stringify(gradingUpdatePayload(course,activity,draft))});
      if(!mounted.current)return;
      setDraft(activityDraft(result.activity));setBaseRevision(result.activity.revision);onSaved(result.course);
      setNotice('评分要求已保存，学生链接继续有效。已有作业需逐份确认采用新要求后再批改。');
    }catch(error){if(mounted.current)setError(message(error));}finally{locked.current=false;if(mounted.current)setSaving(false);}
  }
  async function download(id:string){try{await teachingDownload(`/api/teaching/courses/${course.id}/uploads/${encodeURIComponent(id)}/content`,files.find(file=>file.id===id)?.originalName??'教师评分参考');}catch(error){setError(message(error));}}
  async function reconcile(){
    if(locked.current)return;locked.current=true;setSaving(true);setError('');
    try{const result=await request<{course:TeachingCourse}>(`/api/teaching/courses/${course.id}`);const current=result.course.activities.find(item=>item.id===activity.id);if(!current)throw new Error('本活动暂时无法找到，请返回课程列表核对。');if(!mounted.current)return;onSaved(result.course);setBaseRevision(current.revision);setNotice(gradingDraftChanged(draft,current)?'已核对最新版本，本机评分修改仍保留，请比较后再保存。':'评分要求已保存，原保存结果已核对。');}catch(error){if(mounted.current)setError(message(error));}finally{locked.current=false;if(mounted.current)setSaving(false);}
  }
  return <details className="teaching-sheet teaching-grading-settings" open={open} onToggle={event=>onOpenChange(event.currentTarget.open)}>
    <summary><span><strong>本活动评分要求</strong><small>{activity.rubric.length} 个评分项 · 教师参考仅用于评阅</small></span><span>{changed?'有未保存修改':'无需暂停学生入口'}</span></summary>
    <div className="teaching-grading-settings-body">
      <p className="teacher-help">可在收件后补充或调整评分项和教师参考，不改变学生原题目、作业要求或链接。保存后不会自动替换已收作业的评分依据，也不会调用 AI。</p>
      {error?<p className="teaching-message teaching-error" role="alert">{error}</p>:null}{notice?<p className="teaching-message" role="status"><Check size={16}/>{notice}</p>:null}
      {stale?<div className="teaching-message"><span>这份本机评分草稿基于旧版本，尚未覆盖当前要求。</span><button type="button" disabled={saving||uploading} onClick={()=>{setDraft(activityDraft(activity));setBaseRevision(activity.revision);}}>使用当前已保存要求</button><button type="button" disabled={saving||uploading} onClick={()=>setBaseRevision(activity.revision)}>已核对，保留本机修改</button></div>:null}
      <fieldset disabled={saving}>
        <RubricEditor draft={draft} onChange={setDraft}/>
        <label>教师专用参考原文<textarea rows={5} maxLength={120000} value={draft.referenceText} onChange={event=>setDraft(current=>({...current,referenceText:event.target.value}))} placeholder="参考答案、评阅说明和评分依据；不作为学生学习资料。"/></label>
        <TeachingFileBatch request={request} courseId={course.id} label="添加教师专用评分参考" accept={studyAccept} disabled={saving} onBusy={setUploading} onReady={file=>{setFiles(current=>[...current.filter(item=>item.id!==file.id),file]);setDraft(current=>({...current,sourceAttachmentIds:[...new Set([...current.sourceAttachmentIds,file.id])]}));}}/>
        {draft.sourceAttachmentIds.length?<ul className="teaching-file-list">{draft.sourceAttachmentIds.map((id,index)=>{const file=files.find(item=>item.id===id);return <li key={id}><FileText size={16}/><span>{file?.originalName??`教师参考 ${index+1}`}<small>{file?.status==='ready'?'已就绪':'已保存'}</small></span><button type="button" aria-label={`下载 ${file?.originalName??'教师参考'}`} onClick={()=>void download(id)}><Download size={15}/></button><button type="button" disabled={saving||uploading} aria-label={`移出 ${file?.originalName??'教师参考'}`} onClick={()=>setDraft(current=>({...current,sourceAttachmentIds:current.sourceAttachmentIds.filter(value=>value!==id)}))}><X size={15}/></button></li>;})}</ul>:null}
        <TeachingKnowledgePicker request={request} sources={draft.knowledgeSources??[]} privateSource disabled={saving||uploading} onChange={sources=>setDraft(current=>({...current,knowledgeSources:sources}))}/>
        <label>AI 评阅引导（可选）<textarea rows={3} maxLength={12000} value={draft.avatarPrompt??''} onChange={event=>setDraft(current=>({...current,avatarPrompt:event.target.value}))} placeholder="例如先指出已达到的要求，再给出一条具体改进建议；不会替代上面的评分项。"/></label>
      </fieldset>
      <footer><span>保存本活动的要求后，在对应收件中“采用当前评分要求”。已发布的成绩不会改变。</span><div><button type="button" disabled={saving||uploading} onClick={()=>void reconcile()}><RefreshCw size={16}/>核对已保存要求</button><button type="button" className="teaching-primary" disabled={saving||uploading||stale||!changed} onClick={()=>void save()}><Save size={16}/>{saving?'正在保存…':'保存评分要求'}</button></div></footer>
    </div>
  </details>;
}
