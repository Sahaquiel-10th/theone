import crypto from "node:crypto";
import type { Database, User, Workspace, WorkspaceMember } from "./types.js";
import { activeMember, billingAccountUserId, companyWorkspace, type EnterpriseScope } from "./enterprisePolicy.js";
import { hashPassword, uid } from "./security.js";
import { creditPower, powerAccount } from "./powerBilling.js";

export class CompanyError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function text(value: unknown, label: string, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new CompanyError(`${label}不能为空且最多 ${max} 字`);
  return value.trim();
}
export function platformOperator(db: Database, userId: string) {
  if (!db.users.some(u => u.id === userId && u.enabled && u.role === "admin")) throw new CompanyError("仅平台超管可以执行",403);
}
export function companyManager(db: Database, scope: EnterpriseScope) {
  const company = companyWorkspace(db, scope.workspaceId), member = activeMember(db, scope);
  if (!company || company.status !== "active" || !db.users.some(u => u.id === scope.userId && u.enabled) || member?.role !== "owner") throw new CompanyError("无权管理此公司",403);
  return company;
}
function audit(db: Database, scope: EnterpriseScope, action: string, targetId: string, details?: Record<string,unknown>) {
  db.auditLogs.push({id:uid("aud"),workspaceId:scope.workspaceId,actorUserId:scope.userId,action:`company.${action}`,targetType:"company",targetId,details,createdAt:new Date().toISOString()});
}
function account(db: Database, workspaceId: string, username: unknown, role: WorkspaceMember["role"]) {
  const name = text(username,"账号名称",64);
  if (db.users.some(u=>u.username.toLowerCase()===name.toLowerCase())) throw new CompanyError("账号名称已存在");
  const at = new Date().toISOString();
  // Only Key login is available for these users; no reusable password is issued.
  const user: User = {id:uid("usr"),username:name,passwordHash:hashPassword(crypto.randomBytes(32).toString("base64url")),role:"user",defaultWorkspaceId:workspaceId,enabled:true,createdAt:at};
  const member: WorkspaceMember = {id:uid("wsm"),workspaceId,userId:user.id,role,status:"active",permissions:{knowledgeConnectionIds:[],featureIds:[]},createdAt:at};
  db.users.push(user); db.workspaceMembers.push(member);
  return {user,member};
}
export function createCompany(db: Database, actor: string, input: Record<string,unknown>) {
  platformOperator(db,actor);
  const name=text(input.name,"公司名称"),agreementRef=text(input.agreementRef,"协议编号");
  const at=new Date().toISOString(),id=uid("wsp");
  const company: Workspace={id,name,slug:`company-${id.slice(-12)}`,kind:"company",revision:1,status:"active",company:{agreementRef,billing:"bank_transfer",allowPublicSharing:false},createdAt:at,updatedAt:at};
  // Validate account before adding the workspace; callers commit atomically.
  const owner=account(db,id,input.ownerUsername,"owner");
  db.workspaces.push(company);
  db.powerAccounts.push({id:uid("pwa"),workspaceId:id,userId:billingAccountUserId(db,id,owner.user.id),balanceMicros:0,reservedMicros:0,paidBalanceMicros:0,createdAt:at,updatedAt:at});
  audit(db,{workspaceId:id,userId:actor},"created",id);
  return {company,owner:{id:owner.user.id,username:owner.user.username}};
}
export function addCompanyMember(db: Database, scope: EnterpriseScope, input: Record<string,unknown>, platform = false) {
  if(platform) {platformOperator(db,scope.userId);if(companyWorkspace(db,scope.workspaceId)?.status!=="active")throw new CompanyError("公司不可用",404);} else companyManager(db,scope);
  if(input.role!==undefined&&!['owner','member'].includes(String(input.role)))throw new CompanyError("公司角色无效");
  const result=account(db,scope.workspaceId,input.username,input.role==='owner'?'owner':'member');
  audit(db,scope,"member.created",result.user.id);
  return {id:result.user.id,username:result.user.username};
}
function idList(value: unknown, label: string, allowed: (id: string)=>boolean) {
  if(!Array.isArray(value)||value.length>100||value.some(id=>typeof id!=="string"||!allowed(id)))throw new CompanyError(`${label}包含无效或其他公司的资源`);
  return [...new Set<string>(value)];
}
export function updateCompanyMember(db: Database, scope: EnterpriseScope, userId: string, input: Record<string,unknown>, platform=false) {
  const company=companyWorkspace(db,scope.workspaceId);
  if(platform)platformOperator(db,scope.userId);else companyManager(db,scope);
  if(!company)throw new CompanyError("公司不存在",404);
  if(input.revision!==company.revision)throw new CompanyError("公司配置已更新，请刷新后再操作",409);
  const member=db.workspaceMembers.find(m=>m.workspaceId===scope.workspaceId&&m.userId===userId);
  if(!member)throw new CompanyError("员工不存在",404);
  if(input.role!==undefined&&!['owner','member'].includes(String(input.role)))throw new CompanyError("角色无效");
  if(input.status!==undefined&&!['active','disabled'].includes(String(input.status)))throw new CompanyError("状态无效");
  const role=input.role===undefined?member.role:input.role as WorkspaceMember['role'];
  const status=input.status===undefined?(member.status??'active'):input.status as 'active'|'disabled';
  if(member.role==='owner'&&member.status!=='disabled'&&(role!=='owner'||status==='disabled')&&!db.workspaceMembers.some(m=>m.workspaceId===scope.workspaceId&&m.userId!==userId&&m.role==='owner'&&m.status!=='disabled'&&db.users.some(u=>u.id===m.userId&&u.enabled)))throw new CompanyError("必须保留至少一名有效公司管理员");
  if(input.permissions!==undefined){
    const p=input.permissions as Record<string,unknown>;
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['knowledgeConnectionIds','featureIds','powerLimitMicros'].includes(k)))throw new CompanyError("权限配置无效");
    const knowledgeConnectionIds=idList(p.knowledgeConnectionIds,"知识授权",id=>db.knowledgeConnections.some(c=>c.id===id&&c.workspaceId===scope.workspaceId&&c.status!=='revoked'));
    const featureIds=idList(p.featureIds,"功能授权",id=>db.settings.officialFeatures?.some(f=>f.id===id&&f.status==='approved'&&f.companyReleases?.some(r=>r.workspaceId===scope.workspaceId)&&(!f.workspaceId||f.workspaceId===scope.workspaceId))??false);
    if(p.powerLimitMicros!==undefined&&(!Number.isSafeInteger(p.powerLimitMicros)||Number(p.powerLimitMicros)<0))throw new CompanyError("员工累计额度必须为非负整数");
    member.permissions={knowledgeConnectionIds,featureIds,...(p.powerLimitMicros!==undefined?{powerLimitMicros:Number(p.powerLimitMicros)}:{})};
  }
  member.role=role;member.status=status;company.revision=(company.revision??0)+1;company.updatedAt=new Date().toISOString();
  if(status==='disabled'){
    const devices=db.oneKeyDevices.filter(d=>d.workspaceId===scope.workspaceId&&d.userId===userId);
    for(const d of devices){d.status='revoked';d.revokedAt=company.updatedAt;}
    for(const code of db.oneTimeLoginCodes)if(code.workspaceId===scope.workspaceId&&code.userId===userId&&!code.usedAt)code.usedAt=company.updatedAt;
    for(const task of db.executionTasks)if(task.workspaceId===scope.workspaceId&&task.userId===userId&&!['completed','failed','cancelled'].includes(task.status)){task.status='cancelled';task.updatedAt=company.updatedAt;task.completedAt=company.updatedAt;task.lastError='公司成员授权已撤销';}
  }
  audit(db,scope,"member.updated",userId,{role,status});
  return {revision:company.revision};
}
export function companySummary(db: Database, workspaceId: string) {
  const company=companyWorkspace(db,workspaceId);
  if(!company)throw new CompanyError("公司不存在",404);
  const payer=billingAccountUserId(db,workspaceId,''),balance=powerAccount(db,workspaceId,payer);
  return {company,members:db.workspaceMembers.filter(m=>m.workspaceId===workspaceId).map(m=>({userId:m.userId,username:db.users.find(u=>u.id===m.userId)?.username??'',role:m.role,status:m.status??'active',permissions:m.permissions??{knowledgeConnectionIds:[],featureIds:[]}})),devices:db.oneKeyDevices.filter(d=>d.workspaceId===workspaceId).map(d=>({id:d.id,userId:d.userId,serialNumber:d.serialNumber,status:d.status,lastUsedAt:d.lastUsedAt})),knowledge:db.knowledgeConnections.filter(c=>c.workspaceId===workspaceId).map(c=>({id:c.id,name:c.providerSpaceName||c.provider,status:c.status})),features:(db.settings.officialFeatures??[]).filter(f=>f.status==='approved'&&f.companyReleases?.some(r=>r.workspaceId===workspaceId)&&(!f.workspaceId||f.workspaceId===workspaceId)).map(f=>({id:f.id,name:f.history.find(v=>v.version===f.companyReleases?.find(r=>r.workspaceId===workspaceId)?.version)?.values.name??f.id,version:f.companyReleases?.find(r=>r.workspaceId===workspaceId)?.version})),billing:{mode:'bank_transfer',balanceMicros:balance?.balanceMicros??0,reservedMicros:balance?.reservedMicros??0,chargedMicros:db.modelUsageRecords.filter(r=>r.workspaceId===workspaceId).reduce((sum,r)=>sum+(r.chargedMicros??0),0)},payments:db.rechargeOrders.filter(o=>o.workspaceId===workspaceId&&o.corporatePayment).map(o=>({id:o.id,amountCny:o.amountCny,requestedMicros:o.requestedMicros,paidAt:o.paidAt,bankReference:o.corporatePayment!.bankReference}))};
}
export function recordBankTransfer(db: Database, scope: EnterpriseScope, input: Record<string,unknown>) {
  platformOperator(db,scope.userId);
  const company=companyWorkspace(db,scope.workspaceId);
  if(!company||company.status!=='active'||!company.company)throw new CompanyError("公司不可用",404);
  if(input.confirmed!==true)throw new CompanyError("请确认对公款项已实际到账");
  const bankReference=text(input.bankReference,"银行流水编号",160);
  const amountFen=Number(input.amountFen),amountMicros=Number(input.amountMicros);
  if(!Number.isSafeInteger(amountFen)||amountFen<=0||!Number.isSafeInteger(amountMicros)||amountMicros<=0)throw new CompanyError("到账金额和协议电力必须为正整数");
  const id=`bank_${crypto.createHash('sha256').update(bankReference).digest('hex').slice(0,40)}`;
  const previous=db.rechargeOrders.find(o=>o.id===id);
  if(previous){if(previous.workspaceId!==scope.workspaceId||previous.requestedMicros!==amountMicros||Math.round(previous.amountCny*100)!==amountFen)throw new CompanyError("此银行流水已按其他公司或金额入账",409);return{id,replay:true};}
  const payer=billingAccountUserId(db,scope.workspaceId,''),entry=creditPower(db,{workspaceId:scope.workspaceId,userId:payer,amountMicros,type:'recharge',title:`对公到账 · ${company.company.agreementRef}`,batchId:id,createdByUserId:scope.userId});
  db.rechargeOrders.push({id,workspaceId:scope.workspaceId,userId:payer,requestedMicros:amountMicros,amountCny:amountFen/100,cnyPerPowerSnapshot:amountFen*10000/amountMicros,status:'paid',createdAt:entry.createdAt,paidAt:entry.createdAt,corporatePayment:{agreementRef:company.company.agreementRef,bankReference,recordedBy:scope.userId}});
  audit(db,scope,'payment.recorded',id,{amountFen,amountMicros,ledgerId:entry.id});
  return{id,replay:false};
}
