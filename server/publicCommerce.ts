import type {Database} from './types.js';
import type {Publication,PublicSession,PublicRun,PublicCommercePolicy,PublicCommerceSnapshot} from './publicSharingTypes.js';
import {SharingError,ownedPublication} from './publicSharing.js';
import {visitorUser,type VisitorIdentity} from './visitorAccounts.js';
import {uid} from './security.js';
export const commercePolicy=(db:Database):PublicCommercePolicy=>db.settings.publicCommercePolicy??{revision:0,visitorPaymentsEnabled:false,publisherShareBps:10000};
export function publicationAccess(db:Database,p:Publication,identity?:VisitorIdentity){
  if((p.requireLogin||(p.visitorMultiplier??0)>0||p.allowedUserIds?.length)&&!identity)throw new SharingError('这个分身需要登录账号后使用',401,'VISITOR_LOGIN_REQUIRED');
  if(identity){visitorUser(db,identity);if(p.allowedUserIds?.length&&!p.allowedUserIds.includes(identity.userId))throw new SharingError('这个分身尚未向你的账号开放',403);}
}
export function publicationCommerceFields(db:Database,input:any){
  const percent=input.visitorPercent??0;
  if(typeof percent!=='number'||!Number.isFinite(percent)||percent<0||percent>1000||Math.abs(Math.round(percent*100)-percent*100)>1e-7)throw new SharingError('访客收费百分比为 0–1000，最多两位小数');
  if(percent>0&&!commercePolicy(db).visitorPaymentsEnabled)throw new SharingError('访客付费尚未启用，请管理员先配置计费政策');
  const names=input.allowedUsernames??[];
  if(!Array.isArray(names)||names.length>100||names.some(n=>typeof n!=='string'||n.length>64))throw new SharingError('最多指定 100 个已注册账号');
  const ids=[...new Set<string>(names.filter((name:string)=>name.trim()).map((name:string)=>{const u=db.users.find(u=>u.enabled&&u.username.toLowerCase()===name.trim().toLowerCase());if(!u)throw new SharingError('指定账号尚未注册或不可用');return u.id;}))];
  return {visitorMultiplier:percent/100,requireLogin:input.requireLogin===true||percent>0||ids.length>0,allowedUserIds:ids};
}
function sponsorUsage(db:Database,p:Publication,id:string){
  const runs=new Set(db.publicRuns!.filter(r=>r.publicationId===p.id&&r.workspaceId===p.workspaceId&&r.commerce?.sponsorshipId===id).map(r=>r.id));
  return db.modelUsageRecords.filter(r=>r.workspaceId===p.workspaceId&&r.userId===p.userId&&runs.has(r.conversationId)).reduce((n,r)=>n+(r.chargedMicros??0)+(r.reservedMicros??0),0);
}
export function runCommerce(db:Database,p:Publication,s:PublicSession):PublicCommerceSnapshot|undefined{
  if(s.apiGrantId)return; // API keys retain publisher-paid policy explicitly granted by owner.
  const identity=s.accountUserId&&s.accountWorkspaceId?{userId:s.accountUserId,workspaceId:s.accountWorkspaceId}:undefined;
  publicationAccess(db,p,identity);
  const grant=identity?p.sponsorships?.find(g=>g.visitorUserId===identity.userId&&g.status==='active'&&g.budgetMicros>sponsorUsage(db,p,g.id)):undefined;
  const multiplier=grant?0:p.visitorMultiplier??0;
  if(!multiplier&&!grant)return;
  const policy=commercePolicy(db);
  if(multiplier>0&&!policy.visitorPaymentsEnabled)throw new SharingError('访客付费暂时暂停',503);
  return {publicationId:p.id,publicationVersion:p.version??1,publisherWorkspaceId:p.workspaceId,publisherUserId:p.userId,payerWorkspaceId:identity!.workspaceId,payerUserId:identity!.userId,multiplier,publisherShareBps:policy.publisherShareBps,policyRevision:policy.revision,sponsorshipId:grant?.id};
}
export function verifyRunCommerce(db:Database,p:Publication,r:PublicRun,amount:number){
  if(r.apiGrantId)return;
  const session=db.publicSessions!.find(s=>s.id===r.sessionId&&s.workspaceId===r.workspaceId&&s.publicationId===p.id);
  if(!session||Date.parse(session.expiresAt)<=Date.now())throw new SharingError('会话已停止',403);
  publicationAccess(db,p,session.accountUserId&&session.accountWorkspaceId?{userId:session.accountUserId,workspaceId:session.accountWorkspaceId}:undefined);
  const c=r.commerce;
  if(c?.multiplier&&(!commercePolicy(db).visitorPaymentsEnabled||p.visitorMultiplier!==c.multiplier))throw new SharingError('访客付费已暂停或版本已变化',409);
  if(c?.sponsorshipId){const grant=p.sponsorships?.find(g=>g.id===c.sponsorshipId&&g.visitorUserId===session.accountUserId&&g.status==='active');if(!grant||sponsorUsage(db,p,grant.id)+amount>grant.budgetMicros)throw new SharingError('赠送使用额度不足或已撤销',402);}
}
export function grantSponsorship(db:Database,scope:VisitorIdentity,id:string,input:any){
  const p=ownedPublication(db,scope.workspaceId,scope.userId,id),username=typeof input?.username==='string'?input.username.trim().toLowerCase():'';
  const u=db.users.find(u=>u.enabled&&u.username.toLowerCase()===username),budget=Math.round(input?.budget*1e6);
  if(!u||typeof input.budget!=='number'||!Number.isSafeInteger(budget)||budget<10000||budget>p.budgetMicros||input.confirmed!==true)throw new SharingError('请输入已注册账号、有效使用额度并确认费用');
  if((p.sponsorships??[]).length>=100)throw new SharingError('每个分身最多 100 项赠送记录');
  if(p.sponsorships?.some(g=>g.visitorUserId===u.id&&g.status==='active'))throw new SharingError('该账号已有赠送额度，请先撤销旧额度');
  const grant={id:uid('spg'),workspaceId:p.workspaceId,userId:p.userId,visitorUserId:u.id,name:u.username,budgetMicros:budget,status:'active' as const,createdAt:new Date().toISOString()};p.sponsorships=[...(p.sponsorships??[]),grant];
  db.auditLogs.push({id:uid('aud'),workspaceId:p.workspaceId,actorUserId:p.userId,action:'publication.sponsorship.created',targetType:'publication',targetId:p.id,details:{grantId:grant.id,budgetMicros:budget},createdAt:grant.createdAt});return grant;
}
export function sponsorshipView(db:Database,p:Publication){return (p.sponsorships??[]).map(g=>({id:g.id,name:g.name,status:g.status,budgetMicros:g.budgetMicros,usedMicros:sponsorUsage(db,p,g.id),createdAt:g.createdAt}));}
