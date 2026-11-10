import {notionHash,legacyNotionNormalized,canonicalNotionDigest} from './notionCanonical.js';
import type {WorkRun} from './coordinatorTypes.js';
import {toolSucceeded,type TaskStep} from './taskSteps.js';

const validPageId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/i.test(value.replaceAll('-',''));
/** The containing operation is owner-authorized by the caller. This proof
 * binds its one write response, never another revision or an existing page. */
export function notionWriteAcknowledged(receipt:WorkRun['notionReceipt'],operationId:string):boolean{
 const ack=receipt?.writeAcknowledgement;
 if(!receipt||!ack||ack.version!==1||!operationId||ack.operationId!==operationId||['not_sent','rejected'].includes(receipt.delivery??''))return false;
 const keys=Object.keys(ack).sort().join();
 if(keys!=='acknowledgedAt,checkpointKey,expectedDigest,expectedRawDigest,operationId,pageId,version'&&keys!=='acknowledgedAt,asyncTaskId,checkpointKey,expectedDigest,expectedRawDigest,operationId,pageId,version')return false;
 return Boolean(validPageId(ack.pageId)&&ack.pageId===receipt.pageId
  &&typeof ack.checkpointKey==='string'&&/^[a-f0-9]{64}$/i.test(ack.checkpointKey)&&ack.checkpointKey===receipt.checkpointKey
  &&typeof ack.expectedDigest==='string'&&/^[a-f0-9]{64}$/i.test(ack.expectedDigest)&&ack.expectedDigest===receipt.expectedDigest
  &&typeof ack.expectedRawDigest==='string'&&/^[a-f0-9]{64}$/i.test(ack.expectedRawDigest)&&ack.expectedRawDigest===receipt.expectedRawDigest
  &&typeof ack.acknowledgedAt==='string'&&Number.isFinite(Date.parse(ack.acknowledgedAt))
  &&ack.asyncTaskId===receipt.asyncTaskId);
}
/** Delivery is proved by the exact write ACK or a historical complete read.
 * Background integrity checks do not retract that completed delivery. */
export function notionDeliveryConfirmed(receipt:WorkRun['notionReceipt'],operationId:string):boolean{
 if(['not_sent','rejected'].includes(receipt?.delivery??''))return false;
 if(notionWriteAcknowledged(receipt,operationId))return true;
 return Boolean(receipt?.state==='verified'&&validPageId(receipt.pageId)&&typeof receipt.digest==='string'&&/^[a-f0-9]{64}$/i.test(receipt.digest)&&typeof receipt.expectedDigest==='string'&&/^[a-f0-9]{64}$/i.test(receipt.expectedDigest));
}
/** Full original source, bound to the write's immutable expected hashes. */
export function notionSourceMatchesReceipt(content:unknown,receipt:WorkRun['notionReceipt']):content is string{
 return Boolean(typeof content==='string'&&content.trim()&&content.length<=50000&&receipt?.expectedRawDigest&&receipt.expectedDigest&&notionHash(content)===receipt.expectedRawDigest&&notionHash(legacyNotionNormalized(content))===receipt.expectedDigest&&(receipt.expectedLength===undefined||content.length===receipt.expectedLength)&&(!receipt.canonicalVersion||[2,3,4,5,6,7,8,9,10,11].includes(receipt.canonicalVersion)&&canonicalNotionDigest(content,receipt.canonicalVersion)===receipt.expectedCanonicalDigest));
}
/** Frozen private evidence for one workflow stage. Later writes may rotate
 * the operation's current receipt without erasing this completed delivery. */
export type NotionDeliveryProof=Pick<NonNullable<WorkRun['notionReceipt']>,'state'|'delivery'|'pageId'|'checkpointKey'|'expectedDigest'|'expectedRawDigest'|'expectedCanonicalDigest'|'canonicalVersion'|'expectedLength'|'final'|'asyncTaskId'|'writeAcknowledgement'>;
export function notionWriteDeliveryProof(receipt:WorkRun['notionReceipt'],operationId:string):NotionDeliveryProof|undefined{
 if(!notionWriteAcknowledged(receipt,operationId)||receipt!.final!==true)return;
 return {state:'delivered',delivery:'unknown',pageId:receipt!.pageId,checkpointKey:receipt!.checkpointKey,expectedDigest:receipt!.expectedDigest,expectedRawDigest:receipt!.expectedRawDigest,final:true,...(receipt!.asyncTaskId?{asyncTaskId:receipt!.asyncTaskId}:{}),writeAcknowledgement:structuredClone(receipt!.writeAcknowledgement),...(receipt!.expectedCanonicalDigest?{expectedCanonicalDigest:receipt!.expectedCanonicalDigest}:{}),...(receipt!.canonicalVersion?{canonicalVersion:receipt!.canonicalVersion}:{}),...(receipt!.expectedLength!==undefined?{expectedLength:receipt!.expectedLength}:{})};
}
/** Current or stage-frozen delivery evidence must still bind the same exact
 * worker, page, operation and manuscript. A status string alone cannot pass. */
export function notionDeliveryCheckpoint(receipt:WorkRun['notionReceipt'],steps:TaskStep[],operationId:string,linkedKey?:string,expectedBodyDigest?:string):TaskStep|undefined{
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||!notionDeliveryConfirmed(receipt,operationId)||!receipt.checkpointKey||linkedKey&&linkedKey!==receipt.checkpointKey||!receipt.pageId||!receipt.expectedDigest||expectedBodyDigest&&expectedBodyDigest!==receipt.expectedDigest||receipt.final!==true)return;
 const matching=steps.filter(cp=>cp.key===receipt.checkpointKey),actual=matching.length===1?matching[0]:undefined;
 if(!actual||actual.namespace!=='worker'||actual.scopeId!==operationId||actual.tool!=='save_notion_draft'||actual.effect!=='external_write'||actual.state!=='completed')return;
 const value=actual.output&&typeof actual.output==='object'&&!Array.isArray(actual.output)?actual.output as Record<string,unknown>:undefined;
 if(!value||!['verified','delivered'].includes(String(value.state))||value.pageId!==receipt.pageId||!notionWriteAcknowledged(receipt,operationId)&&value.digest!==receipt.digest||value.expectedDigest!==receipt.expectedDigest||value.final!==true)return;
 if(value.content!==undefined&&!notionSourceMatchesReceipt(value.content,receipt))return;
 return actual;
}
/** Deliberately narrow: a read/review is not permission to rewrite the page. */
export function notionRevisionRequested(request:string){
 if(/只读|(?:不|不要|不用|无需)(?:再)?(?:修改|改写|重写|保存|写入|更新)/.test(request))return false;
 return /补(?:充|料|写|进|到)|改(?:写|成|为|一下|一版|这|掉)|修(?:订|改)|重写|重做|更新(?:这|原|文|正|到|一下)|替换|完善|扩写|续写|写进|存进|保存(?:到|进)|接着(?:写|改)|继续(?:修改|写|改)/.test(request);
}

/** Restore only evidence that can still fulfil this attempt. A verified old
 * page is a revision target, never permission to create a replacement page.
 * The caller verifies workspace/connection scope before using this plan. */
export function notionRetryCheckpointPlan(source:WorkRun,options:{newWrite:boolean;scopeId?:string}):{blocked:boolean;message?:string;steps:TaskStep[];pageId?:string;forceWrite:boolean;notionReceipt?:WorkRun['notionReceipt']}{
 const receipt=source.notionReceipt;
 const preSend=receipt&&['not_sent','rejected'].includes(receipt.delivery||'');
 const steps=structuredClone(source.steps??[]);
 const sourceScope=source.steps?.filter(step=>step.key===receipt?.checkpointKey&&step.namespace==='worker'&&step.tool==='save_notion_draft'&&step.effect==='external_write').at(-1)?.scopeId;
 const delivered=notionDeliveryConfirmed(receipt,sourceScope??'');
 const unresolvedReceipt=receipt&&!delivered&&!preSend;
 const unresolvedWrite=steps.some(step=>step.effect==='external_write'&&step.state==='started'&&!(step.tool==='save_notion_draft'&&(preSend||delivered&&step.key===receipt?.checkpointKey)));
 const proof=steps.filter(step=>step.namespace==='worker'&&step.tool==='save_notion_draft'&&step.effect==='external_write'&&step.state==='completed'&&toolSucceeded(step.output)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).at(-1);
 const savedOutput=proof?.output as {state?:string;pageId?:string;final?:boolean}|undefined;
 const pageId=validPageId(receipt?.pageId)?receipt.pageId:validPageId(source.notionTarget?.pageId)?source.notionTarget!.pageId:savedOutput?.state==='verified'&&validPageId(savedOutput.pageId)?savedOutput.pageId:undefined;
 if(unresolvedReceipt||unresolvedWrite)return {blocked:true,message:'上次 Notion 保存还没确认，先核对原页面；不会重复新建或覆盖。',steps,pageId,forceWrite:false};
 if(delivered&&receipt?.state!=='verified'&&!options.newWrite)return {blocked:true,message:'原稿已经保存。请查看原任务结果，或直接补充具体修改要求。',steps,pageId,forceWrite:false};
 const requiredKnowledge=source.contract?.requiredTools.includes('knowledge_search')??false;
 const knowledgeBeforeSave=!proof||steps.some(step=>step.tool==='knowledge_search'&&step.state==='completed'&&toolSucceeded(step.output)&&Number.isFinite(Date.parse(step.updatedAt))&&Number.isFinite(Date.parse(proof.updatedAt))&&Date.parse(step.updatedAt)<=Date.parse(proof.updatedAt));
 // A draft written before the mandatory source read is not the completed
 // article. After material arrives, it still needs the requested revision.
 const unfinishedDraft=proof&&['partial','needs_input'].includes(source.resultOutcome??'')&&(!receipt?.final||!savedOutput?.final);
 const forceWrite=options.newWrite||Boolean(proof&&requiredKnowledge&&!knowledgeBeforeSave)||Boolean(unfinishedDraft);
 const consistentProof=receipt?.state==='verified'&&validPageId(receipt.pageId)&&savedOutput?.state==='verified'&&savedOutput.pageId===receipt.pageId;
 const reusableSave=!forceWrite&&consistentProof;
 const restored=steps.filter(step=>step.tool!=='read_notion_document'&&(step.tool!=='save_notion_draft'||reusableSave&&step===proof));
 if(reusableSave&&options.scopeId){const save=restored.find(step=>step.tool==='save_notion_draft');if(save)save.scopeId=options.scopeId;}
 return {blocked:false,steps:restored,pageId,forceWrite,
  ...(reusableSave?{notionReceipt:structuredClone(receipt)}:{})};
}

/** This round's write status is distinct from an already existing document. */
export function notionDeliveryNote(receipt:WorkRun['notionReceipt'],existingPageId?:string){
 const delivered=receipt?.state==='verified'||receipt?.state==='delivered'&&notionWriteAcknowledged(receipt,receipt.writeAcknowledgement?.operationId??'');
 const id=delivered?receipt.pageId:existingPageId;
 if(id&&/^[a-f0-9]{32}$/i.test(id.replaceAll('-',''))){
  const label=receipt?.state==='verified'?'已保存到 Notion · 已回读核对':delivered?'已保存到 Notion':'打开 Notion 原文';
  return `\n\n[${label}](https://www.notion.so/${id.replaceAll('-','')})`;
 }
 return '\n\n本轮尚未确认保存到 Notion。';
}

/** A delivered final-manuscript fallback for creates or same-page revisions.
 * It accepts an exact successful write ACK or historical full-read proof.
 * Final intent and the precise save checkpoint must agree with this attempt.
 * The caller still verifies the Key, workspace, grants and immutable task.
 * Never use mere file existence or a model's completion claim as evidence. */
export function verifiedNotionCompletion(receipt:WorkRun['notionReceipt'],steps:TaskStep[],requiredTools:string[],options?:{scopeId:string}){
 // Historical digest hashes raw readback, while expectedDigest hashes the
 // normalized source. ACK delivery uses its immutable source binding instead.
 const operationId=options?.scopeId??receipt?.writeAcknowledgement?.operationId??'';
 if(!notionDeliveryConfirmed(receipt,operationId)||!receipt?.pageId)return undefined;
 if(options?steps.some(s=>s.state==='started'):steps.some(s=>s.state!=='completed'||!toolSucceeded(s.output)))return undefined;
 const save=steps.filter(s=>s.namespace==='worker'&&s.tool==='save_notion_draft'&&s.effect==='external_write'&&(!options||s.scopeId===options.scopeId)&&s.state==='completed'&&toolSucceeded(s.output)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).at(-1);
 const proof=save?.output as {state?:string;pageId?:string;final?:boolean;digest?:string;expectedDigest?:string;content?:string}|undefined;
 if(!['verified','delivered'].includes(proof?.state??'')||proof?.pageId!==receipt.pageId||requiredTools.some(name=>!steps.some(s=>s.tool===name&&s.state==='completed'&&toolSucceeded(s.output))))return undefined;
 if(options&&(!receipt.final||!proof.final||!notionWriteAcknowledged(receipt,operationId)&&proof.digest!==receipt.digest||proof.expectedDigest!==receipt.expectedDigest))return undefined;
 if(requiredTools.includes('knowledge_search')&&(!save||!Number.isFinite(Date.parse(save.updatedAt))||!steps.some(s=>s.tool==='knowledge_search'&&s.state==='completed'&&toolSucceeded(s.output)&&Number.isFinite(Date.parse(s.updatedAt))&&Date.parse(s.updatedAt)<=Date.parse(save.updatedAt))))return undefined;
 const url=`https://www.notion.so/${receipt.pageId.replaceAll('-','')}`;
 const manuscript=notionSourceMatchesReceipt(proof.content,receipt)?proof.content:undefined;
 const checked=receipt.state==='verified'&&!receipt.verification;
 return JSON.stringify({outcome:'completed',content:manuscript?`${manuscript}\n\n[已保存到 Notion](${url})`:checked?`文章已保存到 Notion，正文也回读核对过了。[打开文章](${url})`:`文章已保存到 Notion。[打开文章](${url})`,summary:checked?'文章已保存，正文已回读核对。':'文章已保存到 Notion。'});
}
