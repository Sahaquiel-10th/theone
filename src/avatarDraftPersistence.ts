import type {AvatarBusinessConfig,AvatarServiceConfig} from './AvatarService';
import type {PublicationDraft} from './sharingWorkspaceState';

/** This is a tab-local recovery copy, not a saved or published server draft. */
export type AvatarDraftScope={userId:string;workspaceId:string};
export type AvatarDraftTarget={kind:'new'}|{kind:'existing';ownerId:string;version:number};
export type AvatarDraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type AvatarDraftOptions={storage?:AvatarDraftStorage|null;now?:number};
export type AvatarDraftRestore=
  |{status:'restored';draft:PublicationDraft;savedAt:number}
  |{status:'conflict';baseVersion:number;savedAt:number}
  |{status:'missing'|'expired'|'invalid'|'unavailable'};
export type AvatarDraftPending=
  |{status:'pending';baseVersion:number;savedAt:number}
  |{status:'missing'|'expired'|'invalid'|'unavailable'};
export const AVATAR_DRAFT_TTL_MS=7*24*60*60*1000;
const PREFIX='one.avatar-draft.v1:';
const PENDING_PREFIX='one.avatar-draft-pending.v1:';
const MAX_JSON_LENGTH=128*1024;

function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid draft object');
  return value as Record<string,unknown>;
}
function text(value:unknown,max:number):string{
  if(typeof value!=='string'||value.length>max)throw new Error('Invalid draft text');
  return value;
}
function bool(value:unknown):boolean{if(typeof value!=='boolean')throw new Error('Invalid draft boolean');return value;}
function number(value:unknown):number{
  // Preserve incomplete form values such as zero or a negative amount. The
  // server still validates publishable values; this helper grants no rights.
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e9)throw new Error('Invalid draft number');
  return value;
}
function integer(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Invalid draft integer');return value;}
function list<T>(value:unknown,max:number,read:(value:unknown)=>T):T[]{
  if(!Array.isArray(value)||value.length>max)throw new Error('Invalid draft list');
  return value.map(read);
}
function choice<T extends string>(value:unknown,values:readonly T[]):T{
  if(typeof value!=='string'||!values.includes(value as T))throw new Error('Invalid draft choice');
  return value as T;
}
function service(value:unknown):AvatarServiceConfig{
  const input=object(value);
  return {mode:choice(input.mode,['consultation','knowledge']),welcome:text(input.welcome,500),starterQuestions:list(input.starterQuestions,4,item=>text(item,160)),method:text(input.method,12000),features:list(input.features,4,item=>{
    const feature=object(item);return {featureId:text(feature.featureId,256),releaseId:text(feature.releaseId,256),when:text(feature.when,500),workflow:text(feature.workflow,1800)};
  })};
}
function business(value:unknown):AvatarBusinessConfig{
  const input=object(value);
  return {access:choice(input.access,['open','entitlement']),plans:list(input.plans,6,item=>{
    const plan=object(item);return {...(plan.id===undefined?{}:{id:text(plan.id,256)}),name:text(plan.name,60),kind:choice(plan.kind,['monthly','credits']),quota:number(plan.quota),priceCny:number(plan.priceCny),validDays:number(plan.validDays),status:choice(plan.status,['active','archived'])};
  }),intakeFields:list(input.intakeFields,6,item=>{
    const field=object(item);return {id:text(field.id,256),label:text(field.label,40),type:choice(field.type,['text','number','email','phone']),...(field.required===undefined?{}:{required:bool(field.required)})};
  })};
}
/** Strict allow-list: never serialize arbitrary owner records, debug replies,
 * credentials, retrieved knowledge, receipts or server publication metadata. */
function snapshot(value:unknown):PublicationDraft{
  const input=object(value);
  return {name:text(input.name,60),description:text(input.description,300),prompt:text(input.prompt,12000),modelId:text(input.modelId,256),sourceIds:list(input.sourceIds,50,item=>text(item,256)),attachments:bool(input.attachments),budget:number(input.budget),perRun:number(input.perRun),days:number(input.days),confirmed:false,visitorPercent:number(input.visitorPercent),requireLogin:bool(input.requireLogin),allowedUsernames:list(input.allowedUsernames,200,item=>text(item,256)),...(input.service===undefined?{}:{service:service(input.service)}),...(input.serviceBusiness===undefined?{}:{serviceBusiness:business(input.serviceBusiness)})};
}
function id(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);}
function address(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget){
  if(!scope||!id(scope.userId)||!id(scope.workspaceId))return undefined;
  if(target.kind!=='new'&&(target.kind!=='existing'||!id(target.ownerId)||!Number.isSafeInteger(target.version)||target.version<1))return undefined;
  const owner=target.kind==='new'?'new':target.ownerId;
  // A JSON tuple prevents separator collisions in externally supplied IDs.
  const identity=[scope.workspaceId,scope.userId,target.kind,owner];
  return {key:PREFIX+encodeURIComponent(JSON.stringify(identity)),identity,baseVersion:target.kind==='new'?0:target.version};
}
function storage(options:AvatarDraftOptions):AvatarDraftStorage|undefined{
  if('storage' in options)return options.storage??undefined;
  try{return globalThis.sessionStorage;}catch{return undefined;}
}
function discard(store:AvatarDraftStorage,key:string){try{store.removeItem(key);}catch{/* Browser storage is optional. */}}
function clock(options:AvatarDraftOptions){return options.now??Date.now();}
function storedVersion(raw:string|null,identity:string[]):number|undefined{
  if(!raw||raw.length>MAX_JSON_LENGTH)return undefined;
  try{
    const entry=object(JSON.parse(raw));
    return entry.format===1&&JSON.stringify(entry.identity)===JSON.stringify(identity)&&Number.isSafeInteger(entry.baseVersion)?entry.baseVersion as number:undefined;
  }catch{return undefined;}
}

/** Fingerprints ignore consent, which must be obtained again after restoring. */
export function avatarDraftFingerprint(draft:PublicationDraft):string{
  try{return JSON.stringify(snapshot(draft));}catch{return '';}
}
export function saveAvatarDraft(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,draft:PublicationDraft,options:AvatarDraftOptions={}):boolean{
  const place=address(scope,target),store=storage(options),now=clock(options);
  if(!place||!store||!Number.isSafeInteger(now)||now<0)return false;
  try{
    const previous=storedVersion(store.getItem(place.key),place.identity);
    if(target.kind==='existing'&&previous!==undefined&&previous>place.baseVersion)return false;
    const serialized=JSON.stringify({format:1,identity:place.identity,baseVersion:place.baseVersion,savedAt:now,expiresAt:now+AVATAR_DRAFT_TTL_MS,draft:snapshot(draft)});
    if(serialized.length>MAX_JSON_LENGTH)return false;
    store.setItem(place.key,serialized);return true;
  }catch{return false;}
}
export function readAvatarDraft(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,options:AvatarDraftOptions={}):AvatarDraftRestore{
  const place=address(scope,target),store=storage(options),now=clock(options);
  if(!place||!store||!Number.isSafeInteger(now)||now<0)return {status:'unavailable'};
  let raw:string|null;
  try{raw=store.getItem(place.key);}catch{return {status:'unavailable'};}
  if(raw===null)return {status:'missing'};
  try{
    if(raw.length>MAX_JSON_LENGTH)throw new Error('Oversized stored draft');
    const entry=object(JSON.parse(raw));
    if(entry.format!==1||JSON.stringify(entry.identity)!==JSON.stringify(place.identity))throw new Error('Wrong stored draft scope');
    const savedAt=integer(entry.savedAt),expiresAt=integer(entry.expiresAt),baseVersion=integer(entry.baseVersion);
    if(savedAt<0||expiresAt!==savedAt+AVATAR_DRAFT_TTL_MS||savedAt>now+5*60*1000||!Number.isSafeInteger(baseVersion)||baseVersion<0||(target.kind==='new'?baseVersion!==0:baseVersion<1))throw new Error('Invalid stored draft metadata');
    if(expiresAt<=now){discard(store,place.key);return {status:'expired'};}
    const draft=snapshot(entry.draft);
    if(baseVersion!==place.baseVersion)return {status:'conflict',baseVersion,savedAt};
    return {status:'restored',draft,savedAt};
  }catch{discard(store,place.key);return {status:'invalid'};}
}
/** Successful save/discard clears exactly this identity and owner, never other
 * accounts, workspaces, avatars or in-flight execution protection. */
export function clearAvatarDraft(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,options:AvatarDraftOptions={}):boolean{
  const place=address(scope,target),store=storage(options);if(!place||!store)return false;
  try{
    const previous=storedVersion(store.getItem(place.key),place.identity);
    if(target.kind==='existing'&&previous!==undefined&&previous!==place.baseVersion)return false;
    store.removeItem(place.key);return true;
  }catch{return false;}
}

/** The pending marker is deliberately separate from author text, so edits,
 * discard/recovery and refresh cannot accidentally clear an unknown write. */
function pendingAddress(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget){
  const place=address(scope,target);return place?{...place,key:PENDING_PREFIX+place.key.slice(PREFIX.length)}:undefined;
}
/** A different current server version is not proof that an unknown submission
 * finished. Keep that marker visible with its original baseVersion until its
 * exact operation is checked; never silently unlock on version mismatch. */
export function readAvatarDraftPending(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,options:AvatarDraftOptions={}):AvatarDraftPending{
  const place=pendingAddress(scope,target),store=storage(options),now=clock(options);
  if(!place||!store||!Number.isSafeInteger(now)||now<0)return {status:'unavailable'};
  let raw:string|null;
  try{raw=store.getItem(place.key);}catch{return {status:'unavailable'};}
  if(raw===null)return {status:'missing'};
  try{
    if(raw.length>4096)throw new Error('Oversized pending marker');
    const entry=object(JSON.parse(raw));
    if(entry.format!==1||entry.pending!==true||JSON.stringify(entry.identity)!==JSON.stringify(place.identity))throw new Error('Wrong pending marker scope');
    const baseVersion=integer(entry.baseVersion),savedAt=integer(entry.savedAt),expiresAt=integer(entry.expiresAt);
    if((target.kind==='new'?baseVersion!==0:baseVersion<1)||expiresAt!==savedAt+AVATAR_DRAFT_TTL_MS||savedAt>now+5*60*1000)throw new Error('Invalid pending marker metadata');
    if(expiresAt<=now){discard(store,place.key);return {status:'expired'};}
    return {status:'pending',baseVersion,savedAt};
  }catch{discard(store,place.key);return {status:'invalid'};}
}
/** Call before starting the write. Same-version calls preserve the first
 * timestamp; an unresolved marker from another version cannot be overwritten. */
export function markAvatarDraftPending(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,options:AvatarDraftOptions={}):boolean{
  const place=pendingAddress(scope,target),store=storage(options),now=clock(options);
  if(!place||!store||!Number.isSafeInteger(now)||now<0)return false;
  const previous=readAvatarDraftPending(scope,target,options);
  if(previous.status==='unavailable')return false;
  if(previous.status==='pending')return previous.baseVersion===place.baseVersion;
  try{
    store.setItem(place.key,JSON.stringify({format:1,identity:place.identity,pending:true,baseVersion:place.baseVersion,savedAt:now,expiresAt:now+AVATAR_DRAFT_TTL_MS}));
    return true;
  }catch{return false;}
}
/** Only a confirmed result, definite rejection, or an explicit checked discard
 * may call this. Old receipts cannot clear a newer version's pending marker. */
export function clearAvatarDraftPending(scope:AvatarDraftScope|undefined,target:AvatarDraftTarget,options:AvatarDraftOptions={}):boolean{
  const place=pendingAddress(scope,target),store=storage(options);if(!place||!store)return false;
  const previous=readAvatarDraftPending(scope,target,options);
  if(previous.status==='unavailable'||previous.status==='pending'&&previous.baseVersion!==place.baseVersion)return false;
  try{store.removeItem(place.key);return true;}catch{return false;}
}
