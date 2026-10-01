import type {Database,ModelUsageRecord} from './types.js';
import type {PublicCommerceSnapshot} from './publicSharingTypes.js';
import {reservePower,releasePower,chargePower,powerAccount} from './powerBilling.js';
function amounts(base:number,multiplier:number){
  const payer=Math.ceil(base*multiplier-1e-7),publisher=Math.max(0,base-payer);
  if(!Number.isSafeInteger(payer)||payer<0||!Number.isSafeInteger(publisher))throw new Error('公开服务费用超出范围');
  return {payer,publisher};
}
function activeAccount(db:Database,workspaceId:string,userId:string){if(!db.users.some(u=>u.id===userId&&u.enabled)||!db.workspaceMembers.some(m=>m.userId===userId&&m.workspaceId===workspaceId)||!db.workspaces.some(w=>w.id===workspaceId&&w.status==='active'))throw new Error('付款账号不可用');}
export function reserveCommerce(db:Database,row:ModelUsageRecord,s:PublicCommerceSnapshot,base:number){
  if(row.workspaceId!==s.publisherWorkspaceId||row.userId!==s.publisherUserId||!Number.isFinite(s.multiplier)||s.multiplier<=0||s.multiplier>10||!Number.isInteger(s.publisherShareBps)||s.publisherShareBps<0||s.publisherShareBps>10000)throw new Error('公开服务计费绑定无效');
  activeAccount(db,s.payerWorkspaceId,s.payerUserId);activeAccount(db,s.publisherWorkspaceId,s.publisherUserId);
  const a=amounts(base,s.multiplier);
  reservePower(db,{workspaceId:s.payerWorkspaceId,userId:s.payerUserId,amountMicros:a.payer});
  if(a.publisher)reservePower(db,{workspaceId:s.publisherWorkspaceId,userId:s.publisherUserId,amountMicros:a.publisher});
  row.commercial={snapshot:structuredClone(s),payerReservedMicros:a.payer,publisherReservedMicros:a.publisher,status:'pending'};
}
export function releaseCommerce(db:Database,row:ModelUsageRecord){
  const c=row.commercial;if(!c||c.status!=='pending')return;
  const s=c.snapshot;releasePower(db,{workspaceId:s.payerWorkspaceId,userId:s.payerUserId,amountMicros:c.payerReservedMicros});
  if(c.publisherReservedMicros)releasePower(db,{workspaceId:s.publisherWorkspaceId,userId:s.publisherUserId,amountMicros:c.publisherReservedMicros});
  c.payerReservedMicros=0;c.publisherReservedMicros=0;
}
export function settleCommerce(db:Database,row:ModelUsageRecord,base:number){
  const c=row.commercial;if(!c||c.status!=='pending')return;
  const s=c.snapshot,a=amounts(base,s.multiplier);
  const payer=Math.min(a.payer,c.payerReservedMicros),publisher=Math.min(a.publisher,c.publisherReservedMicros);
  releaseCommerce(db,row);
  const entry=chargePower(db,{workspaceId:s.payerWorkspaceId,userId:s.payerUserId,amountMicros:payer,modelId:row.modelId,usageRecordId:row.id,title:'分身问答'});
  if(publisher)chargePower(db,{workspaceId:s.publisherWorkspaceId,userId:s.publisherUserId,amountMicros:publisher,modelId:row.modelId,usageRecordId:row.id,title:'分身补贴'});
  // Only the fraction funded by verified recharge principal creates revenue.
  const markup=Math.max(0,payer-base),paid=entry.paidPrincipalMicros;
  const eligible=payer?Number(BigInt(markup)*BigInt(paid)/BigInt(payer)):0;
  const revenue=Number(BigInt(eligible)*BigInt(s.publisherShareBps)/10000n);
  c.payerChargedMicros=payer;c.publisherChargedMicros=publisher;c.paidPrincipalMicros=paid;c.bonusMicros=entry.bonusMicros;c.publisherRevenueMicros=revenue;c.platformRevenueMicros=eligible-revenue;c.settledAt=new Date().toISOString();c.status='settled';
}
export function restoreCommerceHolds(db:Database,row:ModelUsageRecord){
  const c=row.commercial;if(!c||c.status!=='pending')return;
  const s=c.snapshot,payer=powerAccount(db,s.payerWorkspaceId,s.payerUserId),publisher=powerAccount(db,s.publisherWorkspaceId,s.publisherUserId);
  if(payer)payer.reservedMicros=(payer.reservedMicros??0)+c.payerReservedMicros;
  if(publisher)publisher.reservedMicros=(publisher.reservedMicros??0)+c.publisherReservedMicros;
}
