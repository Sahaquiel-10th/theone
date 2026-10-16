import type { Database } from './types.js';
import { accountInScope, accountProfile, BetaInputError, updateAccountProfile, type AccountScope } from './betaProfile.js';
import { canReadKnowledge } from './enterprisePolicy.js';
import { availableFeature } from './featureRuns.js';
import { uid } from './security.js';
import {onboardingPurposes,type OnboardingPurpose} from '../src/onboardingPurposes.js';

export type JourneyStage = 'name' | 'knowledge' | 'device' | 'features' | 'ready' | 'complete';
export type LocalWelcomeState = { connected: boolean; folderSelected: boolean; executorReady: boolean; checkedAt: string };
export type OnboardingJourney = {
  id: string; launchId: string; version: 2; stage: JourneyStage; startedAt: string; completedAt?: string;
  nameChoice?: 'provided' | 'skipped'; knowledgeChoice?: 'connected' | 'skipped';
  knowledgePlatforms?: string[];
  localChoice?: 'checked' | 'skipped'; local?: LocalWelcomeState;
  featureIds: string[]; events: { step: JourneyStage; choice: string; at: string }[];
  purposeIds?:OnboardingPurpose[];
  experience?:3|4;
  handbook?: import('./betaProfile.js').OnboardingHandbook;
};
export type WelcomeContext = { platforms: string[]; features: { id: string; name: string; description: string }[] };
const platformNames: Record<string,string> = { getnote:'得到大脑',notion:'Notion',yinxiang:'印象笔记',flowus:'FlowUs',feishu:'飞书',flomo:'flomo' };
export function welcomeContext(db: Database, scope: AccountScope): WelcomeContext {
  accountInScope(db,scope);
  const platforms=[...new Set(db.knowledgeConnections.filter(c=>c.workspaceId===scope.workspaceId&&c.status==='connected'&&canReadKnowledge(db,scope,c.id)).map(c=>platformNames[c.provider]).filter(Boolean))];
  const features: WelcomeContext['features']=[];
  for(const record of db.settings?.officialFeatures??[]) {
    try {
      const {version}=availableFeature(db,scope,record.id),v=version.values;
      if(!db.models.some(m=>m.id===v.modelId&&m.enabled&&m.apiKey))continue;
      features.push({id:record.id,name:v.name.slice(0,80),description:v.description.slice(0,240)});
    } catch { /* Unavailable and foreign capabilities are never advertised. */ }
  }
  return {platforms,features:features.slice(0,60)};
}
export type JourneyInput = { action?:unknown; launchId?:unknown; journeyId?:unknown; operationId?:unknown; step?:unknown; choice?:unknown; displayName?:unknown; featureIds?:unknown; purposeIds?:unknown; experience?:unknown; createGuide?:unknown; budgetPower?:unknown };
export function matchWelcomeFeatures(db:Database,scope:AccountScope,ids:OnboardingPurpose[]) {
  const words=onboardingPurposes.filter(p=>ids.includes(p.id)).flatMap(p=>[...p.words]);
  return welcomeContext(db,scope).features.map((f,index)=>({id:f.id,index,score:words.filter(w=>(f.name+' '+f.description).toLowerCase().includes(w.toLowerCase())).length})).filter(f=>f.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,3).map(f=>f.id);
}
const token=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,100}$/.test(value);
export function updateJourney(db:Database,scope:AccountScope,input:JourneyInput,local?:LocalWelcomeState,time=new Date().toISOString()) {
  const user=accountInScope(db,scope),profile=accountProfile(db,scope);
  if(input.action==='begin') {
    if(!token(input.launchId))throw new BetaInputError('引导编号无效');
    const current=profile.onboarding.journey;
    if(profile.onboarding.journeyHistory?.some(old=>old.launchId===input.launchId))return profile;
    if(current&&(current.stage!=='complete'||current.launchId===input.launchId))return profile;
    const guide=profile.onboarding.handbook;
    if(guide&&['pending','preparing'].includes(guide.status)) {
      const accepted=db.chatOperations?.find(op=>op.workspaceId===scope.workspaceId&&op.userId===scope.userId&&op.operationId===`${guide.operationId}_image`&&op.workRun?.kind==='image'&&db.conversations.some(c=>c.id===op.conversationId&&c.workspaceId===scope.workspaceId&&c.userId===scope.userId));
      if(accepted){guide.status='queued';guide.taskId=accepted.conversationId;}
      else if(Date.parse(time)-Date.parse(guide.updatedAt)>=120_000){guide.status='failed';guide.reason='unavailable';}
      else throw new BetaInputError('上一份使用说明还在交接，稍后再开始引导。',409);
    }
    if(current)profile.onboarding.journeyHistory=[...(profile.onboarding.journeyHistory??[]),{...current,handbook:profile.onboarding.handbook}];
    profile.onboarding.journey={id:uid('journey'),launchId:input.launchId as string,version:2,experience:input.experience===4?4:input.experience===3?3:undefined,stage:'name',startedAt:time,featureIds:[],events:[]};
  } else {
    const j=profile.onboarding.journey;
    if(!j||input.journeyId!==j.id)throw new BetaInputError('这次引导已经变化，请重新打开。',409);
    if(j.stage==='complete'&&input.action==='step'&&input.step==='features'&&input.choice==='purposes'&&JSON.stringify(input.purposeIds)===JSON.stringify(j.purposeIds))return profile;
    if(input.action==='finish') {
      if(j.stage==='complete')return profile;
      if(j.stage!=='ready')throw new BetaInputError('先完成或跳过前面的步骤。',409);
      const withoutImage=input.choice==='without_image';
      const firstGift=!profile.onboarding.welcomeGiftOperationId;
      if(!withoutImage&&!firstGift&&(typeof input.budgetPower!=='number'||!Number.isFinite(input.budgetPower)||input.budgetPower<=0||input.budgetPower>.5))throw new BetaInputError('再次生成需要先确认这份说明的电力。');
      if(j.localChoice==='checked')j.local=local??{connected:false,folderSelected:false,executorReady:false,checkedAt:time};
      const allowed=new Set(welcomeContext(db,scope).features.map(f=>f.id));j.featureIds=j.featureIds.filter(id=>allowed.has(id));
      j.stage='complete';j.completedAt=time;j.events.push({step:'complete',choice:withoutImage?'finished_without_image':'create_comic',at:time});
      profile.onboarding.completedAt ||= time;
      profile.onboarding.handbook={operationId:uid('welcome'),funding:!withoutImage&&firstGift?'one':'customer',status:withoutImage?'skipped':'pending',maxPower:withoutImage?0:firstGift ? .5 : input.budgetPower as number,requestedAt:time,updatedAt:time};
      if(!withoutImage&&firstGift)profile.onboarding.welcomeGiftOperationId=profile.onboarding.handbook.operationId;
    } else if(input.action==='step') {
      if(input.step!==j.stage) {
        // A lost response may repeat the last exact step, never advance another one.
        if(j.events.at(-1)?.step===input.step&&j.events.at(-1)?.choice===input.choice)return profile;
        throw new BetaInputError('步骤已经变化，请按当前页面继续。',409);
      }
      if(j.stage==='name') {
        if(input.choice==='provided') {
          updateAccountProfile(db,scope,{displayName:input.displayName},time);
          const saved=accountProfile(db,scope);profile.displayName=saved.displayName;profile.onboarding.nameSetAt=saved.onboarding.nameSetAt;
        } else if(input.choice!=='skipped')throw new BetaInputError('填写称呼，或者选择跳过。');
        j.nameChoice=input.choice as 'provided'|'skipped';j.stage='knowledge';
      } else if(j.stage==='knowledge') {
        if(!['connected','skipped'].includes(String(input.choice)))throw new BetaInputError('请选择连接或跳过。');
        if(input.choice==='connected'&&!welcomeContext(db,scope).platforms.length)throw new BetaInputError('还没连接成功，也可以先跳过。');
        j.knowledgeChoice=input.choice as 'connected'|'skipped';j.knowledgePlatforms=welcomeContext(db,scope).platforms;profile.onboarding.knowledgeChoice=j.knowledgeChoice;profile.onboarding.knowledgeStepAt=time;j.stage='device';
      } else if(j.stage==='device') {
        if(!['checked','skipped'].includes(String(input.choice)))throw new BetaInputError('请检测本机或跳过。');
        j.localChoice=input.choice as 'checked'|'skipped';j.local=input.choice==='checked'?local:undefined;j.stage='features';
      } else if(j.stage==='features') {
        if(input.choice==='purposes'){
          if(!Array.isArray(input.purposeIds)||input.purposeIds.length>2||input.purposeIds.some(id=>!onboardingPurposes.some(p=>p.id===id)))throw new BetaInputError('选一两个用途就好，也可以先跳过。');
          j.purposeIds=[...new Set(input.purposeIds)] as OnboardingPurpose[];
          j.featureIds=matchWelcomeFeatures(db,scope,j.purposeIds);j.experience=j.experience===4?4:3;j.stage='ready';
          j.events.push({step:'features',choice:'purposes',at:time});profile.updatedAt=time;user.profile=profile;return structuredClone(profile);
        }
        if(!['selected','skipped'].includes(String(input.choice)))throw new BetaInputError('请选择感兴趣的功能或跳过。');
        const ids=input.choice==='skipped'?[]:input.featureIds;
        if(!Array.isArray(ids)||ids.length>3||ids.some(id=>typeof id!=='string'))throw new BetaInputError('最多选 3 个功能。');
        const allowed=new Set(welcomeContext(db,scope).features.map(f=>f.id));
        if(ids.some(id=>!allowed.has(id)))throw new BetaInputError('有功能的授权已经变化，请重新选择。',409);
        j.featureIds=[...new Set(ids)];j.stage='ready';
      } else throw new BetaInputError('当前步骤不能这样操作。',409);
      j.events.push({step:input.step as JourneyStage,choice:String(input.choice),at:time});
    } else throw new BetaInputError('引导操作无效。');
  }
  profile.updatedAt=time;user.profile=profile;return structuredClone(profile);
}
