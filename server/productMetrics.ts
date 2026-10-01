import type {Database} from './types.js';

const DAY=86400000,OFFSET=8*3600000;
const time=(s?:string)=>s?Date.parse(s):NaN;
const day=(t:number)=>Math.floor((t+OFFSET)/DAY);
export const metricDay=(d:number)=>new Date(d*DAY).toISOString().slice(0,10);
export const metricsDefinitions={
  active:'有效活跃：当天至少完成一次私人问答、官方功能、本机任务，或登录访客的公开问答。打开页面、登录、模型中间调用和失败不计入。',
  retention:'D1 / D7：注册后的第 1 / 第 7 个北京时间自然日有有效使用；仅统计观察日已完整结束的账号。人工开通日期作为账号创建日期，不等同于自主注册。',
  recharge:'仅统计已确认到账的微信充值；充值是预付款，不是已确认收入。复购表示至少两笔到账充值。',
  risk:'低余额待充值：余额不足 1 电力且近 30 天有效使用过；7–29 天未用为待唤回，30 天及以上未用为沉默，不推断订阅到期或欠费。',
  population:'默认排除管理员及手工标记的测试账号；禁用账号保留在累计账号口径中。匿名分享访客只计问题数，不冒充注册用户。历史指标仅基于现存记录。'
};
export function productMetrics(db:Database,now=Date.now()){
  const today=day(now),valid=(s?:string)=>Number.isFinite(time(s))&&time(s)<=now;
  const population=db.users.filter(u=>u.role!=='admin'&&!u.analyticsExcluded&&valid(u.createdAt));
  const users=new Map(population.map(u=>[u.id,u]));
  const activity=new Map<string,Set<number>>(),eventKeys=new Set<string>();
  const add=(userId:string,workspaceId:string,at:string,key:string)=>{
    const u=users.get(userId);if(!u||u.defaultWorkspaceId!==workspaceId||!valid(at)||time(at)<time(u.createdAt)||!db.workspaceMembers.some(m=>m.userId===userId&&m.workspaceId===workspaceId))return;
    if(eventKeys.has(`${userId}:${key}`))return;eventKeys.add(`${userId}:${key}`);
    const days=activity.get(userId)??new Set<number>();days.add(day(time(at)));activity.set(userId,days);
  };
  for(const e of db.auditLogs)if(e.action==='chat.completed')add(e.actorUserId??'',e.workspaceId??'',e.createdAt,`chat:${e.requestId??e.id}`);
  for(const e of db.executionTasks)if(e.status==='completed'&&e.completedAt)add(e.userId,e.workspaceId,e.completedAt,`local:${e.id}`);
  for(const e of db.chatOperations??[])if(e.featureRun&&e.status==='completed')add(e.userId,e.workspaceId,e.updatedAt??e.createdAt,`feature:${e.id}`);
  let anonymousQuestions30=0;
  for(const r of db.publicRuns??[]){
    if(r.status!=='completed'||!valid(r.completedAt))continue;
    const p=db.publications?.find(p=>p.id===r.publicationId&&p.workspaceId===r.workspaceId);
    const s=db.publicSessions?.find(s=>s.id===r.sessionId&&s.publicationId===r.publicationId&&s.workspaceId===r.workspaceId);
    if(!p||!s)continue;
    if(s.accountUserId&&s.accountWorkspaceId)add(s.accountUserId,s.accountWorkspaceId,r.completedAt!,`public:${r.id}`);
    else if(day(time(r.completedAt))>=today-29)anonymousQuestions30++;
  }
  const orders=db.rechargeOrders.filter(o=>{
    const u=users.get(o.userId);return !!u&&u.defaultWorkspaceId===o.workspaceId&&o.status==='paid'&&!!o.payment&&valid(o.paidAt)&&o.payment.state==='paid'&&!!o.payment.transactionId;
  });
  const rows=population.map(u=>{
    const days=[...(activity.get(u.id)??[])].sort((a,b)=>a-b),lastDay=days.at(-1),age=lastDay===undefined?undefined:today-lastDay;
    const account=db.powerAccounts.find(a=>a.userId===u.id&&a.workspaceId===u.defaultWorkspaceId),balance=Math.max(0,(account?.balanceMicros??0)-(account?.reservedMicros??0));
    const paid=orders.filter(o=>o.userId===u.id),lowBalance=age!==undefined&&age<30&&balance<1e6;
    const state=age===undefined?'never':age<7?'active':age<30?'at_risk':'dormant';
    return {id:u.id,username:u.username,enabled:u.enabled,origin:u.registrationOrigin==='visitor'?'self_registered':'provisioned',createdAt:u.createdAt,activeDays7:days.filter(d=>d>=today-6).length,lastActiveDay:lastDay===undefined?undefined:metricDay(lastDay),state,availableMicros:balance,lowBalance,rechargeCount:paid.length,rechargeCny:paid.reduce((n,o)=>n+o.amountCny,0)};
  });
  const daily=Array.from({length:30},(_,i)=>{
    const d=today-29+i,paid=orders.filter(o=>day(time(o.paidAt))===d);
    return {date:metricDay(d),activeUsers:[...activity.values()].filter(s=>s.has(d)).length,newAccounts:population.filter(u=>day(time(u.createdAt))===d).length,newSelfRegistered:population.filter(u=>u.registrationOrigin==='visitor'&&day(time(u.createdAt))===d).length,rechargeCny:paid.reduce((n,o)=>n+o.amountCny,0),payingUsers:new Set(paid.map(o=>o.userId)).size};
  });
  const retained=(offset:number)=>{
    const eligible=population.filter(u=>day(time(u.createdAt))+offset<today); // Exclude unfinished observation days.
    const count=eligible.filter(u=>activity.get(u.id)?.has(day(time(u.createdAt))+offset)).length;
    return {eligible:eligible.length,retained:count,rate:eligible.length?count/eligible.length:null};
  };
  const activeIn=(n:number)=>[...activity.values()].filter(s=>[...s].some(d=>d>=today-n+1&&d<=today)).length;
  const usages=db.modelUsageRecords.filter(r=>r.status==='success'&&valid(r.completedAt)&&day(time(r.completedAt))>=today-29&&
    (users.get(r.userId)?.defaultWorkspaceId===r.workspaceId||!!r.commercial&&users.get(r.commercial.snapshot.payerUserId)?.defaultWorkspaceId===r.commercial.snapshot.payerWorkspaceId));
  const paid30=orders.filter(o=>day(time(o.paidAt))>=today-29),mau=activeIn(30),dau=activeIn(1);
  return {asOf:new Date(now).toISOString(),timezone:'Asia/Shanghai',definitions:metricsDefinitions,excludedUserIds:db.users.filter(u=>u.role!=='admin'&&u.analyticsExcluded).map(u=>u.id),
    summary:{accounts:rows.length,enabledAccounts:rows.filter(r=>r.enabled).length,selfRegistered:rows.filter(r=>r.origin==='self_registered').length,provisioned:rows.filter(r=>r.origin==='provisioned').length,excludedAccounts:db.users.filter(u=>u.role==='admin'||u.analyticsExcluded).length,
      newAccounts7:population.filter(u=>day(time(u.createdAt))>=today-6).length,newAccounts30:population.filter(u=>day(time(u.createdAt))>=today-29).length,
      activated:activity.size,dau,wau:activeIn(7),mau,stickiness:mau?dau/mau:null,d1:retained(1),d7:retained(7),
      lowBalance:rows.filter(r=>r.lowBalance).length,atRisk:rows.filter(r=>r.state==='at_risk').length,dormant:rows.filter(r=>r.state==='dormant').length,neverActivated:rows.filter(r=>r.state==='never').length,
      payingUsers30:new Set(paid30.map(o=>o.userId)).size,payingUsersEver:new Set(orders.map(o=>o.userId)).size,repeatPayers:rows.filter(r=>r.rechargeCount>=2).length,
      rechargeCny30:paid30.reduce((n,o)=>n+o.amountCny,0),consumedMicros30:usages.reduce((n,r)=>n+(r.commercial?(r.commercial.payerChargedMicros??0)+(r.commercial.publisherChargedMicros??0):r.chargedMicros??0),0),costMicros30:usages.reduce((n,r)=>n+(r.costMicros??0),0),anonymousQuestions30},daily,users:rows};
}
