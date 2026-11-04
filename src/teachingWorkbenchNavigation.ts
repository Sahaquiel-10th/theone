import type {TeachingStage, TeachingTaskKind} from '../server/teachingTypes';

export const teachingTools: {kind:TeachingTaskKind;title:string;stage:TeachingStage;description:string;result:string}[] = [
  {kind:'ask',title:'知识问答辅导',stage:'before',description:'用课程资料回答学生问题，按你的引导帮助他们理解。',result:'试问满意后，分享学生提问链接'},
  {kind:'game',title:'文字游戏构建',stage:'during',description:'设置故事背景、角色和规则，把课堂知识放进文字游戏。',result:'先试玩，再让学生进入游戏'},
  {kind:'quiz',title:'上传试卷',stage:'after',description:'上传你已有的试卷，整理并校对题目、答案和分值。',result:'发布在线测验，查看学生答卷'},
  {kind:'grade',title:'批改作业',stage:'after',description:'发链接收作业，或由老师批量上传，再按评分要求批改。',result:'AI 提出建议，老师复核后发布成绩'},
];
export type TeachingCourseMode='list'|'create'|'edit'|'trash';
export type TeachingWorkbenchRoute=
  |{view:'home'}
  |{view:'select';tool:TeachingTaskKind}
  |{view:'tool';tool:TeachingTaskKind;courseId:string;activityId?:string;step:string}
  |{view:'courses';mode:TeachingCourseMode;courseId?:string;returnTool?:TeachingTaskKind}
  |{view:'legacy';draftId?:string};
const keys=['tView','tTool','tCourse','tItem','tStep','tMode','tReturn','tDraft'] as const;
const tools=teachingTools.map(tool=>tool.kind);
const id=(value:string|null)=>value&&/^[A-Za-z0-9_-]{1,160}$/.test(value)?value:undefined;
const tool=(value:string|null)=>tools.includes(value as TeachingTaskKind)?value as TeachingTaskKind:undefined;
const steps:Record<TeachingTaskKind,readonly string[]>={ask:['list','setup','preview','share','trash'],game:['list','setup','play','share','trash'],quiz:['list','upload','review','publish','answers','trash'],grade:['list','submissions','grading','results','trash']};
/** Only enums and opaque record IDs belong in navigation. Prompts and names stay private. */
export function readTeachingWorkbenchRoute(href:string):TeachingWorkbenchRoute{
  const url=new URL(href);if(!/^\/workbenches\/teaching\/?$/.test(url.pathname))return {view:'home'};
  const p=url.searchParams,kind=tool(p.get('tTool')),courseId=id(p.get('tCourse'));
  if(p.get('tView')==='select'&&kind)return {view:'select',tool:kind};
  if(p.get('tView')==='tool'&&kind&&courseId){const activityId=id(p.get('tItem')),step=p.get('tStep')??'list';return {view:'tool',tool:kind,courseId,...(activityId?{activityId}:{}),step:steps[kind].includes(step)?step:'list'};}
  if(p.get('tView')==='courses'){
    const raw=p.get('tMode'),mode:TeachingCourseMode=raw==='create'||raw==='edit'||raw==='trash'?raw:'list',returnTool=tool(p.get('tReturn'));
    return {view:'courses',mode:mode==='edit'&&!courseId?'list':mode,...(mode==='edit'&&courseId?{courseId}:{}),...(returnTool?{returnTool}:{})};
  }
  if(p.get('tView')==='legacy')return {view:'legacy',...(id(p.get('tDraft'))?{draftId:id(p.get('tDraft'))}:{})};
  return {view:'home'};
}
export function clearTeachingWorkbenchParams(url:URL){for(const key of keys)url.searchParams.delete(key);}
export function teachingWorkbenchHref(href:string,route:TeachingWorkbenchRoute){
  const url=new URL(href);url.pathname='/workbenches/teaching';clearTeachingWorkbenchParams(url);
  if(route.view!=='home')url.searchParams.set('tView',route.view);
  if(route.view==='select'||route.view==='tool')url.searchParams.set('tTool',route.tool);
  if(route.view==='tool'){url.searchParams.set('tCourse',route.courseId);url.searchParams.set('tStep',route.step);if(route.activityId)url.searchParams.set('tItem',route.activityId);}
  if(route.view==='courses'){url.searchParams.set('tMode',route.mode);if(route.courseId)url.searchParams.set('tCourse',route.courseId);if(route.returnTool)url.searchParams.set('tReturn',route.returnTool);}
  if(route.view==='legacy'&&route.draftId)url.searchParams.set('tDraft',route.draftId);
  return `${url.pathname}${url.search}${url.hash}`;
}

type TeachingNavigationBrowser={location:{href:string};history:Pick<History,'state'|'pushState'|'replaceState'>};
/** A retained, hidden tool may finish saving after the teacher has left it.
 * Preserve its receipt without changing the teacher's new page or history. */
export function commitTeachingWorkbenchNavigation(browser:TeachingNavigationBrowser,route:TeachingWorkbenchRoute,active:boolean,replace=false){
  const current=new URL(browser.location.href);
  if(!active||!/^\/workbenches\/teaching\/?$/.test(current.pathname))return false;
  const href=teachingWorkbenchHref(current.href,route);
  if(`${current.pathname}${current.search}${current.hash}`!==href)browser.history[replace?'replaceState':'pushState'](browser.history.state,'',href);
  return true;
}
