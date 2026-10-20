import type {WorkRun} from './coordinatorTypes.js';
import {toolSucceeded,type TaskStep} from './taskSteps.js';

/** This round's write status is distinct from an already existing document. */
export function notionDeliveryNote(receipt:WorkRun['notionReceipt'],existingPageId?:string){
 const id=receipt?.state==='verified'?receipt.pageId:existingPageId;
 if(id&&/^[a-f0-9]{32}$/i.test(id.replaceAll('-',''))){
  const label=receipt?.state==='verified'?'已保存到 Notion · 已回读核对':'打开 Notion 原文';
  return `\n\n[${label}](https://www.notion.so/${id.replaceAll('-','')})`;
 }
 return '\n\n本轮尚未确认保存到 Notion。';
}

/** A receipt-only fallback for a newly created document, not a content review.
 * The caller still verifies the Key, workspace, grants and immutable task.
 * Never use mere file existence or a model's completion claim as evidence. */
export function verifiedNotionCompletion(receipt:WorkRun['notionReceipt'],steps:TaskStep[],requiredTools:string[]){
 // NotionDocuments verifies normalized readback before recording this state.
 // digest hashes raw readback; expectedDigest hashes normalized content, so
 // whitespace alone can legitimately make those two stored hashes differ.
 if(receipt?.state!=='verified'||!receipt.pageId||! /^[a-f0-9]{32}$/i.test(receipt.pageId.replaceAll('-',''))||!receipt.digest||! /^[a-f0-9]{64}$/i.test(receipt.digest)||!receipt.expectedDigest||! /^[a-f0-9]{64}$/i.test(receipt.expectedDigest))return undefined;
 if(steps.some(s=>s.state!=='completed'||!toolSucceeded(s.output)))return undefined;
 const save=steps.find(s=>s.namespace==='worker'&&s.tool==='save_notion_draft'&&s.effect==='external_write');
 const proof=save?.output as {state?:string;pageId?:string}|undefined;
 if(proof?.state!=='verified'||proof.pageId!==receipt.pageId||requiredTools.some(name=>!steps.some(s=>s.tool===name&&s.state==='completed'&&toolSucceeded(s.output))))return undefined;
 const url=`https://www.notion.so/${receipt.pageId.replaceAll('-','')}`;
 return JSON.stringify({outcome:'completed',content:`文章已保存到 Notion，正文也回读核对过了。[打开文章](${url})`,summary:'文章已保存，正文已回读核对。'});
}
