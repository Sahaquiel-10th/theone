import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,BookOpen,Check,FileText,Plus,RefreshCw,RotateCcw,Trash2} from 'lucide-react';
import {currentApiIdentity,type api as Api} from './oneApi';
import type {TeachingCourse} from '../server/teachingTypes';
import {TeachingKnowledgePicker} from './TeachingKnowledgePicker';
import type {TeachingRequest} from './teachingUploads';
import {CourseMaterialConflict,clearCourseManagerDraft,clearCoursePurgeAttempt,courseManagerDraftKey,courseMaterialForm,courseMatchesMaterialSave,coursePurgeDraftKey,decodeCourseManagerDraft,decodeCoursePurgeAttempt,emptyCourseMaterialForm,previewCoursePurge,resolveCourseCreation,resolveCourseMaterialSave,resolveCoursePurge,sameCourseMaterials,saveCourseManagerDraft,saveCoursePurgeAttempt,type CourseManagerDraft,type CoursePurgeAttempt,type CoursePurgePreview} from './teachingCourseManagerState';
import './teaching.css';
import './teaching-course-manager.css';

export type TeachingCoursesMode='list'|'create'|'edit'|'trash';
export type TeachingCoursesDestination={mode:TeachingCoursesMode;courseId?:string};
type Props={api:typeof Api;mode:TeachingCoursesMode;courseId?:string;onNavigate:(destination:TeachingCoursesDestination)=>void;onHome:()=>void;onSaved:(course:TeachingCourse,created?:boolean)=>void};
type Owner=ReturnType<typeof currentApiIdentity>;
const message=(error:unknown)=>error instanceof Error?error.message:'暂时未能完成，请稍后再试。';
const knownRejection=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&[400,401,403,404,410,413,422].includes(Number(error.status));
const sameOwner=(owner:Owner)=>{const current=currentApiIdentity();return owner.userId===current.userId&&owner.workspaceId===current.workspaceId&&owner.revision===current.revision;};
const formatDate=(value?:string)=>value?new Date(value).toLocaleDateString('zh-CN'):'';

/** Courses link learning knowledge; exams and student originals belong to their tools. */
export function TeachingCoursesPage(props:Props){
  const owner=useRef(currentApiIdentity()).current;
  const request=useCallback(<T,>(path:string,options?:RequestInit):Promise<T>=>{
    if(!sameOwner(owner))return Promise.reject(new Error('账号或空间已切换，请重新打开课程资料。'));
    return props.api<T>(path,options).then(result=>{if(!sameOwner(owner))throw new Error('账号或空间已切换，原课程操作已保留。');return result;});
  },[props.api,owner]);
  if(!sameOwner(owner))return <section className="teaching-ui teaching-course-manager"><p role="status">正在切换当前账号的课程资料…</p></section>;
  return props.mode==='create'||props.mode==='edit'
    ?<CourseMaterialsEditor key={`${owner.userId}:${owner.workspaceId}:${props.mode}:${props.courseId??'new'}`} {...props} owner={owner} request={request}/>
    :<CourseManagerList key={`${owner.userId}:${owner.workspaceId}:${props.mode}`} {...props} owner={owner} request={request}/>;
}

type Confirmation={action:'trash'|'restore'|'purge';courses:TeachingCourse[];preview?:CoursePurgePreview};
function CourseManagerList({mode,request,owner,onNavigate,onHome}:Props&{request:TeachingRequest;owner:Owner}){
  const trash=mode==='trash',mounted=useRef(true),generation=useRef(0),locked=useRef(false),heading=useRef<HTMLHeadingElement>(null),errorRef=useRef<HTMLParagraphElement>(null),confirmationRef=useRef<HTMLHeadingElement>(null);
  const [courses,setCourses]=useState<TeachingCourse[]>([]),[selected,setSelected]=useState<string[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [confirmation,setConfirmation]=useState<Confirmation>();
  const [purgeAttempt,setPurgeAttempt]=useState<CoursePurgeAttempt|undefined>(()=>{try{return decodeCoursePurgeAttempt(localStorage.getItem(coursePurgeDraftKey(owner)),owner);}catch{return;}});
  const load=useCallback(async()=>{const revision=++generation.current;setLoading(true);setError('');try{const result=await request<{courses:TeachingCourse[]}>(trash?'/api/teaching/trash':'/api/teaching/courses');if(mounted.current&&revision===generation.current){setCourses(result.courses);setSelected(current=>current.filter(id=>result.courses.some(course=>course.id===id)));setConfirmation(undefined);}}catch(error){if(mounted.current&&revision===generation.current)setError(message(error));}finally{if(mounted.current&&revision===generation.current)setLoading(false);}},[request,trash]);
  useEffect(()=>{mounted.current=true;void load();heading.current?.focus({preventScroll:true});return()=>{mounted.current=false;generation.current++;};},[load]);
  useEffect(()=>{if(error){errorRef.current?.focus();errorRef.current?.scrollIntoView({block:'nearest'});}},[error]);
  useEffect(()=>{confirmationRef.current?.focus({preventScroll:true});},[confirmation]);
  function storePurge(attempt:CoursePurgeAttempt){try{saveCoursePurgeAttempt(localStorage,owner,attempt);}catch{throw new Error('本机暂时不能保存删除回执，尚未发送删除请求。请检查浏览器存储后再试。');}setPurgeAttempt(attempt);}
  function forgetPurge(){try{clearCoursePurgeAttempt(localStorage,owner);}catch{}setPurgeAttempt(undefined);}
  async function purge(attempt:CoursePurgeAttempt){
    try{const result=await resolveCoursePurge(request,attempt);if(!mounted.current)return;
      if(result.status==='completed'){forgetPurge();setNotice('课程及确认范围内的内容已彻底删除，财务用量、账本与审计记录保留。');}
      else setNotice(`课程记录已删除，仍有 ${result.remainingFiles} 个原件待清理。请继续核对原删除请求。`);
      setSelected([]);await load();
    }catch(error){if(knownRejection(error)||error&&typeof error==='object'&&'status'in error&&error.status===409)forgetPurge();throw error;}
  }
  async function confirm(){if(locked.current||!confirmation?.courses.length)return;locked.current=true;setBusy(true);setError('');try{
    if(confirmation.action==='purge'){
      if(!trash||!confirmation.preview)throw new Error('请先核对回收站中课程的删除范围。');
      const attempt:CoursePurgeAttempt={requestId:crypto.randomUUID(),impactHash:confirmation.preview.impactHash,items:confirmation.courses.map(course=>({courseId:course.id,revision:course.revision})),titles:confirmation.courses.map(course=>course.title),confirmed:true};
      storePurge(attempt);await purge(attempt);
    }else{
      await request(confirmation.action==='restore'?'/api/teaching/restore':'/api/teaching/trash',{method:'POST',body:JSON.stringify({confirmed:true,items:confirmation.courses.map(course=>({courseId:course.id,revision:course.revision}))})});
      if(!mounted.current)return;setNotice(confirmation.action==='restore'?'课程已恢复，学生入口保持关闭。':'课程已移入回收站，原提交、成绩和账本均保留。');setSelected([]);await load();
    }
  }catch(error){if(mounted.current)setError(`${message(error)}${purgeAttempt?'':' 请刷新列表核对原结果。'}`);}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  async function preparePurge(rows:TeachingCourse[]){if(!trash||locked.current||purgeAttempt)return;locked.current=true;setBusy(true);setError('');try{const preview=await previewCoursePurge(request,rows.map(course=>({courseId:course.id,revision:course.revision})));if(mounted.current)setConfirmation({action:'purge',courses:rows,preview});}catch(error){if(mounted.current)setError(message(error));}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  async function reconcilePurge(){if(!purgeAttempt||locked.current)return;locked.current=true;setBusy(true);setError('');try{await purge(purgeAttempt);}catch(error){if(mounted.current)setError(message(error));}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  const picked=courses.filter(course=>selected.includes(course.id)),mutating=busy||!!purgeAttempt;
  return <section className="teaching-ui teaching-course-manager" aria-label={trash?'课程回收站':'课程资料管理'}>
    <header className="course-manager-heading"><div><button type="button" className="course-manager-back" onClick={onHome}><ArrowLeft size={16}/>返回课程工作台</button><h1 ref={heading} tabIndex={-1}>{trash?'课程回收站':'课程资料'}</h1></div><div>{trash?<button type="button" onClick={()=>onNavigate({mode:'list'})}>返回课程列表</button>:<><button type="button" onClick={()=>onNavigate({mode:'trash'})}><Trash2 size={16}/>回收站</button><button type="button" className="teaching-primary" onClick={()=>onNavigate({mode:'create'})}><Plus size={16}/>新建课程</button></>}</div></header>
    {error?<p ref={errorRef} tabIndex={-1} className="teaching-message teaching-error" role="alert">{error}</p>:null}{notice?<p className="teaching-message" role="status"><Check size={16}/>{notice}</p>:null}
    {purgeAttempt?<section className="course-manager-pending" aria-label="待核对的彻底删除"><h2>原删除结果待核对</h2><p>{purgeAttempt.titles.join('、')}</p><button type="button" disabled={busy} onClick={()=>void reconcilePurge()}><RefreshCw size={16}/>{busy?'正在核对…':'核对原删除请求'}</button></section>:null}
    {trash?<p className="course-manager-impact">课程可恢复；彻底删除后无法找回。恢复不会自动开放学生入口。</p>:null}
    {confirmation?<section className={`course-manager-confirm${confirmation.action==='purge'?' course-manager-confirm-danger':''}`} aria-label={confirmation.action==='purge'?'确认彻底删除课程':confirmation.action==='restore'?'确认恢复课程':'确认移入回收站'}><h2 ref={confirmationRef} tabIndex={-1}>{confirmation.action==='purge'?'彻底删除':confirmation.action==='restore'?'恢复':'移入回收站'}这 {confirmation.courses.length} 门课程？</h2><ul>{confirmation.courses.map(course=><li key={course.id}>{course.title}</li>)}</ul>
      {confirmation.preview?<><dl className="course-manager-purge-impact"><div><dt>课程</dt><dd>{confirmation.preview.impact.courses}</dd></div><div><dt>教学保存项</dt><dd>{confirmation.preview.impact.activities}</dd></div><div><dt>学生参与身份</dt><dd>{confirmation.preview.impact.sessions}</dd></div><div><dt>原提交与成绩</dt><dd>{confirmation.preview.impact.submissions}</dd></div>{confirmation.preview.impact.scriptSubmissions?<div><dt>学生提交的剧本</dt><dd>{confirmation.preview.impact.scriptSubmissions}</dd></div>:null}<div><dt>AI 操作记录</dt><dd>{confirmation.preview.impact.operations}</dd></div><div><dt>原件文件</dt><dd>{confirmation.preview.impact.files}</dd></div></dl><p>以上内容将永久删除，无法恢复。{confirmation.preview.impact.retainedFiles?`另有 ${confirmation.preview.impact.retainedFiles} 个仍被其他内容引用的文件将保留。`:''}财务用量、账本与审计记录保留。</p></>:<p>{confirmation.action==='restore'?'课程及原有保存项将重新出现在工作台。原提交与成绩保留，学生入口保持关闭。':'课程与关联保存项将隐藏，学生入口关闭。原提交、成绩与账本保留，可以在回收站恢复。'}</p>}
      <div><button type="button" disabled={busy} onClick={()=>setConfirmation(undefined)}>取消</button><button type="button" className={confirmation.action==='purge'?'course-manager-danger':'teaching-primary'} disabled={busy||!!purgeAttempt} onClick={()=>void confirm()}>{busy?'正在处理…':confirmation.action==='purge'?'确认彻底删除，不可恢复':confirmation.action==='restore'?'确认恢复':'确认移入回收站'}</button></div></section>:null}
    <div inert={!!confirmation||undefined}><div className="course-manager-list-tools"><label className="teaching-check"><input type="checkbox" checked={courses.length>0&&picked.length===courses.length} disabled={loading||mutating||!courses.length} onChange={event=>setSelected(event.target.checked?courses.map(course=>course.id):[])}/>全选{picked.length?` · 已选 ${picked.length} 门`:''}</label><div>{picked.length?<><button type="button" disabled={mutating} onClick={()=>setConfirmation({action:trash?'restore':'trash',courses:picked})}>{trash?<RotateCcw size={16}/>:<Trash2 size={16}/>}批量{trash?'恢复':'移入回收站'}</button>{trash?<button type="button" className="course-manager-danger" disabled={mutating} onClick={()=>void preparePurge(picked)}><Trash2 size={16}/>彻底删除所选</button>:null}</>:null}<button type="button" disabled={busy||loading} onClick={()=>void load()}><RefreshCw size={16}/>刷新</button></div></div>
    {loading?<p className="course-manager-loading" role="status">正在读取课程…</p>:null}
    {!loading&&!courses.length?<div className="course-manager-empty">{trash?<Trash2 size={28}/>:<BookOpen size={28}/>}<h2>{trash?'回收站里还没有课程':'先准备一门课程'}</h2>{!trash?<button type="button" onClick={()=>onNavigate({mode:'create'})}><Plus size={16}/>新建课程</button>:null}</div>:<ul className="course-manager-list">{courses.map(course=><li key={course.id}><label className="course-manager-course-check"><input type="checkbox" aria-label={`选择课程：${course.title}`} checked={selected.includes(course.id)} disabled={mutating} onChange={event=>setSelected(current=>event.target.checked?[...current,course.id]:current.filter(id=>id!==course.id))}/></label><div className="course-manager-course-name"><h2>{course.title}</h2><p>{course.subject?`${course.subject} · `:''}{course.knowledgeSources?.length??0} 处知识库关联</p><small>{trash?'移入回收站':'更新于'} {formatDate(trash?course.deletedAt:course.updatedAt)}</small></div><div className="course-manager-row-actions">{trash?<><button type="button" disabled={mutating} onClick={()=>setConfirmation({action:'restore',courses:[course]})}><RotateCcw size={16}/>恢复课程</button><button type="button" className="course-manager-danger" disabled={mutating} onClick={()=>void preparePurge([course])}><Trash2 size={16}/>彻底删除</button></>:<><button type="button" disabled={mutating} onClick={()=>onNavigate({mode:'edit',courseId:course.id})}><FileText size={16}/>编辑资料</button><button type="button" disabled={mutating} onClick={()=>setConfirmation({action:'trash',courses:[course]})}><Trash2 size={16}/>删除</button></>}</div></li>)}</ul>}</div>
  </section>;
}

function CourseMaterialsEditor({mode,courseId,request,owner,onNavigate,onHome,onSaved}:Props&{request:TeachingRequest;owner:Owner}){
  const creating=mode==='create',storageKey=courseManagerDraftKey(owner,creating?undefined:courseId),mounted=useRef(true),locked=useRef(false),creatingPromise=useRef<Promise<TeachingCourse>|undefined>(undefined),courseRef=useRef<TeachingCourse|undefined>(undefined);
  const [draft,setDraft]=useState<CourseManagerDraft>(()=>{try{const restored=decodeCourseManagerDraft(localStorage.getItem(storageKey),owner);if(restored&&(!courseId||!restored.remoteId||restored.remoteId===courseId))return restored;}catch{}return {form:emptyCourseMaterialForm(),files:[]};});
  const draftRef=useRef(draft);draftRef.current=draft;
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState<TeachingCourse>(),[leave,setLeave]=useState<()=>void>();
  const heading=useRef<HTMLHeadingElement>(null),errorRef=useRef<HTMLParagraphElement>(null);
  const currentCourse=courseRef.current,form=draft.form,pending=!!draft.createAttempt||!!draft.saveAttempt,dirty=!draft.baseForm?!sameCourseMaterials(form,emptyCourseMaterialForm()):!sameCourseMaterials(form,draft.baseForm);
  function update(change:CourseManagerDraft|((current:CourseManagerDraft)=>CourseManagerDraft),strict=false){
    if(!sameOwner(owner))return;const next=typeof change==='function'?change(draftRef.current):change;
    try{saveCourseManagerDraft(localStorage,storageKey,owner,next);}catch{if(strict)throw new Error('本机暂时不能保存课程草稿，请检查浏览器存储后重试；原请求没有重新发送。');if(mounted.current)setError('本机暂时不能保存草稿。请保留本页，恢复浏览器存储后再保存。');}
    draftRef.current=next;if(mounted.current)setDraft(next);
  }
  function finish(course:TeachingCourse){try{clearCourseManagerDraft(localStorage,storageKey);}catch{}if(mounted.current&&sameOwner(owner))onSaved(course,creating);}
  function accept(course:TeachingCourse){courseRef.current=course;}
  useEffect(()=>{mounted.current=true;let active=true;heading.current?.focus({preventScroll:true});const load=async()=>{let id=courseId??draftRef.current.remoteId;if(!id&&draftRef.current.createAttempt){const result=await request<{courses:TeachingCourse[]}>('/api/teaching/courses');id=result.courses.find(course=>course.clientCreateKey===draftRef.current.createAttempt?.clientRequestId)?.id;}
    if(!id){if(!creating)throw new Error('课程编号缺失，请返回课程列表重新选择。');return;}
    const {course}=await request<{course:TeachingCourse}>(`/api/teaching/courses/${encodeURIComponent(id)}`);if(!active)return;accept(course);const saved=draftRef.current,remoteForm=courseMaterialForm(course);
    if(saved.saveAttempt&&courseMatchesMaterialSave(course,saved.saveAttempt.payload)){finish(course);return;}
    if(saved.saveAttempt&&saved.saveAttempt.revision!==course.revision||saved.baseRevision&&saved.baseRevision!==course.revision&&saved.baseForm&&!sameCourseMaterials(saved.form,saved.baseForm))setConflict(course);
    update({...saved,remoteId:course.id,createAttempt:undefined,baseRevision:saved.baseRevision??course.revision,baseForm:saved.baseForm??remoteForm,form:saved.baseForm||saved.createAttempt?saved.form:remoteForm});
  };void load().catch(error=>{if(active)setError(message(error));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;mounted.current=false;};},[courseId,creating,request]);
  useEffect(()=>{if(error){errorRef.current?.focus();errorRef.current?.scrollIntoView({block:'nearest'});}},[error]);
  useEffect(()=>{if(!dirty&&!pending)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,pending]);
  async function ensureCourse():Promise<TeachingCourse>{
    if(courseRef.current)return courseRef.current;if(creatingPromise.current)return creatingPromise.current;
    if(!creating){if(!courseId)throw new Error('请返回课程列表重新选择课程。');const course=(await request<{course:TeachingCourse}>(`/api/teaching/courses/${encodeURIComponent(courseId)}`)).course;const local=draftRef.current;if(local.baseRevision&&local.baseRevision!==course.revision&&local.baseForm&&!sameCourseMaterials(local.form,local.baseForm))throw new CourseMaterialConflict(course);accept(course);update(current=>({...current,remoteId:course.id,baseRevision:course.revision,baseForm:courseMaterialForm(course)}));return course;}
    const saved=draftRef.current;if(!saved.form.title.trim()&&!saved.createAttempt)throw new Error('请先填写课程名称。');
    const attempt=saved.createAttempt??{clientRequestId:crypto.randomUUID(),payload:structuredClone(saved.form)};update({...saved,createAttempt:attempt},true);
    creatingPromise.current=resolveCourseCreation(request,attempt,!!saved.createAttempt).then(course=>{accept(course);update(current=>({...current,remoteId:course.id,createAttempt:undefined,baseRevision:course.revision,baseForm:courseMaterialForm(course)}),true);return course;}).catch(error=>{if(knownRejection(error))update(current=>({...current,createAttempt:undefined}));throw error;}).finally(()=>{creatingPromise.current=undefined;});return creatingPromise.current;
  }
  async function run(action:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(error){if(mounted.current&&sameOwner(owner)){if(error instanceof CourseMaterialConflict)setConflict(error.course);setError(message(error));}}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  async function save(){await run(async()=>{if(conflict)throw new Error('请先核对其他页面保存的版本。');const course=await ensureCourse();if(!mounted.current)return;const saved=draftRef.current,attempt=saved.saveAttempt??{courseId:course.id,revision:course.revision,payload:structuredClone(saved.form)};update({...saved,saveAttempt:attempt},true);try{const result=await resolveCourseMaterialSave(request,attempt);accept(result);finish(result);}catch(error){if(knownRejection(error)&&!(error instanceof CourseMaterialConflict))update(current=>({...current,saveAttempt:undefined}));throw error;}});}
  function navigate(action:()=>void){if(dirty||pending){setLeave(()=>action);return;}action();}
  const lockedForm=busy||loading||pending||!!conflict;
  return <section className="teaching-ui teaching-course-manager" aria-label={creating?'新建课程资料':'编辑课程资料'}>
    <header className="course-manager-heading"><div><button type="button" className="course-manager-back" onClick={()=>navigate(onHome)}><ArrowLeft size={16}/>返回课程工作台</button><h1 ref={heading} tabIndex={-1}>{creating?'新建课程':'编辑课程资料'}</h1></div><button type="button" onClick={()=>navigate(()=>onNavigate({mode:'list'}))}>课程列表</button></header>
    {error?<p ref={errorRef} tabIndex={-1} className="teaching-message teaching-error" role="alert">{error}</p>:null}{notice?<p className="teaching-message" role="status">{notice}</p>:null}
    {leave?<section className="course-manager-confirm"><h2>保留草稿并返回？</h2><p>本机草稿会保留，未保存的修改还没有应用到课程。</p><div><button type="button" onClick={()=>setLeave(undefined)}>继续编辑</button><button type="button" onClick={()=>{const action=leave;setLeave(undefined);action();}}>保留草稿并返回</button></div></section>:null}
    {conflict?<section className="course-manager-confirm"><h2>先核对课程最新版本</h2><p>服务器当前课程为“{conflict.title}”，关联 {conflict.knowledgeSources?.length??0} 处知识库。你的本机修改仍保留。</p><div><button type="button" onClick={()=>{accept(conflict);update({...draftRef.current,form:courseMaterialForm(conflict),remoteId:conflict.id,baseRevision:conflict.revision,baseForm:courseMaterialForm(conflict),createAttempt:undefined,saveAttempt:undefined});setConflict(undefined);setError('');}}>使用服务器最新资料</button><button type="button" onClick={()=>{accept(conflict);update(current=>({...current,remoteId:conflict.id,baseRevision:conflict.revision,baseForm:courseMaterialForm(conflict),saveAttempt:undefined}));setConflict(undefined);setError('');}}>保留我的修改继续编辑</button></div></section>:null}
    {pending?<p className="teaching-message" role="status">{draft.createAttempt?'原课程创建结果待核对。':'原保存结果待核对。'}<button type="button" disabled={busy} onClick={()=>void save()}>核对原请求</button></p>:null}
    {loading?<p role="status" className="course-manager-loading">正在读取课程资料…</p>:<form className="course-manager-form" inert={!!leave||undefined} onSubmit={event=>{event.preventDefault();void save();}}>
      <fieldset disabled={lockedForm}><div className="course-manager-name-fields"><label>课程名称<input required autoComplete="off" maxLength={160} value={form.title} onChange={event=>update(current=>({...current,form:{...current.form,title:event.target.value}}))} placeholder="例如：城市文化导论"/></label><label>学科 / 主题（可选）<input maxLength={120} value={form.subject} onChange={event=>update(current=>({...current,form:{...current.form,subject:event.target.value}}))} placeholder="例如：人文通识"/></label></div></fieldset>
      <TeachingKnowledgePicker request={request} sources={form.knowledgeSources} savedSources={currentCourse?.knowledgeSources??[]} querySeed={[form.title,form.subject].filter(Boolean).join(' ')} courseId={currentCourse?.id} defaultOpen onChange={sources=>update(current=>({...current,form:{...current.form,knowledgeSources:sources}}))} privateSource={false} disabled={lockedForm}/>
      <footer className="course-manager-save"><button type="submit" className="teaching-primary" disabled={busy||loading||!!conflict||(!form.title.trim()&&!pending)}><Check size={17}/>{busy?'正在核对保存…':pending?'核对并完成保存':creating?'保存课程并返回':'保存资料并返回'}</button></footer>
    </form>}
  </section>;
}
export default TeachingCoursesPage;
