import type {Database,User} from './types.js';
import {hashPassword,verifyPassword,uid} from './security.js';
import {SharingError} from './publicSharing.js';
export type VisitorIdentity={userId:string;workspaceId:string};
export function visitorUser(db:Database,s:VisitorIdentity){
  const u=db.users.find(u=>u.id===s.userId&&u.enabled&&u.defaultWorkspaceId===s.workspaceId);
  if(!u||!db.workspaces.some(w=>w.id===s.workspaceId&&w.status==='active')||!db.workspaceMembers.some(m=>m.status !== "disabled" && m.userId===u.id&&m.workspaceId===s.workspaceId))throw new SharingError('账号不可用',401);
  return u;
}
export function registerVisitor(db:Database,input:any):User{
  const username=typeof input?.username==='string'?input.username.trim().toLowerCase():'';
  if(!/^[a-z][a-z0-9_-]{3,31}$/.test(username)||typeof input.password!=='string'||input.password.length<10||input.password.length>128)throw new SharingError('账号用 4–32 位字母、数字、下划线；密码至少 10 位，最多 128 位');
  if(db.users.some(u=>u.username.toLowerCase()===username))throw new SharingError('这个账号已被使用');
  const createdAt=new Date().toISOString(),workspaceId=uid('wsp');
  const u:User={id:uid('usr'),username,passwordHash:hashPassword(input.password),role:'user',defaultWorkspaceId:workspaceId,enabled:true,createdAt,registrationOrigin:'visitor'};
  db.users.push(u);db.workspaces.push({id:workspaceId,name:`${username}的 ONE`,slug:workspaceId,status:'active',createdAt,updatedAt:createdAt});db.workspaceMembers.push({id:uid('wsm'),workspaceId,userId:u.id,role:'owner',createdAt});
  db.powerAccounts.push({id:uid('pwa'),workspaceId,userId:u.id,balanceMicros:0,paidBalanceMicros:0,reservedMicros:0,createdAt,updatedAt:createdAt});
  db.auditLogs.push({id:uid('aud'),workspaceId,actorUserId:u.id,action:'visitor.registered',targetType:'user',targetId:u.id,createdAt});return u;
}
export function loginVisitor(db:Database,input:any){
  if(typeof input?.username!=='string'||input.username.length>64||typeof input.password!=='string'||input.password.length>128)throw new SharingError('账号或密码错误',401);
  const u=db.users.find(u=>u.username.toLowerCase()===input.username.trim().toLowerCase()&&u.enabled);
  if(!u||!verifyPassword(input.password,u.passwordHash))throw new SharingError('账号或密码错误',401);
  visitorUser(db,{userId:u.id,workspaceId:u.defaultWorkspaceId});return u;
}
