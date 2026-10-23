import type {Express,RequestHandler} from 'express';
import type {Store} from './db.js';
import type {Database} from './types.js';
import {activePeriod,membershipAccount} from './memberships.js';
import {creditPower} from './powerBilling.js';
import {uid} from './security.js';

export class PowerControlError extends Error{constructor(message:string,readonly status=400){super(message);}}
function target(db:Database,actorId:string,userId:string){
  if(!db.users.some(u=>u.id===actorId&&u.enabled&&u.role==='admin'))throw new PowerControlError('需要管理员权限',403);
  const user=db.users.find(u=>u.id===userId);
  if(!user)throw new PowerControlError('用户不存在',404);
  return {user,account:membershipAccount(db,{workspaceId:user.defaultWorkspaceId,userId:user.id})};
}
export function powerControlPreview(db:Database,actorId:string,userId:string){
  const {user,account}=target(db,actorId,userId),period=activePeriod(account);
  return {userId:user.id,workspaceId:account.workspaceId,username:user.username,balanceMicros:account.balanceMicros,current:period?{
    id:period.id,remainingMicros:period.remainingMicros,grantedMicros:period.grantedMicros,endsAt:period.endsAt,
    reservedMicros:(account.powerHolds??[]).flatMap(h=>h.periods).filter(p=>p.id===period.id).reduce((n,p)=>n+p.amountMicros,0),
  }:null};
}
type Gift={kind:'gift';operationId:string;power:number;title:string};
type Reset={kind:'reset';operationId:string;periodId:string;expectedRemainingMicros:number;expectedGrantedMicros:number};
/** Atomic, append-only corrections; never erase usage, holds, future periods,
 * expiration, paid principal or execution safety protections. */
export function applyPowerControl(db:Database,actorId:string,userId:string,input:Gift|Reset){
  const {user,account}=target(db,actorId,userId);
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(input.operationId))throw new PowerControlError('操作编号无效，请刷新后重试');
  const operationKey=`${actorId}:${input.operationId}`,payload=JSON.stringify(input);
  const prior=db.auditLogs.find(a=>a.action==='admin.power.control'&&a.details?.operationKey===operationKey);
  if(prior){
    if(prior.targetId!==userId||prior.workspaceId!==account.workspaceId||prior.details?.payload!==payload)throw new PowerControlError('本次操作与原提交不一致，请先核对记录',409);
    return prior.details!.result as {entryId:string;kind:'gift'|'reset';amountMicros:number;beforeMicros:number;afterMicros:number};
  }
  const at=new Date().toISOString();
  let result:{entryId:string;kind:'gift'|'reset';amountMicros:number;beforeMicros:number;afterMicros:number};
  if(input.kind==='gift'){
    const amount=input.power*1e6;
    if(!Number.isSafeInteger(amount)||amount<=0||input.power>1e6)throw new PowerControlError('请输入有效电力，最多保留6位小数');
    if(typeof input.title!=='string'||!input.title.trim()||input.title.length>80)throw new PowerControlError('请填写80字以内的赠送备注');
    const entry=creditPower(db,{workspaceId:account.workspaceId,userId:user.id,amountMicros:amount,type:'gift',title:input.title.trim(),createdByUserId:actorId});
    result={entryId:entry.id,kind:'gift',amountMicros:amount,beforeMicros:entry.balanceBeforeMicros,afterMicros:entry.balanceAfterMicros};
  }else{
    const period=activePeriod(account);
    if(!period||period.id!==input.periodId||period.remainingMicros!==input.expectedRemainingMicros||period.grantedMicros!==input.expectedGrantedMicros)throw new PowerControlError('本期额度已变化，请刷新后重新确认',409);
    const before=period.remainingMicros,after=period.grantedMicros;
    if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after<before)throw new PowerControlError('本期额度记录需要核对，尚未修改',409);
    const held=(account.powerHolds??[]).flatMap(h=>h.periods).filter(p=>p.id===period.id).reduce((n,p)=>n+p.amountMicros,0);
    if(held>before)throw new PowerControlError('本期预留记录需要核对，尚未修改',409);
    const entryId=uid('pwl');period.remainingMicros=after;account.updatedAt=at;
    db.powerLedger.push({id:entryId,workspaceId:account.workspaceId,userId:user.id,type:'adjustment',amountMicros:after-before,membershipMicros:after-before,
      membershipAdjustment:{periodId:period.id,beforeMicros:before,afterMicros:after},balanceBeforeMicros:account.balanceMicros,balanceAfterMicros:account.balanceMicros,title:'重置本期套餐额度',createdByUserId:actorId,createdAt:at});
    result={entryId,kind:'reset',amountMicros:after-before,beforeMicros:before,afterMicros:after};
  }
  db.auditLogs.push({id:uid('aud'),actorUserId:actorId,workspaceId:account.workspaceId,action:'admin.power.control',targetType:'user',targetId:user.id,details:{operationKey,payload,result},createdAt:at});
  return result;
}
export function installAdminPowerControls(app:Express,admin:readonly RequestHandler[],store:Store){
  const fail=(res:import('express').Response,error:unknown)=>res.status(error instanceof PowerControlError?error.status:400).json({error:error instanceof PowerControlError?error.message:'当前账户不可操作，请核对账号与所属空间'});
  app.get('/api/admin/users/:id/power-controls',...admin,async(req,res)=>{
    try{res.set('Cache-Control','no-store').json(powerControlPreview(await store.read(),req.user!.id,String(req.params.id)));}catch(error){fail(res,error);}
  });
  app.post('/api/admin/users/:id/power',...admin,async(req,res)=>{
    try{const result=await store.mutate(db=>applyPowerControl(db,req.user!.id,String(req.params.id),{kind:'gift',operationId:req.body.operationId,power:req.body.power,title:req.body.title}));res.json({result});}catch(error){fail(res,error);}
  });
  app.post('/api/admin/users/:id/reset-membership',...admin,async(req,res)=>{
    try{const result=await store.mutate(db=>applyPowerControl(db,req.user!.id,String(req.params.id),{kind:'reset',operationId:req.body.operationId,periodId:req.body.periodId,expectedRemainingMicros:req.body.expectedRemainingMicros,expectedGrantedMicros:req.body.expectedGrantedMicros}));res.json({result});}catch(error){fail(res,error);}
  });
}
