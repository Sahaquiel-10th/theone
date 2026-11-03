import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,BookOpen,ClipboardCheck,FileQuestion,Gamepad2,MessagesSquare,Plus} from 'lucide-react';
import {currentApiIdentity,SESSION_EVENT,type api as Api} from './oneApi';
import type {TeachingCourse,TeachingStage,TeachingTaskKind} from '../server/teachingTypes';
import {TeachingAdvancedWorkspace} from './TeachingAdvancedWorkspace';
import {TeacherTaskFlow} from './TeacherTaskFlow';
import {decodeTeacherDrafts,draftFromTeachingCourse,encodeTeacherDrafts,newTeacherTask,sameTeacherIdentity,taskInfo,teacherDraftStorageKey,teacherTasks,type TeacherTaskDraft} from './teacherTaskState';
import './teaching.css';
import './teacherWorkbench.css';

const taskIcons={grade:ClipboardCheck,ask:MessagesSquare,quiz:FileQuestion,game:Gamepad2};
export function TeachingWorkspace({api,onClose}:{api:typeof Api;initialStage?:TeachingStage;onClose?:()=>void}){
  const identity=currentApiIdentity(),[owner,setOwner]=useState(identity);
  const [drafts,setDrafts]=useState<TeacherTaskDraft[]>(()=>{try{return decodeTeacherDrafts(localStorage.getItem(teacherDraftStorageKey(identity)),identity);}catch{return [];}});
  const [selected,setSelected]=useState(''),[advanced,setAdvanced]=useState<string|undefined>(),[courses,setCourses]=useState<TeachingCourse[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[storageError,setStorageError]=useState('');
  const draftsRef=useRef(drafts);draftsRef.current=drafts;
  const active=sameTeacherIdentity(identity,owner),draft=active?drafts.find(item=>item.id===selected):undefined;
  useEffect(()=>{const reset=()=>{const next=currentApiIdentity();setOwner(next);setSelected('');setAdvanced(undefined);setCourses([]);try{setDrafts(decodeTeacherDrafts(localStorage.getItem(teacherDraftStorageKey(next)),next));}catch{setDrafts([]);}};if(!sameTeacherIdentity(owner,identity))reset();window.addEventListener(SESSION_EVENT,reset);return()=>window.removeEventListener(SESSION_EVENT,reset);},[identity.userId,identity.workspaceId,identity.revision]);
  useEffect(()=>{if(!sameTeacherIdentity(owner,currentApiIdentity())||!owner.userId||!owner.workspaceId)return;try{localStorage.setItem(teacherDraftStorageKey(owner),encodeTeacherDrafts(drafts,owner));setStorageError('');}catch{setStorageError('此浏览器暂时无法保留本地草稿。请在离开前保存到 ONE。');}},[drafts,owner]);
  useEffect(()=>{let live=true;const started=currentApiIdentity();setLoading(true);void api<{courses:TeachingCourse[]}>('/api/teaching/courses').then(result=>{if(live&&sameTeacherIdentity(started,currentApiIdentity()))setCourses(result.courses);}).catch(e=>{if(live&&sameTeacherIdentity(started,currentApiIdentity()))setError(e instanceof Error?e.message:'暂时无法读取已保存的任务。');}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api,owner.userId,owner.workspaceId,owner.revision,selected,advanced]);
  function update(next:TeacherTaskDraft){if(!sameTeacherIdentity(owner,currentApiIdentity()))return;const values=[next,...draftsRef.current.filter(item=>item.id!==next.id)].slice(0,30);draftsRef.current=values;try{localStorage.setItem(teacherDraftStorageKey(owner),encodeTeacherDrafts(values,owner));}catch{setStorageError('此浏览器暂时无法保留本地草稿。请在离开前保存到 ONE。');}setDrafts(values);}
  function start(kind:TeachingTaskKind){const next=newTeacherTask(kind,crypto.randomUUID());update(next);setSelected(next.id);setError('');}
  function resume(course:TeachingCourse){const existing=drafts.find(item=>item.remote?.courseId===course.id);if(existing){setSelected(existing.id);return;}const activity=course.activities[0];if(!course.taskKind||!activity){setAdvanced(course.id);return;}const next=draftFromTeachingCourse(course,activity);update(next);setSelected(next.id);}
  if(!active)return <section className="teaching-workspace teaching-ui"><p role="status">正在切换账号的教师工作台…</p></section>;
  if(advanced!==undefined)return <TeachingAdvancedWorkspace api={api} initialCourseId={advanced||undefined} onClose={()=>setAdvanced(undefined)}/>;
  if(draft)return <TeacherTaskFlow key={`${owner.userId}:${owner.workspaceId}:${owner.revision}:${draft.id}`} api={api} identity={owner} draft={draft} onChange={update} onHome={()=>setSelected('')} onManage={()=>setAdvanced(draft.remote?.courseId??'')} storageError={storageError}/>;
  const localIds=new Set(drafts.flatMap(d=>d.remote?[d.remote.courseId]:[])),saved=courses.filter(course=>!localIds.has(course.id));
  return <section className="teaching-workspace teaching-ui teacher-workbench" aria-label="教师工作台">
    <header className="teacher-workbench-heading"><div><span className="teaching-eyebrow">ONE · 教师工作台</span><h2>今天想完成什么？</h2><p>从手上的教学任务开始，跟着步骤准备、试用，再交给学生。</p></div>{onClose?<button type="button" onClick={onClose}><ArrowLeft size={16}/>返回功能</button>:null}</header>
    {error?<p className="teaching-message teaching-error" role="alert">{error}</p>:null}{storageError?<p className="teaching-message" role="status">{storageError}</p>:null}
    <div className="teacher-task-launchers">{teacherTasks.map(task=>{const Icon=taskIcons[task.kind];return <button type="button" key={task.kind} onClick={()=>start(task.kind)}><span className="teacher-task-icon"><Icon size={24} strokeWidth={1.5}/></span><span><strong>{task.title}</strong><span>{task.description}</span><small>{task.steps.join(' → ')}</small></span><ArrowRight size={18}/></button>;})}</div>
    <section className="teacher-recent" aria-labelledby="teacher-recent-title"><header><div><h3 id="teacher-recent-title">继续手上的任务</h3><p>未完成的准备和已发出的任务都留在这里。</p></div><button type="button" onClick={()=>setAdvanced('')}><BookOpen size={16}/>已有课程与收件</button></header>
      {loading?<p className="teacher-muted" role="status">正在读取已保存任务…</p>:null}
      {!drafts.length&&!saved.length&&!loading?<div className="teacher-home-empty"><Plus size={20}/><p>还没有教学任务。选上面一项，就可以开始；无需先建课程。</p></div>:null}
      <div className="teacher-recent-list">{drafts.map(item=>{const remote=courses.find(c=>c.id===item.remote?.courseId);return <button type="button" key={item.id} onClick={()=>setSelected(item.id)}><span><small>{taskInfo(item.kind).title} · {remote?.status==='published'?'学生入口已开放':`第 ${item.step+1} 步 · ${taskInfo(item.kind).steps[item.step]}`}</small><strong>{item.title||'未命名的准备'}</strong><span>{remote?'已保存到 ONE':'本浏览器草稿'}</span></span><ArrowRight size={18}/></button>;})}{saved.map(course=><button type="button" key={course.id} onClick={()=>resume(course)}><span><small>{course.taskKind?taskInfo(course.taskKind).title:'已有课程'} · {course.status==='published'?'学生入口已开放':'已保存'}</small><strong>{course.title}</strong><span>{course.activities.length} 个教学活动</span></span><ArrowRight size={18}/></button>)}</div>
    </section>
  </section>;
}
export default TeachingWorkspace;
