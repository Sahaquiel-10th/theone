import type { Database } from './types.js';
import { encryptCredential,decryptCredential } from './knowledge/credentialCipher.js';
import { featureToolEndpoint, type FeatureToolChoice } from './featureTools.js';
import { uid } from './security.js';

export type FeatureCredential={workspaceId:string;userId:string;endpoint:string;auth:'bearer'|'api_key';encryptedSecret:string;revision:string;updatedAt:string};
export type CredentialBinding=Pick<FeatureCredential,'endpoint'|'auth'|'revision'>;
type Scope={workspaceId:string;userId:string};
const context=(s:Scope,endpoint:string,auth:string)=>JSON.stringify(['feature-tool',s.workspaceId,s.userId,endpoint,auth]);
export function credentialOwner(db:Database,s:Scope){
  const user=db.users.find(u=>u.id===s.userId&&u.enabled);
  if(!user||!db.workspaceMembers.some(m=>m.status !== "disabled" && m.workspaceId===s.workspaceId&&m.userId===s.userId)||!db.workspaces.some(w=>w.id===s.workspaceId&&w.status==='active'))throw new Error('无权访问工具凭证');
  return user;
}
export function credentialStatuses(db:Database,s:Scope){return (credentialOwner(db,s).featureCredentials??[]).filter(c=>c.workspaceId===s.workspaceId&&c.userId===s.userId).map(c=>({endpoint:c.endpoint,auth:c.auth,revision:c.revision,updatedAt:c.updatedAt}));}
export function setFeatureCredential(db:Database,s:Scope,endpoint:string,auth:'bearer'|'api_key',secret:unknown){
  const user=credentialOwner(db,s);
  if(!['bearer','api_key'].includes(auth)||typeof secret!=='string'||secret.length<8||secret.length>8000||!/^[\x21-\x7e]+$/.test(secret))throw new Error('凭证应为 8–8000 位可见字符，不含空格或换行');
  const previous=user.featureCredentials??[];
  const remaining=previous.filter(c=>!(c.workspaceId===s.workspaceId&&c.userId===s.userId&&c.endpoint===endpoint&&c.auth===auth));
  if(remaining.length>=30)throw new Error('工具凭证已达 30 项上限');
  user.featureCredentials=[...remaining,{...s,endpoint,auth,encryptedSecret:encryptCredential(secret,context(s,endpoint,auth)),revision:uid('fcred'),updatedAt:new Date().toISOString()}];
}
export function revokeFeatureCredential(db:Database,s:Scope,endpoint:string,auth:string){const user=credentialOwner(db,s);user.featureCredentials=(user.featureCredentials??[]).filter(c=>!(c.workspaceId===s.workspaceId&&c.userId===s.userId&&c.endpoint===endpoint&&c.auth===auth));}
export function credentialBindings(db:Database,s:Scope,tools:FeatureToolChoice[]):CredentialBinding[]{
  const statuses=credentialStatuses(db,s);
  return tools.filter(t=>t.auth).map(t=>{const endpoint=featureToolEndpoint(t),c=statuses.find(c=>c.endpoint===endpoint&&c.auth===t.auth);if(!c)throw new Error('请先配置本人的外部工具凭证');return{endpoint,auth:c.auth,revision:c.revision};});
}
export function verifyCredentialBindings(db:Database,s:Scope,bindings:CredentialBinding[]){const statuses=credentialStatuses(db,s);if(bindings.some(b=>!statuses.some(c=>c.endpoint===b.endpoint&&c.auth===b.auth&&c.revision===b.revision)))throw new Error('工具凭证已更换或撤销，请重新发起任务');}
export function toolCredential(db:Database,s:Scope,endpoint:string,auth?:'bearer'|'api_key'):{headers:Record<string,string>;secret?:string}{
  if(!auth)return{headers:{}};
  const c=credentialOwner(db,s).featureCredentials?.find(c=>c.workspaceId===s.workspaceId&&c.userId===s.userId&&c.endpoint===endpoint&&c.auth===auth);
  if(!c)throw new Error('请先配置本人的外部工具凭证');
  const secret=decryptCredential(c.encryptedSecret,context(s,endpoint,auth));
  return{headers:auth==='bearer'?{Authorization:`Bearer ${secret}`}:{'X-API-Key':secret},secret};
}
export function redactToolSecret(value:unknown,secret?:string):unknown{
  if(!secret)return value;
  if(typeof value==='string')return value.split(secret).join('[redacted]');
  if(Array.isArray(value))return value.map(v=>redactToolSecret(v,secret));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k.split(secret).join('[redacted]'),redactToolSecret(v,secret)]));
  return value;
}
