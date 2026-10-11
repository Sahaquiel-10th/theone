import manifest from '../skills-library/one/manifest.json' with {type:'json'};
import type { Database } from './types.js';
import { featureValues, updateOfficialFeature, FeatureConfigError } from './officialFeatures.js';
export const oneSkillLibrary = manifest.map(item=>({...item,values:featureValues(item.values)}));
/** Add missing first-party drafts only. Existing user edits and approved versions are preserved. */
export function installOneSkillLibrary(db:Database,actor:string,selection:string[]=oneSkillLibrary.map(s=>s.id),modelIds:{text?:string;image?:string}={}){
  if(!db.users.some(u=>u.id===actor&&u.enabled&&u.role==='admin'))throw new FeatureConfigError('无权安装功能',403);
  if(!Array.isArray(selection)||!selection.length||selection.length>24||new Set(selection).size!==selection.length||selection.some(id=>!oneSkillLibrary.some(s=>s.id===id)))throw new FeatureConfigError('请选择有效的内置功能');
  const added:string[]=[],existing:string[]=[];
  for(const id of selection){
    if(db.settings.officialFeatures?.some(f=>f.id===id)){existing.push(id);continue;}
    const skill=oneSkillLibrary.find(s=>s.id===id)!;
    const kind=skill.values.experience?.mode==='image'?'image':'chat';
    const requested=kind==='image'?modelIds.image:modelIds.text;
    const model=requested?db.models.find(m=>m.id===requested&&m.enabled&&m.kind===kind&&m.apiKey):db.models.find(m=>m.enabled&&m.kind===kind&&m.apiKey&&m.isDefault)??db.models.find(m=>m.enabled&&m.kind===kind&&m.apiKey);
    if(requested&&!model)throw new FeatureConfigError('所选模型不可用');
    updateOfficialFeature(db.settings,id,{action:'save',revision:0,values:{...skill.values,...(model?{modelId:model.id}:{})}},actor,new Date().toISOString());added.push(id);
  }
  return {added,existing};
}

/** First-party first edition: install once, open only to enabled administrators for tuning.
 * Never overwrite an existing definition/release or expand ordinary user access. */
export function bootstrapOneSkills(db:Database){
  const admins=db.users.filter(u=>u.enabled&&u.role==='admin');if(!admins.length)return {added:[] as string[],opened:[] as string[]};
  const missing=oneSkillLibrary.filter(s=>!db.settings.officialFeatures?.some(f=>f.id===s.id)).map(s=>s.id);if(!missing.length)return {added:[] as string[],opened:[] as string[]};
  // Capacity exhaustion must never prevent Key/login/chat from starting.
  if((db.settings.officialFeatures?.length??0)+missing.length>100)return {added:[] as string[],opened:[] as string[]};
  const installed=installOneSkillLibrary(db,admins[0].id,missing),opened:string[]=[];
  for(const id of installed.added){
    const r=db.settings.officialFeatures!.find(f=>f.id===id)!;if(!r.draft.modelId)continue;
    updateOfficialFeature(db.settings,id,{action:'approve',revision:r.revision,confirmed:true,evidence:'ONE 自编首版。配置、选项、计算边界、文件隔离与合成调用流程已通过自动化验证；尚未完成每个真实模型及行业内容验收。先向管理员开放调试。'},admins[0].id,new Date().toISOString());
    const record=db.settings.officialFeatures!.find(f=>f.id===id)!;
    record.release={id:`builtin-${id}-v1`,version:record.current!.version,userIds:admins.slice(0,100).map(u=>u.id),publishedAt:new Date().toISOString(),publishedBy:admins[0].id};record.revision++;opened.push(id);
  }
  db.auditLogs.push({id:`skills-bootstrap-${Date.now()}`,actorUserId:admins[0].id,action:'admin.one_skills.bootstrap',targetType:'official_feature',targetId:'one-library-v1',details:{added:installed.added.length,opened:opened.length,scope:'administrators'},createdAt:new Date().toISOString()});
  return {...installed,opened};
}
