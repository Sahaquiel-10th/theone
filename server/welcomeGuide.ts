import type {Database} from './types.js';
import {accountProfile,type AccountScope} from './betaProfile.js';
import {welcomeContext,type OnboardingJourney} from './onboardingJourney.js';
import {onboardingPurposes} from '../src/onboardingPurposes.js';
import {renderVisualPage,renderVisualDiagram,type VisualDocument} from './visualDocument.js';

export type WelcomeGuideFacts={version:1;nickname:string;purposes:string[];platforms:string[];localReady:boolean;features:{name:string;description:string}[];manual?:VisualDocument};
export function welcomeGuideFacts(db:Database,scope:AccountScope,journey?:OnboardingJourney):WelcomeGuideFacts {
  const p=accountProfile(db,scope),j=journey??p.onboarding.journey,c=welcomeContext(db,scope);
  return {version:1,nickname:p.displayName||'你',purposes:onboardingPurposes.filter(x=>j?.purposeIds?.includes(x.id)).map(x=>x.title),platforms:c.platforms,
    localReady:j?.localChoice==='checked'&&!!j.local?.connected&&!!j.local.folderSelected&&!!j.local.executorReady,
    features:[...c.features.filter(f=>j?.featureIds.includes(f.id)),...c.features.filter(f=>!j?.featureIds.includes(f.id))].slice(0,60).map(({name,description})=>({name,description}))};
}
export const escapeGuideText=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function guideExamples(f:WelcomeGuideFacts){return [
  {title:'想法说出来，就能开始',text:f.purposes.length?`你想做的：${f.purposes.join('、')}。不用先学会挑模型，把目标和要求告诉 ONE 就好。`:'写作、学习、工作或日常小计划，都可以从一句话开始。',example:f.purposes.includes('写作与表达')?'把这个想法整理成一篇自然的短文，先给我一个提纲。':'我想把这件事做好，先帮我理清目标和下一步。'},
  {title:f.platforms.length?'让你自己的资料来帮忙':'资料以后再接，也来得及',text:f.platforms.length?`已连接 ${f.platforms.join('、')}。需要时查找相关内容，回答会保留引用，不会整库搬过来。`:'现在就能聊天、写作和整理想法。以后接好知识来源，再让 ONE 帮你找自己的资料。',example:f.platforms.length?'帮我从已连接的资料里找找这个话题，先总结要点并附上来源。':'我想学一个新主题，先帮我列一个能坚持的小计划。'},
  {title:'有些工作，可以交给任务',text:f.features.length?`按你的用途，先配上这些帮手：${f.features.slice(0,3).map(x=>x.name).join('、')}。不需要记住名字，用得上时 ONE 会安排。`:'一句话里有几件独立的事，可以分别安排。任务区能看进度，完成后再回来查看。',example:f.features.length?`帮我处理这件事，需要时使用「${f.features[0].name}」，缺少的信息先问我。`:'帮我把这个主题的资料和文章提纲分开整理，做好了让我分别查看。'},
  {title:f.localReady?'成果也能落在你的电脑上':'先在 ONE 里看到成果',text:f.localReady?'本机已就绪，可以在你确认的工作区创建文件。新建重名时保留原件，另存编号版本；已有文件的修改会按你的明确要求处理。':'目前先在对话和任务里查看、保存成果。需要在电脑上做文件时，再连接本机并确认工作区。',example:f.localReady?'在已确认的工作区新建一份文档，做好后检查内容，并告诉我文件在哪里。':'把结果整理清楚，放在这个任务里让我查看。'}
];}
/** Older saved guides gain the new viewer without a new paid model call. */
export function guideDocument(f:WelcomeGuideFacts):VisualDocument {
  return f.manual??{version:1,title:`${f.nickname==='你'?'你':f.nickname}的 ONE 使用说明`,intro:f.purposes.length?`把${f.purposes.join('、')}里那些费劲的小事，交给 ONE 帮忙。`:'从理清想法到拿到成果，选一件你今天正好需要的小事。',scenes:guideExamples(f).map((c,i)=>({id:`scene${i}`,title:c.title,situation:c.title,feature:c.text.slice(0,159),advantage:i===1?'不用在资料和聊天窗口之间来回找。':i===2?'各做各的，不用守着一个任务等。':i===3?'成果留在方便你继续使用的地方。':'不必先挑模型或学会一串操作。',benefit:i===0?'把模糊想法变成清楚的下一步。':i===1?'回答有依据，回头找得到。':i===2?'几件事分开做，结果不混在一起。':'做完的东西，能接着用。',evidence:i===1&&f.platforms.length?'打开回答里的来源，核对是不是你要的内容。':i===3&&f.localReady?'检查文件位置和内容后，再交付给别人。':'打开任务里的实际结果，看看是否符合要求。',steps:[c.example,'查看实际结果；需要调整就接着补一句。'],prompt:c.example,capabilityIds:[]}))};
}
export function renderWelcomeGuide(f:WelcomeGuideFacts,image:string,posterUrl?:string){return renderVisualPage(guideDocument(f),image,posterUrl);}
export function renderWelcomePoster(f:WelcomeGuideFacts,_image:string){return renderVisualDiagram(guideDocument(f));}
