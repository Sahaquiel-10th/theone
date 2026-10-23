import type { Database } from './types.js';
import type { AvatarFeatureGrant } from './publicAvatarFeatures.js';
import { validateAvatarFeatureGrants } from './publicAvatarFeatures.js';
import { SharingError } from './publicSharing.js';

export type PublicAvatarService = {
  mode: 'consultation' | 'knowledge';
  welcome: string;
  starterQuestions: string[];
  method: string;
  features: AvatarFeatureGrant[];
};

export function avatarAuthorName(db: Database, scope: {workspaceId:string;userId:string}) {
  const owner=db.users.find(u=>u.id===scope.userId&&u.enabled);
  if(!owner)throw new SharingError('作者账号不可用',403);
  return (owner.profile?.workspaceId===scope.workspaceId&&owner.profile.displayName.trim()
    ?owner.profile.displayName.trim():owner.username||'ONE 用户').slice(0,80);
}

export function validatePublicAvatarService(db:Database,scope:{workspaceId:string;userId:string},raw:unknown):PublicAvatarService|undefined {
  if(raw===undefined)return;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new SharingError('请检查分身服务配置');
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['mode','welcome','starterQuestions','method','features'].includes(k))||!['consultation','knowledge'].includes(String(v.mode)))throw new SharingError('请选择分身服务方式');
  const text=(key:string,max:number)=>{const s=v[key];if(typeof s!=='string'||s.length>max)throw new SharingError('分身介绍或方法资料过长');return s.trim();};
  if(!Array.isArray(v.starterQuestions)||v.starterQuestions.length>4||v.starterQuestions.some(s=>typeof s!=='string'||!s.trim()||s.length>200))throw new SharingError('最多填写 4 个开场问题，每个不超过 200 字');
  try{return {mode:v.mode as PublicAvatarService['mode'],welcome:text('welcome',500),method:text('method',12000),starterQuestions:[...new Set((v.starterQuestions as string[]).map(s=>s.trim()))],features:validateAvatarFeatureGrants(db,scope,v.features??[])};}
  catch(e){if(e instanceof SharingError)throw e;throw new SharingError(e instanceof Error?e.message:'功能配置不可用');}
}

/** Only visitor-facing copy. Method material, feature IDs and prompts stay private. */
export function publicAvatarService(service?:PublicAvatarService) {
  return service?{mode:service.mode,welcome:service.welcome,starterQuestions:service.starterQuestions}:undefined;
}
