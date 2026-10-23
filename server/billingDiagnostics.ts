import type {Database,ModelUsageRecord} from './types.js';

/** Retail attribution, NOT a supplier invoice and NOT a count of avoidable
 * waste. Only the caller's already-scoped records may enter this function. */
export function billingDiagnostics(db:Database,scope:{workspaceId:string;userId:string},records:ModelUsageRecord[]){
  const rows=records.filter(r=>r.workspaceId===scope.workspaceId&&r.userId===scope.userId);
  const groups=new Map<string,{requestId:string;calls:number;chargedMicros:number;inputBytes:number;profiledCalls:number;state:string}>();
  const stages=new Map<string,{activity:string;calls:number;chargedMicros:number}>();
  let cacheWriteMicros=0,cacheReadMicros=0;
  for(const row of rows){
    const requestId=row.requestId||row.id;
    const group=groups.get(requestId)??{requestId,calls:0,chargedMicros:0,inputBytes:0,profiledCalls:0,state:db.chatOperations?.find(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.requestId===requestId)?.status??'unknown'};
    group.calls++;group.chargedMicros+=row.chargedMicros??0;group.inputBytes+=row.inputProfile?.totalBytes??0;group.profiledCalls+=row.inputProfile?1:0;groups.set(requestId,group);
    const stage=stages.get(row.activity||'unknown')??{activity:row.activity||'unknown',calls:0,chargedMicros:0};stage.calls++;stage.chargedMicros+=row.chargedMicros??0;stages.set(stage.activity,stage);
    if(!row.cacheUsage||!row.chargedMicros)continue;
    const tier=row.contextPriceTier==='long'?row.pricingSnapshot?.longContext?.referenceCache:undefined;
    const prices=tier&&row.pricingSnapshot?{read:tier.read*row.pricingSnapshot.multiplier,write:tier.write*row.pricingSnapshot.multiplier,write1h:tier.write1h*row.pricingSnapshot.multiplier}:row.cachePricesSnapshot;
    if(!prices)continue;
    const factor=row.billingCapped&&row.calculatedChargeMicros?Math.min(1,row.chargedMicros/row.calculatedChargeMicros):1;
    cacheReadMicros+=Math.round(row.cacheUsage.read*prices.read*factor);
    cacheWriteMicros+=Math.round(((row.cacheUsage.write-row.cacheUsage.write1h)*prices.write+row.cacheUsage.write1h*prices.write1h)*factor);
  }
  return {chargedMicros:rows.reduce((n,r)=>n+(r.chargedMicros??0),0),cacheWriteMicros,cacheReadMicros,
    topRequests:[...groups.values()].sort((a,b)=>b.chargedMicros-a.chargedMicros).slice(0,10),
    byActivity:[...stages.values()].sort((a,b)=>b.chargedMicros-a.chargedMicros),
    profiledCalls:rows.filter(r=>r.inputProfile).length};
}
