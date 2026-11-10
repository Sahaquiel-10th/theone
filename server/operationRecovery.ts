/** Provider-neutral facts for one already-scoped operation. The containing
 * checkpoint owns workspace/user/run/revision authorization; this envelope is
 * code-owned and is never accepted from a model or connector response. */
export type OperationFailure='timeout'|'busy'|'unavailable'|'result_unknown';
export type OperationRecovery={strategy:'retry_read';state:'executing'|'scheduled'|'exhausted'|'finished';attempt:number;maxAttempts:3;firstAttemptAt:string;nextRetryAt:string;deadlineAt:string;reason:OperationFailure};
export type OperationEvidence={version:1;execution:'running'|'submitted'|'succeeded'|'failed'|'unknown';verification:'not_required'|'pending'|'verified'|'failed';artifactRef?:string;recovery?:OperationRecovery};
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const failures=['timeout','busy','unavailable','result_unknown'];
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function validOperationEvidence(value:unknown):value is OperationEvidence{
 const v=object(value);if(!v||Object.keys(v).some(key=>!['version','execution','verification','artifactRef','recovery'].includes(key))||v.version!==1||!['running','submitted','succeeded','failed','unknown'].includes(String(v.execution))||!['not_required','pending','verified','failed'].includes(String(v.verification))||v.artifactRef!==undefined&&(typeof v.artifactRef!=='string'||!/^[a-f0-9]{64}$/.test(v.artifactRef)))return false;
 // A durable successful result stays available while an independent quality
 // check is pending or reports a problem. Submission alone supplies no result.
 if(v.verification==='verified'&&v.execution!=='succeeded'||v.artifactRef!==undefined&&v.execution!=='succeeded')return false;
 if(v.recovery!==undefined){
  const r=object(v.recovery);
  if(!r||Object.keys(r).sort().join()!=='attempt,deadlineAt,firstAttemptAt,maxAttempts,nextRetryAt,reason,state,strategy'||r.strategy!=='retry_read'||!['executing','scheduled','exhausted','finished'].includes(String(r.state))||r.maxAttempts!==3||!Number.isInteger(r.attempt)||Number(r.attempt)<1||Number(r.attempt)>3||!date(r.firstAttemptAt)||!date(r.nextRetryAt)||!date(r.deadlineAt)||!failures.includes(String(r.reason)))return false;
  const first=Date.parse(String(r.firstAttemptAt)),next=Date.parse(String(r.nextRetryAt)),deadline=Date.parse(String(r.deadlineAt));
  if(deadline-first!==120000||next<first||next>deadline||r.state==='scheduled'&&Number(r.attempt)>=3||r.state==='finished'&&v.execution!=='succeeded'||r.state!=='finished'&&v.artifactRef!==undefined)return false;
 }
 return true;
}
export function readAttempt(attempt:number,now:number,previous?:OperationRecovery):OperationRecovery{
 if(!Number.isFinite(now)||!Number.isInteger(attempt)||attempt<1||attempt>3||previous&&(attempt!==previous.attempt+1||now<Date.parse(previous.nextRetryAt)||now>=Date.parse(previous.deadlineAt)))throw new Error('Invalid operation recovery');
 const first=previous?.firstAttemptAt??new Date(now).toISOString(),deadline=previous?.deadlineAt??new Date(now+120000).toISOString();
 return {strategy:'retry_read',state:'executing',attempt,maxAttempts:3,firstAttemptAt:first,nextRetryAt:new Date(Math.min(Date.parse(deadline),now+(attempt===1?2000:8000))).toISOString(),deadlineAt:deadline,reason:'result_unknown'};
}
export function readFailureRecovery(current:OperationRecovery,reason:OperationFailure,now:number):OperationRecovery{
 const exhausted=current.attempt>=current.maxAttempts||now>=Date.parse(current.deadlineAt);
 return {...current,state:exhausted?'exhausted':'scheduled',reason,nextRetryAt:new Date(Math.min(Date.parse(current.deadlineAt),now+(current.attempt===1?2000:8000))).toISOString()};
}
/** Only reviewed transport/status facts enter the retry decision. No exception
 * messages, credentials, raw query or provider bodies are persisted here. */
export function transientReadFailure(value:unknown):OperationFailure|undefined{
 const v=object(value);if(!v)return;
 const status=typeof v.status==='number'?v.status:typeof v.statusCode==='number'?v.statusCode:undefined;
 if(status===401||status===403||status===400||status===402||status===404||status===409)return;
 if(status===408||status===504)return 'timeout';if(status===429)return 'busy';if(status!==undefined&&status>=500&&status<=599)return 'unavailable';
 if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','TIMEOUT'].includes(String(v.code))||v.name==='TimeoutError')return 'timeout';
 if(['ECONNRESET','ECONNREFUSED','EAI_AGAIN','UND_ERR_SOCKET'].includes(String(v.code)))return 'unavailable';
 // Knowledge adapters already expose sanitized retryability. Partial usable
 // material is a real result; do not repeat reads merely to make it perfect.
 if(Array.isArray(v.chunks)&&v.chunks.some(chunk=>typeof object(chunk)?.content==='string'&&String(object(chunk)!.content).trim()))return;
 if(Array.isArray(v.sources)&&v.sources.length)return;
 if(!Array.isArray(v.failures)||!v.failures.length)return;
 const known=v.failures.map(object);
 if(known.some(f=>!f||f.retryable!==true||!['RATE_LIMITED','TIMEOUT','UNAVAILABLE'].includes(String(f.code))))return;
 return known.some(f=>f!.code==='TIMEOUT')?'timeout':known.some(f=>f!.code==='RATE_LIMITED')?'busy':'unavailable';
}
export function operationProgress(evidence:OperationEvidence|undefined){
 if(!validOperationEvidence(evidence))return;
 const recovery=evidence.recovery;
 return {execution:evidence.execution,verification:evidence.verification,resultAvailable:!!evidence.artifactRef,...(recovery&&['scheduled','executing','exhausted'].includes(recovery.state)?{recovery:{state:recovery.state==='exhausted'?'exhausted' as const:'scheduled' as const,attempt:recovery.attempt,nextRetryAt:recovery.nextRetryAt}}:{})};
}
