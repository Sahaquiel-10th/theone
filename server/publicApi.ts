import {randomBytes} from 'node:crypto';
import type {Database} from './types.js';
import {activePublication,createGuest,digest,ownedPublication,SharingError,usageFor} from './publicSharing.js';
import type {Publication,PublicApiGrant} from './publicSharingTypes.js';
import {uid} from './security.js';
export function apiGrantView(db:Database,p:Publication,g:PublicApiGrant){
  const ids=new Set(db.publicRuns!.filter(r=>r.publicationId===p.id&&r.apiGrantId===g.id).map(r=>r.id));
  const rows=db.modelUsageRecords.filter(r=>r.workspaceId===p.workspaceId&&r.userId===p.userId&&ids.has(r.conversationId));
  return {id:g.id,name:g.name,version:g.publicationVersion,status:g.status,budgetMicros:g.budgetMicros,perRunMicros:g.perRunMicros,expiresAt:g.expiresAt,createdAt:g.createdAt,spent:rows.reduce((n,r)=>n+(r.chargedMicros??0),0),held:rows.reduce((n,r)=>n+(r.reservedMicros??0),0)};
}
export function issueApiGrant(db:Database,scope:{workspaceId:string;userId:string},id:string,input:any){
  const p=ownedPublication(db,scope.workspaceId,scope.userId,id);activePublication(db,p.id);
  if(input?.confirmed!==true||typeof input.name!=='string'||!input.name.trim()||input.name.length>60||input.version!==(p.version??1))throw new SharingError('请检查名称、版本并确认 API 费用');
  const budget=Math.round(input.budget*1e6),perRun=Math.round(input.perRun*1e6);
  if(typeof input.budget!=='number'||typeof input.perRun!=='number'||!Number.isSafeInteger(budget)||!Number.isSafeInteger(perRun)||budget<10000||budget>p.budgetMicros||perRun<10000||perRun>budget||perRun>p.perRunMicros||!Number.isInteger(input.days)||input.days<1||input.days>90)throw new SharingError('API 额度不能超过分身额度，有效天数为 1–90');
  if((p.apiGrants??[]).length>=50)throw new SharingError('每个分身最多 50 个 API 密钥，请创建新的分身继续管理');
  const token=`one_api_${randomBytes(32).toString('base64url')}`,createdAt=new Date().toISOString();
  const {session}=createGuest(db,p.id,undefined,true);
  const g:PublicApiGrant={id:uid('apg'),...scope,name:input.name.trim(),tokenHash:digest(token),publicationVersion:p.version??1,status:'active',budgetMicros:budget,perRunMicros:perRun,expiresAt:new Date(Math.min(Date.parse(p.expiresAt),Date.now()+input.days*86400000)).toISOString(),createdAt,sessionId:session.id};
  session.apiGrantId=g.id;session.expiresAt=g.expiresAt;
  p.apiGrants=[...(p.apiGrants??[]),g];
  db.auditLogs.push({id:uid('aud'),...scope,actorUserId:scope.userId,action:'publication.api.issued',targetType:'publication',targetId:p.id,details:{grantId:g.id,version:g.publicationVersion,budgetMicros:budget,perRunMicros:perRun},createdAt});
  return {token,grant:apiGrantView(db,p,g)};
}
export function authenticateApi(db:Database,token:string){
  if(!/^one_api_[A-Za-z0-9_-]{43}$/.test(token))throw new SharingError('API 密钥无效',401);
  const hash=digest(token);
  const p=db.publications?.find(p=>p.apiGrants?.some(g=>g.tokenHash===hash)),g=p?.apiGrants?.find(g=>g.tokenHash===hash);
  if(!p||!g||g.status!=='active'||Date.parse(g.expiresAt)<=Date.now()||g.workspaceId!==p.workspaceId||g.userId!==p.userId)throw new SharingError('API 密钥无效、已撤销或到期',401);
  activePublication(db,p.id);
  if(g.publicationVersion!==(p.version??1))throw new SharingError('分身已更新，请主人签发新版 API 密钥',409);
  const session=db.publicSessions?.find(s=>s.id===g.sessionId&&s.apiGrantId===g.id&&s.publicationId===p.id&&s.workspaceId===p.workspaceId&&Date.parse(s.expiresAt)>Date.now());
  if(!session)throw new SharingError('API 会话不可用',401);
  return {publication:p,grant:g,session};
}
export function checkApiBudget(db:Database,p:Publication,g:PublicApiGrant,runId:string,amount:number){
  if(g.status!=='active'||g.publicationVersion!==(p.version??1)||Date.parse(g.expiresAt)<=Date.now())throw new SharingError('API 授权已停止',403);
  const used=apiGrantView(db,p,g),run=usageFor(db,p,runId);
  if(used.spent+used.held+amount>g.budgetMicros||run.spent+run.held+amount>g.perRunMicros)throw new SharingError('API 额度不足',402);
}
