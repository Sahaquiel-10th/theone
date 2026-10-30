import {useMemo,useState} from 'react';
import {PracticeOnboarding} from './PracticeOnboarding';
import type {api} from './oneApi';
import type {PracticeView} from '../server/onboardingPractice';

export type PracticePreviewScene='choose'|'running'|'result'|'web'|'failure'|'complete';
const scenes=[['choose','选真实资料'],['running','任务处理中'],['result','正文已返回'],['web','网页已返回'],['failure','失败与恢复'],['complete','短回顾']] as const;
const firstId='preview_first_operation_012345',webId='preview_web_operation_012345',taskId='preview_task_012345',journeyId='preview_journey_012345';
export function practicePreviewView(scene:PracticePreviewScene):PracticeView{
  const base:PracticeView={connections:[{id:'preview_notes_012345',name:'Notion · 我的笔记'}],webFeature:{id:'preview_html_012345',name:'交互说明网页',releaseId:'preview_release_012345',version:1,multiplier:.6},approvalThreshold:2,displayName:'小张'};
  if(scene==='choose')return base;
  const first={operationId:firstId,taskId,state:'completed' as const,resultMessageId:'preview_article_result',outcome:'completed',excerpt:'读书会不必从一份复杂方案开始。\n\n先确认大家读同一篇短文，每人带来一个印象最深的观点。把两小时分成认识彼此、分享观点、交流应用和写下行动四段。\n\n场地、日期和预算仍待确认。'};
  const practice:NonNullable<PracticeView['practice']>={id:'preview_practice_012345',journeyId,source:{title:'我上次组织读书会的准备笔记',platform:'Notion',sample:false},goal:'plan',topic:'把这次读书会的经验整理成下次能复用的行动方案',prompt:'请依据我选中的读书会笔记，整理一份具体的行动方案。',webPrompt:'把刚才这份实际完成的方案做成可以浏览、展开步骤的互动网页，保留待确认事项。',first};
  if(scene==='running')practice.first={operationId:firstId,taskId,state:'running'};
  if(scene==='failure')practice.first={operationId:firstId,taskId,state:'failed',outcome:'needs_input',resultMessageId:'preview_feedback',excerpt:'这份笔记里没有确定的活动日期。可以先告诉我希望哪天举办，我会保留已有安排，从缺少的这一点继续。'};
  if(scene==='web'||scene==='complete')practice.web={operationId:webId,taskId:'preview_web_task_012345',state:'completed',outcome:'completed',resultMessageId:'preview_web_result',excerpt:'已将同一份方案整理成互动网页，保留原有事实和待确认事项。',attachment:{id:'preview_web_file_012345',name:'读书会行动方案.html',openUrl:'/preview-only',downloadUrl:'/preview-only'}};
  if(scene==='complete')practice.completedAt='2026-10-30T02:00:00.000Z';
  return {...base,practice};
}

/** Local-only fixture: every request resolves here, with no auth, network or billing. */
export function createPracticePreviewRequest(initial:PracticeView){
  let view=structuredClone(initial);
  const request:typeof api=async <T,>(path:string,options:RequestInit={}):Promise<T>=>{
    if(path!=='/api/me/onboarding-practice'&&!path.startsWith('/api/me/onboarding-practice/'))throw new Error('预览只使用本地合成数据。');
    const body=JSON.parse(typeof options.body==='string'?options.body:'{}');
    if(path.endsWith('/search'))return {results:[{selectionId:'preview_selection_012345',title:'我上次组织读书会的准备笔记',platform:'Notion',excerpt:'上次一共来了 8 位朋友。先读同一篇短文，再分享观点，最后写下一个下周可尝试的小行动。日期、场地和预算还需要确认。'}]} as T;
    if(path.endsWith('/start')){view=practicePreviewView('running');view.practice!.first.operationId=body.operationId;view.practice!.goal=body.goal??'plan';if(body.sample===true)view.practice!.source={sample:true,title:'示例：把一次读书会办得更轻松',platform:'ONE 练习样例'};return structuredClone(view) as T;}
    if(path.endsWith('/web')){view=practicePreviewView('web');return structuredClone(view) as T;}
    if(path.endsWith('/complete')){view={...view,practice:{...view.practice!,completedAt:'2026-10-30T02:00:00.000Z',skipWeb:body.skipWeb===true}};return structuredClone(view) as T;}
    if(path!=='/api/me/onboarding-practice')throw new Error('预览只使用本地合成数据。');
    return structuredClone(view) as T;
  };
  return request;
}
export default function PracticeOnboardingPreview({initialScene='choose'}:{initialScene?:PracticePreviewScene}){
  const [scene,setScene]=useState<PracticePreviewScene>(initialScene),[notice,setNotice]=useState('');
  const fixture=useMemo(()=>{const view=practicePreviewView(scene);return {view,request:createPracticePreviewRequest(view)};},[scene]);
  return <main className="practice-preview-frame"><nav className="practice-preview-controls" aria-label="选择合成验收场景">{scenes.map(([value,label])=><button type="button" key={value} aria-pressed={scene===value} onClick={()=>{setScene(value);setNotice('');}}>{label}</button>)}</nav>
    <PracticeOnboarding key={scene} journeyId={journeyId} request={fixture.request} initialView={fixture.view} preview defaultGoal="plan" onKnowledge={()=>setNotice('合成预览：正式页面会打开资料连接设置。')} onDismiss={()=>setNotice('已收起。正式页面保留进度，可从设置继续。')} onContinueChat={()=>setNotice('主对话可以继续；当前体验和已提交任务都会保留。')} onOpenTask={()=>setNotice('合成预览：正式页面会打开这一次的真实任务。')} onFinish={async()=>{setNotice('合成预览结束。正式页面会保存体验，再安排个人指南。');}} onSkip={async()=>{setNotice('明确跳过体验。不会声称已经完成这些操作。');}} renderArtifact={attachment=><details className="practice-request"><summary>{attachment?.name} · 打开合成网页</summary><h3>读书会行动方案</h3><p>沿用刚才那份方案，展开一项看看。</p><details><summary>活动前：准备材料</summary><p>确认同一篇短文，提醒每人带来一个观点。日期、场地和预算待确认。</p></details><details><summary>活动中：分四段进行</summary><p>认识彼此，分享观点，交流应用，写下下一步行动。</p></details></details>}/>
    <p className="practice-preview-caption" role="status">{notice||'本地合成预览 · 所有资料、任务和网页均为示意，不连接外网，不调用模型，不使用电力。'}</p>
  </main>;
}
