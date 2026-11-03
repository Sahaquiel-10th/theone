/** The workspace's material is presentation only. Never use it to authorize,
 * lock, cancel, restart or classify the success of a local operation. */
export type AppearanceScope = {userId:string;workspaceId:string};
export type AppearanceTask = AppearanceScope & {
  id:string;conversationId:string;status:string;reportRound?:number;updatedAt:string;
  finalResponse?:string;resultDeliveryPending?:boolean;requiresExecutionCheck?:boolean;
};
type HeldAppearance = {id:string;conversationId:string;round:number;updatedAt:string;phase:'running'|'checking'|'waiting'|'settled'};
export type ExecutionAppearance = {scope:string;held:HeldAppearance[];removedConversationIds?:string[]};
const liveStatuses=new Set(['queued','selecting_target','running']);
const scopeKey=(scope:AppearanceScope)=>JSON.stringify([scope.userId,scope.workspaceId]);
const round=(task:AppearanceTask)=>{const value=task.reportRound??0;return Number.isSafeInteger(value)&&value>=0?value:0;};
const owned=(task:AppearanceTask,scope:AppearanceScope)=>task.userId===scope.userId&&task.workspaceId===scope.workspaceId;

/** A direct hand-back to this person, not an example in an article or a code
 * sample. This deliberately affects illumination only, never task success. */
export function executionWaitsForInput(response?:string) {
  const plain=(response??'').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .replace(/^\s*>.*$/gm,'').replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/g,'');
  // A direct request must block an executor action that has yet to happen.
  // User instructions in a delivered app or requests to review an already
  // finished article are not an active local hand-back. Keep a few closing
  // paragraphs together because the request and future action may be separate.
  const ending=plain.trim().split(/\n\s*\n/).slice(-3).join('\n\n').trim();
  if(!ending||ending.length>1000)return false;
  const request=/(?:^|[。！？!?；;]\s*|\n\s*)(?:[-*]\s*)?(?:(?:请(?:你)?|麻烦(?:你)?|需要你|等你)(?:先|再)?|你)(?:确认|选择|选|补充|提供|告诉我|给我|回复)(?:一下)?/u.exec(ending);
  if(!request)return false;
  const following=ending.slice(request.index+request[0].length);
  if(/(?:如果|若|如)(?:你)?(?:还)?(?:需要|希望)|有需要(?:的话)?|是否(?:还)?需要(?:我)?(?:继续|进一步)/u.test(following))return false;
  if(/(?:我(?:会|再|将|才会|才能|才|就|可以)?|才能)[，,\s]*(?:再|就|会)?(?:继续|开始|执行|修改|处理|创建|生成|写入|保存)/u.test(following))return true;
  // Executors also hand back terse prerequisites without repeating 'I will
  // continue': a file name, target directory, colour or local permission.
  // These are inputs to the current local operation, not arbitrary questions.
  const brief=following.split(/[。！？!?；;\n]/,1)[0].trim();
  if(!brief||brief.length>120||/文中|正文|文稿|文章|方案|数据|结论|事实|表述|引用|措辞|内容/u.test(brief))return false;
  if(/使用说明|操作说明|使用方法|下一步使用|如何使用/u.test(ending))return false;
  const delivered=/(?:已|已经)(?:全部)?(?:完成|写好|交付|保存)|已(?:修改|创建|写入)[^。\n]{0,80}(?:回读|验证|核对)|(?:文档|文件|文章|方案|报告|网页)(?:已经|已)(?:生成|创建|导出|制作|修改)/u;
  if(delivered.test(ending))return false;
  return /文件(?:名|名称)|保存(?:路径|位置)|(?:目标|项目|工作|输出)?(?:文件夹|目录)|背景(?:色)?|颜色|(?:橙|蓝|红|绿|紫|黄|黑|白|粉|灰|冷|暖|浅|深)色|#[0-9a-fA-F]{3,8}\b|授权|权限|允许.{0,16}(?:修改|写入|创建|访问|读取|执行)/u.test(brief);

}

function phase(task:AppearanceTask):HeldAppearance['phase'] {
  if(task.resultDeliveryPending||task.requiresExecutionCheck)return 'checking';
  if(liveStatuses.has(task.status))return 'running';
  if(task.status==='completed'&&executionWaitsForInput(task.finalResponse))return 'waiting';
  return 'settled';
}
export function initialExecutionAppearance(scope:AppearanceScope):ExecutionAppearance {return {scope:scopeKey(scope),held:[]};}

/** Only observing an accepted live local task acquires the material. A missing
 * snapshot is not completion; a late older round cannot settle a newer round. */
export function advanceExecutionAppearance(previous:ExecutionAppearance,scope:AppearanceScope,tasks:AppearanceTask[]):ExecutionAppearance {
  const base=previous.scope===scopeKey(scope)?previous:initialExecutionAppearance(scope);
  const held=new Map(base.held.map(item=>[item.id,item]));
  let changed=base!==previous;
  const latest=new Map<string,AppearanceTask>();
  for(const task of tasks){
    if(!owned(task,scope)||base.removedConversationIds?.includes(task.conversationId))continue;
    const before=latest.get(task.id);
    if(!before||round(task)>round(before)||round(task)===round(before)&&task.updatedAt>=before.updatedAt)latest.set(task.id,task);
  }
  for(const task of latest.values()){
    if(liveStatuses.has(task.status)){
      // A continued goal may receive a new accepted execution ID. It replaces
      // only an older, already-stopped waiting view in this same conversation.
      for(const before of held.values())if(before.id!==task.id&&before.conversationId===task.conversationId&&before.phase==='waiting'&&task.updatedAt>=before.updatedAt){held.set(before.id,{...before,phase:'settled'});changed=true;}
    }
    const before=held.get(task.id),nextRound=round(task);
    if(before&&(nextRound<before.round||nextRound===before.round&&task.updatedAt<before.updatedAt))continue;
    if(!before&&!liveStatuses.has(task.status))continue;
    // Settled/dismissed history cannot reacquire from a terminal answer. A real
    // next live round of this same task can acquire again.
    const nextPhase=before?.phase==='settled'&&!liveStatuses.has(task.status)?'settled':phase(task);
    if(before&&before.conversationId!==task.conversationId)continue;
    const next:HeldAppearance={id:task.id,conversationId:task.conversationId,round:nextRound,updatedAt:task.updatedAt,phase:nextPhase};
    if(!before||before.round!==next.round||before.updatedAt!==next.updatedAt||before.phase!==next.phase){held.set(task.id,next);changed=true;}
  }
  return changed?{...base,held:[...held.values()]}:base;
}
export function executionAppearanceActive(state:ExecutionAppearance) {return state.held.some(item=>item.phase!=='settled');}
export function executionAppearanceWaiting(state:ExecutionAppearance) {return state.held.filter(item=>item.phase==='waiting').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];}

/** Ending an already-stopped waiting view does not fabricate a server cancel.
 * The exact current round must still be settled and awaiting this person's input. */
export function endExecutionAppearanceWait(state:ExecutionAppearance,scope:AppearanceScope,task:AppearanceTask):ExecutionAppearance {
  if(state.scope!==scopeKey(scope)||!owned(task,scope)||phase(task)!=='waiting')return state;
  const current=state.held.find(item=>item.id===task.id);
  if(!current||current.phase!=='waiting'||current.round!==round(task)||task.updatedAt<current.updatedAt)return state;
  return {...state,held:state.held.map(item=>item===current?{...item,phase:'settled'}:item)};
}

/** Called only after a successful server deletion. Absence from a poll never
 * creates this tombstone; a late pre-deletion response cannot relight the view. */
export function forgetExecutionAppearanceConversation(state:ExecutionAppearance,scope:AppearanceScope,conversationId:string):ExecutionAppearance {
  if(state.scope!==scopeKey(scope)||!conversationId||state.removedConversationIds?.includes(conversationId))return state;
  return {...state,held:state.held.filter(item=>item.conversationId!==conversationId),removedConversationIds:[...(state.removedConversationIds??[]),conversationId]};
}

type AppearanceStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export const executionAppearanceStorageKey=(scope:AppearanceScope)=>`one.local-appearance.v1:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.workspaceId)}`;
const exactKeys=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);

/** Restore only metadata for a lifecycle this tab already observed. Storage is
 * an optional visual hint and can never restore an execution or authorization. */
export function readExecutionAppearance(storage:AppearanceStorage|undefined,scope:AppearanceScope):ExecutionAppearance {
  const empty=initialExecutionAppearance(scope);
  if(!storage)return empty;
  try{
    const raw=storage.getItem(executionAppearanceStorageKey(scope));if(!raw||raw.length>24_000)return empty;
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object'||Array.isArray(value))return empty;
    const data=value as Record<string,unknown>;
    if(!exactKeys(data,['version','userId','workspaceId','held'])||data.version!==1||data.userId!==scope.userId||data.workspaceId!==scope.workspaceId||!Array.isArray(data.held)||data.held.length>50)return empty;
    const held:HeldAppearance[]=[],ids=new Set<string>();
    for(const item of data.held){
      if(!item||typeof item!=='object'||Array.isArray(item)||!exactKeys(item,['id','conversationId','round','updatedAt','phase']))return empty;
      const row=item as Record<string,unknown>;
      if(!identifier(row.id)||!identifier(row.conversationId)||ids.has(row.id)||!Number.isSafeInteger(row.round)||Number(row.round)<0||typeof row.updatedAt!=='string'||row.updatedAt.length>32||!Number.isFinite(Date.parse(row.updatedAt))||new Date(row.updatedAt).toISOString()!==row.updatedAt||!['running','checking','waiting'].includes(String(row.phase)))return empty;
      ids.add(row.id);held.push(row as HeldAppearance);
    }
    return {scope:empty.scope,held};
  }catch{return empty;}
}
export function writeExecutionAppearance(storage:AppearanceStorage|undefined,scope:AppearanceScope,state:ExecutionAppearance) {
  if(!storage||state.scope!==scopeKey(scope))return;
  try{
    const held=state.held.filter(item=>item.phase!=='settled').slice(-50);
    if(!held.length){storage.removeItem(executionAppearanceStorageKey(scope));return;}
    storage.setItem(executionAppearanceStorageKey(scope),JSON.stringify({version:1,userId:scope.userId,workspaceId:scope.workspaceId,held}));
  }catch{/* Storage denial never changes the local task or its material in this render. */}
}
