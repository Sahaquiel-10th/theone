import {createHash,randomUUID} from 'node:crypto';
import express,{type Express,type RequestHandler} from 'express';
import type {Database} from './types.js';
import type {Store} from './db.js';
import {accountInScope,accountProfile,BetaInputError,type AccountScope} from './betaProfile.js';
import {canReadKnowledge} from './enterprisePolicy.js';
import {availableFeature} from './featureRuns.js';
import {featureBudgetPolicy,featureMultiplier,requireFeatureApproval,type FeaturePrice,type FeatureApproval} from './featurePricing.js';
import {sourceBinding} from './publicSharing.js';
import type {KnowledgeService,KnowledgeRecallResult} from './knowledge/knowledgeService.js';
import type {KnowledgeChunk} from './knowledge/provider.js';
import {resolveWorkDependency} from './workDependencies.js';
import {asyncRoute} from './middleware.js';
import type {ChatOperation} from './chatOperations.js';

export type PracticeGoal='article'|'plan';
export type PracticeRound={operationId:string;taskId:string;state:'queued'|'running'|'completed'|'failed'|'interrupted'|'cancelled'|'prepared';resultMessageId?:string;outcome?:string;excerpt?:string;attachment?:{id:string;name:string;openUrl:string;downloadUrl:string}};
export type OnboardingPractice={id:string;journeyId:string;source:{title:string;platform:string;sourceUrl?:string;sample:boolean};goal:PracticeGoal;topic:string;prompt:string;webPrompt:string;first:PracticeRound;web?:PracticeRound;completedAt?:string;skipWeb?:boolean;material:PracticeMaterial;requestHash:string};
export type PracticeView={practice?:Omit<OnboardingPractice,'material'|'requestHash'>;connections:{id:string;name:string}[];webFeature?:FeaturePrice;approvalThreshold:number;displayName:string};
export type PracticeSearchResult={selectionId:string;title:string;excerpt:string;sourceUrl?:string;platform:string};
/** Only identity and a digest are durable. Third-party note bodies stay on demand. */
export type PracticeMaterial={sample:boolean;connectionId?:string;binding?:string;query?:string;noteId?:string;title:string;sourceUrl?:string;digest:string};
export type PracticeTaskInput={operationId:string;practiceId:string;stage:'first'|'web';prompt:string;goal:PracticeGoal;material?:PracticeMaterial;firstOperationId?:string;featureId?:string;featureApprovals?:FeatureApproval[]};
type Knowledge=Pick<KnowledgeService,'recallWithDiagnostics'>;
type TaskQueue={enqueuePractice:(scope:AccountScope,input:PracticeTaskInput,verify:()=>Promise<void>)=>Promise<string>;resume:(scope:AccountScope,verify:()=>Promise<void>)=>Promise<unknown>};
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
 throw new BetaInputError('实战交接格式无效');
}
/** Explicit recovery of a proven pre-queue failure. Keep the same tombstone,
 * hash and request identity; an accepted/billed/ambiguous job is never reset. */
export async function reclaimUnstartedPracticeOperation(store:Store,s:AccountScope,operationId:string,payload:unknown,check:(db:Database)=>void):Promise<ChatOperation|undefined>{
 return store.mutate(db=>{
  accountInScope(db,s);const op=db.chatOperations?.find(o=>o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.operationId===operationId);
  if(!op||op.status!=='failed'||op.workRun||op.featureRun||op.conversationId||op.dispatchedTaskId)return;
  if(op.payloadHash!==createHash('sha256').update(canonical(payload)).digest('hex'))throw new BetaInputError('原交接内容已经变化，不能用同一编号重做。',409);
  if(db.chatOperations?.some(o=>o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.workRun?.parentOperationId===operationId)||db.modelUsageRecords.some(r=>r.workspaceId===s.workspaceId&&r.userId===s.userId&&r.requestId===op.requestId))return;
  check(db);op.status='pending';op.updatedAt=new Date().toISOString();return structuredClone(op);
 });
}
const names:Record<string,string>={getnote:'得到大脑',notion:'Notion',flowus:'FlowUs',yinxiang:'印象笔记',flomo:'flomo',feishu:'飞书'};
const sample:KnowledgeChunk={id:'one-practice-sample-v1',title:'示例：把一次读书会办得更轻松',content:'这是一份由 ONE 提供的练习材料，不是你的私人笔记。\n计划办一场 8 人的小型读书会，时间为周六下午两点到四点。大家提前读同一篇短文，带一个印象最深的观点。开场用 10 分钟轮流介绍；接着用 40 分钟分享观点；休息 10 分钟，再用 40 分钟讨论如何应用到生活；最后用 20 分钟写下一个下周可尝试的小行动。主持人提前确认场地、提醒大家带书，并在活动后收集反馈。预算、具体日期与场地尚未确定，不能编造。'};
const digest=(chunk:KnowledgeChunk)=>createHash('sha256').update(JSON.stringify([chunk.id??'',chunk.title,chunk.content,chunk.sourceUrl??''])).digest('hex');
const token=(value:unknown,label='提交编号')=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(value))throw new BetaInputError(`${label}无效`);return value;};
function connection(db:Database,s:AccountScope,id:string,binding?:string){
 accountInScope(db,s);const c=db.knowledgeConnections.find(c=>c.id===id&&c.workspaceId===s.workspaceId&&['connected','error'].includes(c.status)&&canReadKnowledge(db,s,c.id));
 if(!c||binding!==undefined&&sourceBinding(c)!==binding)throw new BetaInputError('所选资料的授权已变化，请重新搜索选择。',409);return c;
}
export async function readPracticeMaterial(store:Store,knowledge:Knowledge,s:AccountScope,material:PracticeMaterial):Promise<KnowledgeRecallResult>{
 accountInScope(await store.read(),s);
 if(material.sample){if(material.digest!==digest(sample))throw new BetaInputError('练习样例已经变化，请重新开始。',409);return {status:'used',chunks:[structuredClone(sample)],failures:[]};}
 connection(await store.read(),s,material.connectionId!,material.binding);
 const found=await knowledge.recallWithDiagnostics(s.workspaceId,material.query!,10,[material.connectionId!],s.userId,{retry:true});
 connection(await store.read(),s,material.connectionId!,material.binding);
 if(!['used','no_match'].includes(found.status))throw new BetaInputError('这次还没读到你选的资料，请检查连接后再继续。',409);
 const selected=found.chunks.find(c=>(c.id??'')===(material.noteId??'')&&c.title===material.title&&digest(c)===material.digest);
 if(!selected)throw new BetaInputError('你选的资料内容或搜索结果已变化，请重新搜索，不能用另一篇代替。',409);
 return {...found,chunks:[selected]};
}
function current(db:Database,s:AccountScope){const profile=accountProfile(db,s),j=profile.onboarding.journey;if(j?.experience!==5||!['ready','complete'].includes(j.stage))throw new BetaInputError('请先完成称呼、资料和目标选择。',409);return {profile,j};}
function record(db:Database,s:AccountScope){const {profile,j}=current(db,s),p=profile.onboarding.practice;if(!p||p.journeyId!==j.id)throw new BetaInputError('本轮实战还没开始，请先选择资料。',409);return p;}
function price(db:Database,s:AccountScope):FeaturePrice|undefined{
 for(const f of db.settings.officialFeatures??[]){try{const selected=availableFeature(db,s,f.id),v=selected.version.values;if(v.tools?.some(t=>t.id==='oneHtml')&&db.models.some(m=>m.id===v.modelId&&m.enabled&&m.apiKey))return {id:f.id,name:v.name,releaseId:selected.record.release!.id,version:selected.version.version,multiplier:featureMultiplier(v)};}catch{/* Only currently available releases. */}}
}
function round(db:Database,s:AccountScope,saved:PracticeRound,practiceId:string,web=false):PracticeRound{
 const op=resolveWorkDependency(db,s,saved.operationId),job=op?.workRun,task=db.conversations.find(c=>c.id===op?.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId&&!c.archived);
 if(!job&&!saved.taskId)return {...saved,state:'failed',resultMessageId:undefined,outcome:undefined,excerpt:'这次要求已保留，但还没确认派出。可以明确重新交接同一次请求，不会换一条要求重新生成。',attachment:undefined};
 if(!job||!task||job.onboardingPractice?.id!==practiceId||job.onboardingPractice.stage!==(web?'web':'first')||saved.taskId&&task.id!==saved.taskId)return {...saved,state:'failed',resultMessageId:undefined,outcome:undefined,excerpt:'本轮任务或原资料授权暂不可用，请查看原任务。',attachment:undefined};
 const message=task.messages.find(m=>m.id===job.resultMessageId&&m.role==='assistant');
 const file=web&&message?(message.attachments??[]).map(a=>db.attachments.find(f=>f.id===a.id&&f.workspaceId===s.workspaceId&&f.userId===s.userId&&f.conversationId===task.id&&f.messageId===message.id&&f.status==='ready'&&f.mimeType==='text/html'&&f.visualDocument)).find(Boolean):undefined;
 return {operationId:saved.operationId,taskId:task.id,state:job.state,resultMessageId:message?.id,outcome:job.resultOutcome,excerpt:message?.content.slice(0,1200),...(file?{attachment:{id:file.id,name:file.originalName,openUrl:`/api/welcome-pages/${encodeURIComponent(file.id)}/view`,downloadUrl:`/api/attachments/${encodeURIComponent(file.id)}/content`}}:{})};
}
const succeeded=(r:PracticeRound|undefined)=>!!r&&r.state==='completed'&&!!r.resultMessageId&&['completed','returned'].includes(r.outcome??'');
/** Full exact prerequisite, never a coordinator summary or an older message. */
export function practiceWebReference(db:Database,s:AccountScope,practiceId:string,operationId:string){
 const op=resolveWorkDependency(db,s,operationId),job=op?.workRun,task=db.conversations.find(c=>c.id===op?.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId),message=task?.messages.find(m=>m.id===job?.resultMessageId&&m.role==='assistant');
 if(job?.onboardingPractice?.id!==practiceId||job.onboardingPractice.stage!=='first'||job.state!=='completed'||!['completed','returned'].includes(job.resultOutcome??'')||!message?.content)throw new BetaInputError('这次正文还未完整完成，不能使用旧结果制作网页。',409);
 if(message.content.length>8000)throw new BetaInputError('这次正文较长，请先在原任务整理为短篇；不会截断正文制作网页。',409);
 return message.content;
}
export function practiceView(db:Database,s:AccountScope):PracticeView{
 const profile=accountProfile(db,s),stored=profile.onboarding.practice,j=profile.onboarding.journey;
 let practice:PracticeView['practice'];
 if(stored&&stored.journeyId===j?.id&&j.experience===5){const {material,requestHash,...safe}=stored,first=round(db,s,stored.first,stored.id),web=stored.web?round(db,s,stored.web,stored.id,true):undefined;practice={...safe,first,web,completedAt:stored.completedAt&&succeeded(first)&&(stored.skipWeb||succeeded(web)&&web?.attachment)?stored.completedAt:undefined};}
 return {practice,displayName:profile.displayName,connections:db.knowledgeConnections.filter(c=>c.workspaceId===s.workspaceId&&['connected','error'].includes(c.status)&&canReadKnowledge(db,s,c.id)).map(c=>({id:c.id,name:names[c.provider]??'知识来源'})),webFeature:price(db,s),approvalThreshold:featureBudgetPolicy(db,s)};
}
export class OnboardingPracticeService{
 private selections=new Map<string,{scope:AccountScope;journeyId:string;expires:number;material:PracticeMaterial;platform:string}>();
 private locks=new Map<string,Promise<unknown>>();
 constructor(private store:Store,private knowledge:Knowledge,private tasks:TaskQueue,private now=()=>Date.now()){}
 async view(s:AccountScope){return practiceView(await this.store.read(),s);}
 async search(s:AccountScope,input:{journeyId?:unknown;query?:unknown;connectionId?:unknown},verify:()=>Promise<void>){
  await verify();const db=await this.store.read(),{j}=current(db,s);if(input.journeyId!==j.id)throw new BetaInputError('这次引导已经变化，请重新打开。',409);
  if(j.stage!=='ready')throw new BetaInputError('这次引导已经结束，重新开始后再选择资料。',409);
  if(typeof input.query!=='string'||!input.query.trim()||input.query.trim().length>200||typeof input.connectionId!=='string')throw new BetaInputError('输入熟悉笔记的标题或几个关键词。');
  const query=input.query.trim(),c=connection(db,s,input.connectionId),binding=sourceBinding(c);
  const found=await this.knowledge.recallWithDiagnostics(s.workspaceId,query,10,[c.id],s.userId,{retry:true});await verify();connection(await this.store.read(),s,c.id,binding);
  const results:PracticeSearchResult[]=[];for(const [id,value]of this.selections)if(value.expires<=this.now())this.selections.delete(id);
  if(['used','no_match'].includes(found.status))for(const chunk of found.chunks.slice(0,6)){
   const selectionId=randomUUID(),material:PracticeMaterial={sample:false,connectionId:c.id,binding,query,noteId:chunk.id,title:chunk.title,sourceUrl:chunk.sourceUrl,digest:digest(chunk)};
   this.selections.set(selectionId,{scope:{...s},journeyId:j.id,expires:this.now()+15*60_000,material,platform:names[c.provider]??'知识来源'});
   results.push({selectionId,title:chunk.title,excerpt:chunk.content.slice(0,180),sourceUrl:chunk.sourceUrl,platform:names[c.provider]??'知识来源'});
  }
  // A bounded volatile cache is not a knowledge store, nor a durable auth grant.
  while(this.selections.size>500)this.selections.delete(this.selections.keys().next().value!);
  return {results,...(!results.length?{message:found.status==='no_match'?'这次没找到，可以换个关键词，或使用明确标记的样例。':'资料暂时没读到，请检查连接或使用样例。'}:{})};
 }
 private async serialized<T>(s:AccountScope,run:()=>Promise<T>):Promise<T>{const id=`${s.workspaceId}:${s.userId}`,previous=this.locks.get(id)??Promise.resolve();const active=previous.catch(()=>{}).then(run);this.locks.set(id,active);try{return await active;}finally{if(this.locks.get(id)===active)this.locks.delete(id);}}
 async start(s:AccountScope,input:{journeyId?:unknown;operationId?:unknown;selectionId?:unknown;sample?:unknown;goal?:unknown;topic?:unknown;retryHandoff?:unknown},verify:()=>Promise<void>){return this.serialized(s,async()=>{
  await verify();const operationId=token(input.operationId),db=await this.store.read(),{profile,j}=current(db,s);
  if(input.journeyId!==j.id)throw new BetaInputError('这次引导已经变化，请重新打开。',409);
  if(j.stage!=='ready')throw new BetaInputError('这次引导已经结束，已有结果留在任务中。',409);
  if(input.retryHandoff===true){const p=record(db,s);if(p.first.operationId!==operationId)throw new BetaInputError('只能继续原来这次交接，请查看已有任务。',409);if(p.first.taskId)return this.view(s);return this.queueFirst(s,p,verify);}
  if(input.goal!=='article'&&input.goal!=='plan')throw new BetaInputError('请选择写短文或做行动方案。');
  if(typeof input.topic!=='string'||!input.topic.trim()||input.topic.trim().length>300)throw new BetaInputError('用一句话说说你想得到什么。');
  const topic=input.topic.trim(),old=profile.onboarding.practice,requestHash=createHash('sha256').update(JSON.stringify([input.sample===true,input.selectionId??null,input.goal,topic])).digest('hex');
  if(old&&old.journeyId===j.id){if(old.first.operationId!==operationId||old.requestHash!==requestHash)throw new BetaInputError('本轮已经有任务，请查看原任务，不能重复派出。',409);if(old.first.taskId)return this.view(s);return this.queueFirst(s,old,verify);}
  let material:PracticeMaterial,platform:string;
  if(input.sample===true){if(input.selectionId!==undefined)throw new BetaInputError('请选择自己的资料或样例中的一个。');material={sample:true,title:sample.title,digest:digest(sample)};platform='ONE 练习样例';}
  else{const selected=typeof input.selectionId==='string'?this.selections.get(input.selectionId):undefined;if(!selected||selected.expires<=this.now()||selected.scope.userId!==s.userId||selected.scope.workspaceId!==s.workspaceId||selected.journeyId!==j.id)throw new BetaInputError('资料选择已经失效，请重新搜索选择。',409);material=selected.material;platform=selected.platform;}
  await readPracticeMaterial(this.store,this.knowledge,s,material);await verify();
  const prompt=`请只依据我选的${material.sample?'练习样例':'资料'}《${material.title}》，${input.goal==='article'?'写一篇能直接使用的短文（600—1000字）':'做一份具体的行动方案（600—1000字，包含步骤、待确认事项）'}。我的目标是：${topic}。请先实际读取本轮指定材料；缺失事实保留待确认。结果直接留在这个任务里。`;
  const p:OnboardingPractice={id:randomUUID(),journeyId:j.id,source:{title:material.title,platform,sourceUrl:material.sourceUrl,sample:material.sample},goal:input.goal,topic,prompt,webPrompt:'把刚才这个任务真实完成的正文整理成可浏览、可展开步骤、可导出的交互网页，保留原文事实和待确认事项。',material,requestHash,first:{operationId,taskId:'',state:'queued'}};
  await this.store.mutate(d=>{const {profile:latest,j:active}=current(d,s);if(active.id!==j.id||latest.onboarding.practice?.journeyId===j.id)throw new BetaInputError('本轮已经变化，请查看当前实战。',409);if(!material.sample)connection(d,s,material.connectionId!,material.binding);latest.onboarding.practice=p;accountInScope(d,s).profile=latest;});
  return this.queueFirst(s,p,verify);
 });}
 private async queueFirst(s:AccountScope,p:OnboardingPractice,verify:()=>Promise<void>){
  const taskId=await this.tasks.enqueuePractice(s,{operationId:p.first.operationId,practiceId:p.id,stage:'first',prompt:p.prompt,goal:p.goal,material:p.material},verify);
  await this.store.mutate(d=>{const saved=record(d,s);if(saved.id!==p.id)throw new BetaInputError('本轮实战已经变化。',409);saved.first.taskId=taskId;accountInScope(d,s).profile!.onboarding.practice=saved;});
  void this.tasks.resume(s,verify).catch(()=>{});return this.view(s);
 }
 async web(s:AccountScope,input:{journeyId?:unknown;practiceId?:unknown;operationId?:unknown;featureApprovals?:FeatureApproval[]},verify:()=>Promise<void>){return this.serialized(s,async()=>{
  await verify();const operationId=token(input.operationId),db=await this.store.read(),p=record(db,s),view=practiceView(db,s);
  if(input.journeyId!==p.journeyId||input.practiceId!==p.id)throw new BetaInputError('这次实战已经变化，请重新打开。',409);
  if(current(db,s).j.stage!=='ready')throw new BetaInputError('这次引导已经结束，已有结果留在任务中。',409);
  if(p.web){if(p.web.operationId!==operationId)throw new BetaInputError('网页已经安排，请查看原任务，不能重复制作。',409);if(p.web.taskId)return view;}
  if(!succeeded(view.practice?.first))throw new BetaInputError('先等本轮文章或方案实际完成，再做网页。',409);
  practiceWebReference(db,s,p.id,p.first.operationId);
  const webFeature=price(db,s);if(!webFeature)throw new BetaInputError('交互网页功能尚未为你开放，可以先保存正文。',428);
  requireFeatureApproval(db,s,[webFeature],input.featureApprovals);
  await this.store.mutate(d=>{const saved=record(d,s);if(saved.id!==p.id)throw new BetaInputError('本轮已经变化。',409);saved.web??={operationId,taskId:'',state:'queued'};accountInScope(d,s).profile!.onboarding.practice=saved;});
  const taskId=await this.tasks.enqueuePractice(s,{operationId,practiceId:p.id,stage:'web',prompt:p.webPrompt,goal:p.goal,firstOperationId:p.first.operationId,featureId:webFeature.id,featureApprovals:input.featureApprovals},verify);
  await this.store.mutate(d=>{const saved=record(d,s);if(saved.id!==p.id||saved.web?.operationId!==operationId)throw new BetaInputError('本轮已经变化。',409);saved.web.taskId=taskId;accountInScope(d,s).profile!.onboarding.practice=saved;});
  void this.tasks.resume(s,verify).catch(()=>{});return this.view(s);
 });}
 async complete(s:AccountScope,input:{journeyId?:unknown;practiceId?:unknown;skipWeb?:unknown},verify:()=>Promise<void>){
  await verify();await this.store.mutate(db=>{const p=record(db,s),v=practiceView(db,s).practice!;if(input.journeyId!==p.journeyId||input.practiceId!==p.id)throw new BetaInputError('这次实战已经变化，请重新打开。',409);if(!succeeded(v.first))throw new BetaInputError('本轮正文还未完成，先查看实际任务。',409);if(input.skipWeb!==true&&(!succeeded(v.web)||!v.web?.attachment))throw new BetaInputError('本轮网页还没有完成并保存，也可以明确选择先用正文。',409);if(input.skipWeb===true&&v.web&&['queued','running','prepared'].includes(v.web.state))throw new BetaInputError('网页任务仍在进行，请先查看或停止它。',409);p.completedAt??=new Date(this.now()).toISOString();p.skipWeb=input.skipWeb===true;accountInScope(db,s).profile!.onboarding.practice=p;});return this.view(s);
 }
}
export function installOnboardingPracticeRoutes(app:Express,keyAuth:readonly RequestHandler[],store:Store,knowledge:Knowledge,tasks:TaskQueue,verifyKey:(req:express.Request)=>Promise<void>){
 const service=new OnboardingPracticeService(store,knowledge,tasks),router=express.Router();router.use(...keyAuth);router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});const scope=(req:express.Request)=>({workspaceId:req.workspaceId!,userId:req.user!.id});
 router.get('/',asyncRoute(async(req,res)=>res.json(await service.view(scope(req)))));
 router.post('/search',asyncRoute(async(req,res)=>res.json(await service.search(scope(req),req.body??{},()=>verifyKey(req)))));
 router.post('/start',asyncRoute(async(req,res)=>res.status(202).json(await service.start(scope(req),req.body??{},()=>verifyKey(req)))));
 router.post('/web',asyncRoute(async(req,res)=>res.status(202).json(await service.web(scope(req),req.body??{},()=>verifyKey(req)))));
 router.post('/complete',asyncRoute(async(req,res)=>res.json(await service.complete(scope(req),req.body??{},()=>verifyKey(req)))));
 router.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{const e=error as {status?:number;message?:string};res.status(e.status??400).json({error:e.status?e.message:'本轮还没安排好，请检查任务与连接；不会自动重做。'});});
 app.use('/api/me/onboarding-practice',router);return service;
}
