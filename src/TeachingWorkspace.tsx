import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,BookOpen,CheckCheck,Gamepad2,Library,MessageSquareText,Plus,RefreshCw,Search} from 'lucide-react';
import {currentApiIdentity,SESSION_EVENT,type api as Api} from './oneApi';
import type {TeachingCourse,TeachingStage,TeachingTaskKind} from '../server/teachingTypes';
import {TeachingCoursesPage} from './TeachingCoursesPage';
import {TeachingToolPage} from './TeachingToolPage';
import {sameTeacherIdentity} from './teacherTaskState';
import {clearRetiredTeachingDrafts} from './retiredTeachingDrafts';
import {courseSelectionKey} from './teacherCourseState';
import {commitTeachingWorkbenchNavigation,readTeachingWorkbenchRoute,teachingTools,type TeachingWorkbenchRoute} from './teachingWorkbenchNavigation';
import './teaching.css';
import './teacherWorkbench.css';
import './teachingCourses.css';
import './teaching-workbench.css';

const stageLabels={before:'课前',during:'课中',after:'课后'};
const icons={ask:MessageSquareText,game:Gamepad2,quiz:BookOpen,grade:CheckCheck};
/** Courses are a separate resource shelf; each tool owns a single, paged workflow. */
export function TeachingWorkspace({api,active=true,onClose,initialStage}:{api:typeof Api;active?:boolean;initialStage?:TeachingStage;onClose?:()=>void}){
  const [owner,setOwner]=useState(currentApiIdentity),[route,setRoute]=useState(()=>readTeachingWorkbenchRoute(window.location.href));
  const [courses,setCourses]=useState<TeachingCourse[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [filter,setFilter]=useState<TeachingStage|'all'>(initialStage??'all'),[query,setQuery]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),mounted=useRef(true),root=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const activeRef=useRef(active);activeRef.current=active;
  const identityReady=sameTeacherIdentity(owner,currentApiIdentity());
  async function load(){const token=++generation.current,started=currentApiIdentity();setLoading(true);setError('');try{const result=await api<{courses:TeachingCourse[]}>('/api/teaching/courses');if(mounted.current&&token===generation.current&&sameTeacherIdentity(started,currentApiIdentity()))setCourses(result.courses);}catch(e){if(mounted.current&&token===generation.current&&sameTeacherIdentity(started,currentApiIdentity()))setError(e instanceof Error?e.message:'课程暂时未能读取，请重试。');}finally{if(mounted.current&&token===generation.current)setLoading(false);}}
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{const sync=()=>setRoute(readTeachingWorkbenchRoute(window.location.href));window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
  useEffect(()=>{if(active)setRoute(readTeachingWorkbenchRoute(window.location.href));},[active]);
  useEffect(()=>{const reset=()=>{generation.current++;const next=currentApiIdentity();setOwner(next);setCourses([]);setRoute({view:'home'});setNotice('');setQuery('');setFilter('all');try{clearRetiredTeachingDrafts(localStorage,next);}catch{}};window.addEventListener(SESSION_EVENT,reset);return()=>window.removeEventListener(SESSION_EVENT,reset);},[]);
  useEffect(()=>{if(identityReady)try{clearRetiredTeachingDrafts(localStorage,owner);}catch{}},[owner.userId,owner.workspaceId,owner.revision,identityReady]);
  useEffect(()=>{if(active&&(route.view==='home'||route.view==='select'))void load();},[api,active,owner.userId,owner.workspaceId,owner.revision,route.view]);
  useLayoutEffect(()=>{if(!active)return;root.current?.closest('.industry-page-shell')?.scrollTo({top:0});(root.current?.querySelector<HTMLElement>('[data-teaching-page-title],h1,h2')??heading.current)?.focus({preventScroll:true});},[active,route]);
  function navigate(next:TeachingWorkbenchRoute,replace=false){if(!sameTeacherIdentity(owner,currentApiIdentity()))return;commitTeachingWorkbenchNavigation(window,next,activeRef.current,replace);setRoute(next);setQuery('');}
  function rememberCourse(id:string){try{localStorage.setItem(courseSelectionKey(owner),id);}catch{/* Choosing still works without storage. */}}
  function selectCourse(tool:TeachingTaskKind,courseId:string){rememberCourse(courseId);navigate({view:'tool',tool,courseId,step:'list'});}
  function openTool(tool:TeachingTaskKind){let recent='';try{recent=localStorage.getItem(courseSelectionKey(owner))??'';}catch{}if(!loading&&courses.some(course=>course.id===recent))selectCourse(tool,recent);else navigate({view:'select',tool});}
  function home(){navigate({view:'home'});setNotice('');}
  if(!identityReady)return <section className="teaching-workspace teaching-ui"><p role="status">正在切换当前账号的工作台…</p></section>;
  return <section ref={root} className="teaching-ui teaching-workbench-root" aria-label="课程工作台">
    {route.view==='courses'?<TeachingCoursesPage key={`${owner.userId}:${owner.workspaceId}:${owner.revision}:${route.mode}:${route.courseId??'new'}`} api={api} mode={route.mode} courseId={route.courseId} onNavigate={next=>navigate({view:'courses',...next,...(route.returnTool?{returnTool:route.returnTool}:{})})} onHome={home} onSaved={(course,created)=>{rememberCourse(course.id);setNotice(created?`已添加「${course.title}」，现在可以选择工具。`:`「${course.title}」的资料已保存。`);if(route.returnTool)navigate({view:'tool',tool:route.returnTool,courseId:course.id,step:'list'});else navigate({view:'home'});}}/>:
    route.view==='tool'?<TeachingToolPage key={`${owner.userId}:${owner.workspaceId}:${owner.revision}:${route.tool}:${route.courseId}`} api={api} tool={route.tool} courseId={route.courseId} activityId={route.activityId} step={route.step} onNavigate={next=>navigate({view:'tool',tool:route.tool,courseId:next.courseId??route.courseId,...(next.activityId?{activityId:next.activityId}:{}),step:next.step},next.replace)} onBack={home} onManageCourse={courseId=>navigate({view:'courses',mode:'edit',courseId,returnTool:route.tool})} onCourseChange={courseId=>courseId?selectCourse(route.tool,courseId):navigate({view:'select',tool:route.tool})}/>:
    <div className="teaching-workspace teaching-tool-home">
      {route.view==='home'?<>
        <header className="teaching-tool-home-heading"><div><span className="teaching-eyebrow">ONE · 教育教学</span><h1 ref={heading} tabIndex={-1}>课程工作台</h1></div><div className="teaching-home-actions">{onClose?<button type="button" onClick={onClose}><ArrowLeft size={16}/>返回行业工作台</button>:null}<button type="button" onClick={()=>navigate({view:'courses',mode:'list'})}><Library size={17}/>管理课程</button><button type="button" className="teaching-primary" onClick={()=>navigate({view:'courses',mode:'create'})}><Plus size={17}/>添加课程</button></div></header>
        {notice?<p className="teaching-message" role="status">{notice}</p>:null}
        <nav className="teaching-tool-filters" aria-label="教学工具筛选">{(['all','before','during','after'] as const).map(stage=><button type="button" key={stage} aria-pressed={filter===stage} onClick={()=>setFilter(stage)}>{stage==='all'?'全部':stageLabels[stage]}</button>)}</nav>
        <div className="teaching-tool-grid">{teachingTools.filter(tool=>filter==='all'||tool.stage===filter).map(tool=>{const Icon=icons[tool.kind];return <article key={tool.kind} className="teaching-tool-card"><span className="teaching-tool-card-stage">{stageLabels[tool.stage]}</span><span className="teaching-tool-card-icon" aria-hidden="true"><Icon size={25} strokeWidth={1.5}/></span><h2>{tool.title}</h2><p>{tool.description}</p><footer><small>{tool.result}</small><button type="button" aria-label={`打开${tool.title}`} onClick={()=>openTool(tool.kind)}>打开工具<ArrowUpRight size={17}/></button></footer></article>;})}</div>
      </>:route.view==='select'?<>
        <button className="teaching-page-back" type="button" onClick={home}><ArrowLeft size={16}/>课程工作台</button><header className="teaching-course-choice-heading"><div><span className="teaching-eyebrow">{teachingTools.find(tool=>tool.kind===route.tool)?.title}</span><h1 ref={heading} tabIndex={-1}>选择要使用的课程</h1><p>工具会使用这门课的资料，进入后也可以更换。</p></div><button type="button" className="teaching-primary" onClick={()=>navigate({view:'courses',mode:'create',returnTool:route.tool})}><Plus size={17}/>添加课程</button></header>
        {courses.length>5?<label className="teaching-course-search"><Search size={18}/><input aria-label="搜索课程" type="search" placeholder="搜索课程名称" value={query} onChange={e=>setQuery(e.target.value)}/></label>:null}
        {loading?<p role="status" className="teacher-muted">正在读取课程…</p>:courses.length?<div className="teaching-course-choice-list">{courses.filter(course=>`${course.title} ${course.subject}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(course=><button type="button" key={course.id} onClick={()=>selectCourse(route.tool,course.id)}><span className="teaching-course-choice-icon"><BookOpen size={21} strokeWidth={1.5}/></span><span><strong>{course.title}</strong><small>{course.subject?`${course.subject} · `:''}{course.knowledgeSources?.length?`已关联 ${course.knowledgeSources.length} 处知识库`:'尚未关联知识库'}</small></span><ArrowUpRight size={18}/></button>)}</div>:<div className="teaching-course-choice-empty"><BookOpen size={30} strokeWidth={1.5}/><h2>先添加这门课的名称和资料</h2><p>保存一次，之后使用问答、游戏、试卷和批改时都能选到它。</p><button type="button" className="teaching-primary" onClick={()=>navigate({view:'courses',mode:'create',returnTool:route.tool})}><Plus size={17}/>添加第一门课程</button></div>}
        {!loading&&courses.length>0&&!courses.some(course=>`${course.title} ${course.subject}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))?<p role="status" className="teacher-muted">没有找到这门课程，试试其他名称。</p>:null}
      </>:null}
      {error?<div className="teaching-message teaching-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>重试</button></div>:null}
    </div>}
  </section>;
}
export default TeachingWorkspace;
