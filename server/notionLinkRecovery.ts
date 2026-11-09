import type {Database} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import type {WorkScope} from './coordinatorService.js';
import {parseNotionPageLink} from '../src/notionPageLink.js';
import {taskStepKey} from './taskSteps.js';
import {notionHash,legacyNotionNormalized,canonicalNotionDigest} from './notionCanonical.js';

export type NotionLinkRecoveryRequest={sourceJobId:string;expectedUpdatedAt:string;pageUrl:string;selectionId:string};
export type NotionLinkRecoveryOffer={inputNeeded:'page_url';sourceJobId:string;expectedUpdatedAt:string};
type Choice={kind:'none'}|{kind:'ambiguous'|'unavailable';message:string}|{kind:'candidate';pageUrl:string};
const own=(value:{workspaceId:string;userId:string},s:WorkScope)=>value.workspaceId===s.workspaceId&&value.userId===s.userId;
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Recover title only from original server-created receipt or exact original
 * create arguments. Today's conversation title is never independent proof. */
export function notionLinkRecoveryTitle(db:Database,s:WorkScope,op:ChatOperation):string|undefined{
 const run=op.workRun,r=run?.notionReceipt;
 if(!own(op,s)||!run||!r?.checkpointKey||!r.expectedRawDigest||!r.expectedDigest||!r.expectedCanonicalDigest||!r.canonicalVersion)return;
 if(typeof r.expectedPageTitle==='string'&&r.expectedPageTitle.trim()&&r.expectedPageTitle.length<=200)return r.expectedPageTitle;
 if(r.titleProjection?.version===1&&r.titleProjection.title.trim()&&r.titleProjection.title.length<=200)return r.titleProjection.title;
 const titles:string[]=[];
 for(const trace of db.contextTraces??[]){
  if(!own(trace,s)||trace.conversationId!==op.conversationId||trace.requestId!==op.requestId)continue;
  for(const step of trace.executionSteps??[]){
   if(step.tool!=='save_notion_draft'||typeof step.query!=='string'||step.query.length>52000||taskStepKey('worker','save_notion_draft',step.query)!==r.checkpointKey)continue;
   try{
    const args=object(JSON.parse(step.query)),body=args?.content;
    if(!args||Object.keys(args).some(key=>!['title','content','final'].includes(key))||typeof args.title!=='string'||!args.title.trim()||args.title.length>200||typeof body!=='string'||(args.final===true)!==(r.final===true)||body.length!==r.expectedLength||notionHash(body)!==r.expectedRawDigest||notionHash(legacyNotionNormalized(body))!==r.expectedDigest||canonicalNotionDigest(body,r.canonicalVersion)!==r.expectedCanonicalDigest)continue;
    titles.push(args.title);
   }catch{/* Ambiguous/malformed historical arguments do not grant recovery. */}
  }
 }
 const unique=[...new Set(titles)];return unique.length===1?unique[0]:undefined;
}

/** Public eligibility, not a permission grant. Rechecked before and after every
 * actual read. No credential, source prose, hashes or grant identifiers escape. */
export function notionLinkRecoveryOffer(db:Database,s:WorkScope,op:ChatOperation):NotionLinkRecoveryOffer|undefined{
 const run=op.workRun,r=run?.notionReceipt,target=run?.notionTarget;
 if(!own(op,s)||!run||!r||!target||!['failed','completed'].includes(run.state)||!['failed','completed'].includes(op.status)||op.executionCancelled||!op.updatedAt)return;
 const task=db.conversations.find(task=>own(task,s)&&task.id===op.conversationId&&!task.coordinatorMain&&!task.archived);
 if(!task||task.workPauseReason==='user_stopped'||target.pageId||task.notionDocument?.pageId||r.pageId||r.asyncTaskId||r.state==='verified'||r.delivery!=='unknown')return;
 if(task.notionDocument&&(task.notionDocument.connectionId!==target.connectionId||task.notionDocument.grantId!==target.grantId||task.notionDocument.parentId!==target.parentId))return;
 const latest=(db.chatOperations??[]).filter(other=>own(other,s)&&other.conversationId===op.conversationId&&other.workRun).at(-1);
 if(latest?.id!==op.id)return;
 if(!digest(r.expectedDigest)||!digest(r.expectedRawDigest)||!digest(r.expectedCanonicalDigest)||![2,3,4,5,6,7,8,9,10].includes(r.canonicalVersion??0)||!Number.isSafeInteger(r.expectedLength)||r.expectedLength!<1||r.expectedLength!>50000||!digest(r.checkpointKey))return;
 const steps=run.steps?.filter(step=>step.key===r.checkpointKey);
 if(steps?.length!==1||steps[0].scopeId!==op.id||steps[0].namespace!=='worker'||steps[0].tool!=='save_notion_draft'||steps[0].effect!=='external_write'||steps[0].state!=='started')return;
 const connection=db.knowledgeConnections.find(c=>c.workspaceId===s.workspaceId&&c.id===target.connectionId&&c.provider==='notion'&&c.status==='connected');
 if(connection?.notionWriting?.userId!==s.userId||connection.notionWriting.grantId!==target.grantId||connection.notionWriting.parentId!==target.parentId)return;
 if(!notionLinkRecoveryTitle(db,s,op))return;
 return {inputNeeded:'page_url',sourceJobId:op.id,expectedUpdatedAt:op.updatedAt};
}

/** Only a current user's direct recovery request can select a candidate. Links
 * in examples, quoted documents and code do not become task-binding authority. */
export function parseNotionLinkRecovery(text:string,options:{allowBareLink?:boolean}={}):Choice{
 if(typeof text!=='string'||text.length>8000)return {kind:'none'};
 const plain=text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'');
 const intent=plain.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g,'');
 if(/(?:不要|不用|别|先不|暂不)\s*(?:读取|核对|验证|回读|绑定|采用)/u.test(intent)||/(?:如果|假如|例如|比如|举例|讨论|设计|以后|将来)[\s\S]{0,100}(?:核对|原页|原文|链接)/u.test(intent))return {kind:'none'};
 const matches=[...plain.matchAll(/(?:https:\/\/|notion:\/\/)[^\s<>"“”「」()，。；！？、：]+/g)].map(match=>match[0].replace(/[，。；！？、）】》]+$/u,''));
 const urls=matches.filter(url=>!parseNotionPageLink(url).error);
 if(!urls.length)return {kind:'none'};
 const explicit=/(?:原(?:页|页面|文)(?:的)?(?:链接)?(?:是|在|：|:)|(?:已经|已|刚才).{0,12}(?:保存|写入).{0,24}(?:这页|这里|页面|链接)|(?:只读|重新|帮我|请).{0,12}(?:核对|验证|回读).{0,30}(?:这页|这个|保存|原文|正文)|(?:这页|这个链接).{0,16}(?:核对|验证|回读))/u.test(intent);
 const bare=options.allowBareLink===true&&plain.trim().replace(/^\[[^\]\n]*\]\(([^)]+)\)$/,'$1').trim()===urls[0];
 if(!explicit&&!bare)return {kind:'none'};
 if(new Set(urls.map(url=>parseNotionPageLink(url).pageId)).size!==1||matches.length!==urls.length)return {kind:'ambiguous',message:'这条消息里有多个页面入口。请选这次保存的那一页，我只核对原页，不会重写。'};
 if(/(?:然后|同时|另外|并且|再)\s*(?:帮我)?(?:写一篇|撰写|新建|创建|删除|发布|分享|修改)/u.test(plain))return {kind:'ambiguous',message:'这条消息还带有新的处理要求。请先选定要核对的原任务；核对不会重写或开始新任务。'};
 return {kind:'candidate',pageUrl:urls[0]};
}

export function selectNotionLinkRecovery(db:Database,s:WorkScope,input:{text:string;boundTaskId?:string;allowBareLink?:boolean}):Exclude<Choice,{kind:'candidate'}>|{kind:'candidate';taskId:string;sourceJobId:string;expectedUpdatedAt:string;pageUrl:string}{
 const parsed=parseNotionLinkRecovery(input.text,{allowBareLink:Boolean(input.boundTaskId)||input.allowBareLink});
 if(parsed.kind!=='candidate')return parsed;
 // Do not hijack an ordinary read of a Notion link when there is no unknown
 // no-page write to recover. Normal bound-page reading retains its own route.
 const related=(db.chatOperations??[]).filter(op=>own(op,s)&&(!input.boundTaskId||op.conversationId===input.boundTaskId)&&op.workRun?.notionReceipt?.delivery==='unknown'&&!op.workRun.notionReceipt.pageId&&op.workRun.notionReceipt.state!=='verified');
 if(!related.length)return {kind:'none'};
 const candidates=related.filter(op=>notionLinkRecoveryOffer(db,s,op));
 if(candidates.length>1)return {kind:'ambiguous',message:'有几件任务都在等原页链接。请先打开要核对的那件任务，再把链接发来；不会猜任务或重新保存。'};
 if(!candidates.length)return {kind:'unavailable',message:'这条链接还不能对应到一件可核对的原保存记录。请先打开原任务查看保存状态；已有页面不会被换绑，也不会重新写入。'};
 const op=candidates[0],offer=notionLinkRecoveryOffer(db,s,op)!;
 return {...parsed,taskId:op.conversationId!,sourceJobId:op.id,expectedUpdatedAt:offer.expectedUpdatedAt};
}
