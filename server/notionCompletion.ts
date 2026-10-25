import type {WorkRun} from './coordinatorTypes.js';
import {toolSucceeded,type TaskStep} from './taskSteps.js';

const validPageId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/i.test(value.replaceAll('-',''));
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
 const unresolvedReceipt=receipt&&receipt.state!=='verified'&&!preSend;
 const unresolvedWrite=steps.some(step=>step.effect==='external_write'&&step.state==='started'&&!(step.tool==='save_notion_draft'&&preSend));
 const proof=steps.filter(step=>step.namespace==='worker'&&step.tool==='save_notion_draft'&&step.effect==='external_write'&&step.state==='completed'&&toolSucceeded(step.output)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).at(-1);
 const savedOutput=proof?.output as {state?:string;pageId?:string;final?:boolean}|undefined;
 const pageId=validPageId(receipt?.pageId)?receipt.pageId:validPageId(source.notionTarget?.pageId)?source.notionTarget!.pageId:savedOutput?.state==='verified'&&validPageId(savedOutput.pageId)?savedOutput.pageId:undefined;
 if(unresolvedReceipt||unresolvedWrite)return {blocked:true,message:'上次 Notion 保存还没确认，先核对原页面；不会重复新建或覆盖。',steps,pageId,forceWrite:false};
 const requiredKnowledge=source.contract?.requiredTools.includes('knowledge_search')??false;
 const knowledgeBeforeSave=!proof||steps.some(step=>step.tool==='knowledge_search'&&step.state==='completed'&&toolSucceeded(step.output)&&Number.isFinite(Date.parse(step.updatedAt))&&Number.isFinite(Date.parse(proof.updatedAt))&&Date.parse(step.updatedAt)<=Date.parse(proof.updatedAt));
 // A draft written before the mandatory source read is not the completed
 // article. After material arrives, it must be revised and read back again.
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
 const id=receipt?.state==='verified'?receipt.pageId:existingPageId;
 if(id&&/^[a-f0-9]{32}$/i.test(id.replaceAll('-',''))){
  const label=receipt?.state==='verified'?'已保存到 Notion · 已回读核对':'打开 Notion 原文';
  return `\n\n[${label}](https://www.notion.so/${id.replaceAll('-','')})`;
 }
 return '\n\n本轮尚未确认保存到 Notion。';
}

/** A verified final-manuscript fallback for creates or same-page revisions,
 * not a semantic review of the article. With an attempt scope, a plain draft
 * save is deliberately insufficient; final intent and its exact readback must
 * agree with the latest receipt.
 * The caller still verifies the Key, workspace, grants and immutable task.
 * Never use mere file existence or a model's completion claim as evidence. */
export function verifiedNotionCompletion(receipt:WorkRun['notionReceipt'],steps:TaskStep[],requiredTools:string[],options?:{scopeId:string}){
 // NotionDocuments verifies normalized readback before recording this state.
 // digest hashes raw readback; expectedDigest hashes normalized content, so
 // whitespace alone can legitimately make those two stored hashes differ.
 if(receipt?.state!=='verified'||!receipt.pageId||! /^[a-f0-9]{32}$/i.test(receipt.pageId.replaceAll('-',''))||!receipt.digest||! /^[a-f0-9]{64}$/i.test(receipt.digest)||!receipt.expectedDigest||! /^[a-f0-9]{64}$/i.test(receipt.expectedDigest))return undefined;
 if(options?steps.some(s=>s.state==='started'):steps.some(s=>s.state!=='completed'||!toolSucceeded(s.output)))return undefined;
 const save=steps.filter(s=>s.namespace==='worker'&&s.tool==='save_notion_draft'&&s.effect==='external_write'&&(!options||s.scopeId===options.scopeId)&&s.state==='completed'&&toolSucceeded(s.output)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).at(-1);
 const proof=save?.output as {state?:string;pageId?:string;final?:boolean;digest?:string;expectedDigest?:string}|undefined;
 if(proof?.state!=='verified'||proof.pageId!==receipt.pageId||requiredTools.some(name=>!steps.some(s=>s.tool===name&&s.state==='completed'&&toolSucceeded(s.output))))return undefined;
 if(options&&(!receipt.final||!proof.final||proof.digest!==receipt.digest||proof.expectedDigest!==receipt.expectedDigest))return undefined;
 if(requiredTools.includes('knowledge_search')&&(!save||!Number.isFinite(Date.parse(save.updatedAt))||!steps.some(s=>s.tool==='knowledge_search'&&s.state==='completed'&&toolSucceeded(s.output)&&Number.isFinite(Date.parse(s.updatedAt))&&Date.parse(s.updatedAt)<=Date.parse(save.updatedAt))))return undefined;
 const url=`https://www.notion.so/${receipt.pageId.replaceAll('-','')}`;
 return JSON.stringify({outcome:'completed',content:`文章已保存到 Notion，正文也回读核对过了。[打开文章](${url})`,summary:'文章已保存，正文已回读核对。'});
}
