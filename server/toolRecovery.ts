/** Reviewed diagnostics, not provider exception text or model assertions. */
export type ToolRecoveryDiagnostic={version:1;kind:'system_parameters'|'missing_input'|'configuration'|'effect_unknown';code:'arguments_invalid'|'artifact_validation_failed'|'template_required'|'template_ambiguous'|'storage_unconfigured'|'effect_unconfirmed';repair:'available'|'exhausted'|'not_applicable';field?:'template_file';fields?:string[]};
const kinds:Record<ToolRecoveryDiagnostic['code'],ToolRecoveryDiagnostic['kind']>={arguments_invalid:'system_parameters',artifact_validation_failed:'system_parameters',template_required:'missing_input',template_ambiguous:'missing_input',storage_unconfigured:'configuration',effect_unconfirmed:'effect_unknown'};
const faults=new WeakMap<object,ToolRecoveryDiagnostic>();
export function parseToolRecoveryDiagnostic(value:unknown):ToolRecoveryDiagnostic|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(key=>!['version','kind','code','repair','field','fields'].includes(key))||v.version!==1||typeof v.code!=='string'||!Object.hasOwn(kinds,v.code)||kinds[v.code as ToolRecoveryDiagnostic['code']]!==v.kind||!['available','exhausted','not_applicable'].includes(String(v.repair)))return;
 if(v.kind==='system_parameters'&&v.repair==='not_applicable'||v.kind!=='system_parameters'&&v.repair!=='not_applicable')return;
 if(v.field!==undefined&&v.field!=='template_file'||v.kind==='missing_input'&&v.field!=='template_file'||v.kind!=='missing_input'&&v.field!==undefined)return;
 if(v.fields!==undefined&&(!Array.isArray(v.fields)||v.fields.length>5||v.fields.some(field=>typeof field!=='string'||field.length>100||!/^[A-Za-z][A-Za-z0-9_]*(?:\[\d{1,4}\]|\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field))))return;
 return {version:1,kind:v.kind as ToolRecoveryDiagnostic['kind'],code:v.code as ToolRecoveryDiagnostic['code'],repair:v.repair as ToolRecoveryDiagnostic['repair'],...(v.field?{field:'template_file' as const}:{}),...(v.fields?{fields:[...v.fields as string[]]}:{})};
}
export function toolRecoveryMessage(fault:ToolRecoveryDiagnostic){
 return fault.code==='template_required'?'还缺这次要填写的 XLSX 模板。请上传模板，我会沿用原要求接着处理。'
  :fault.code==='template_ambiguous'?'这次有多份可用模板。请选定要填写的那一份，我再继续。'
  :fault.code==='storage_unconfigured'?'文件存储暂时没有就绪，这份文件还没有保存。需要管理员恢复文件存储；你不用修改内容或重新选功能。'
  :fault.code==='effect_unconfirmed'?'这一步可能已经产生文件，结果仍需核对。已有成果保留，不会重复生成或保存。'
  :fault.repair==='exhausted'?'这份文件的生成格式还没修好，系统已停止继续尝试。原要求和已有成果保留；你不用猜参数或重新选功能。'
  :'系统正在纠正这一步的生成格式，已有要求和成果会保留。';
}
export function attachToolRecoveryDiagnostic<T extends object>(error:T,value:ToolRecoveryDiagnostic):T{
 const safe=parseToolRecoveryDiagnostic(value);if(!safe)throw Error('Invalid tool recovery diagnostic');faults.set(error,safe);return error;
}
export function toolRecoveryDiagnostic(error:unknown){const value=error&&typeof error==='object'?faults.get(error):undefined;return value?parseToolRecoveryDiagnostic(value):undefined;}
export class ToolRecoveryError extends Error{constructor(value:ToolRecoveryDiagnostic){const fault=parseToolRecoveryDiagnostic(value);if(!fault)throw Error('Invalid tool recovery diagnostic');super(toolRecoveryMessage(fault));this.name='ToolRecoveryError';attachToolRecoveryDiagnostic(this,fault);}}
export const systemParameterFault=(code:'arguments_invalid'|'artifact_validation_failed'='arguments_invalid',repair:'available'|'exhausted'='available',fields?:string[]):ToolRecoveryDiagnostic=>({version:1,kind:'system_parameters',code,repair,...(fields?{fields}: {})});

export const argumentRepairControlTool='__argument_repair_budget';
export type ArgumentRepairBudget={version:1;used:number;maxAttempts:2;fingerprints:string[]};
export function parseArgumentRepairBudget(value:unknown):ArgumentRepairBudget|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join()!=='fingerprints,maxAttempts,used,version'||v.version!==1||v.maxAttempts!==2||!Number.isInteger(v.used)||Number(v.used)<0||Number(v.used)>2||!Array.isArray(v.fingerprints)||v.fingerprints.length>8||v.fingerprints.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))||new Set(v.fingerprints).size!==v.fingerprints.length)return;
 return {version:1,used:Number(v.used),maxAttempts:2,fingerprints:[...v.fingerprints as string[]]};
}
