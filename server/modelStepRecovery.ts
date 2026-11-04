import {ModelRequestError,ModelResponseError,type ToolChatResult} from './modelGateway.js';

/** Private, operation-owned attempt state. It is never accepted from model JSON.
 * Unknown provider costs consume the task's internal ceiling, not the wallet. */
export type TextModelAttempt={version:1;digest:string;attempt:number;state:'running'|'retryable'|'completed'|'exhausted';reservedMicros:number;uncertainMicros:number};
export class TextModelRecoveryError extends Error {
 constructor(){super('这一步上次的模型调用已发出，结果还没确认。已有材料保留，不会自动重新购买同一步。');}
}
export function textModelRetryable(error:unknown){
 return error instanceof ModelRequestError&&[408,429,500,502,503,504].includes(error.status)
  ||error instanceof ModelResponseError;
}
const valid=(s:TextModelAttempt|undefined,digest:string)=>s&&s.version===1&&s.digest===digest&&Number.isSafeInteger(s.attempt)&&s.attempt>=1&&s.attempt<=2&&['running','retryable','completed','exhausted'].includes(s.state)&&Number.isSafeInteger(s.reservedMicros)&&s.reservedMicros>=0&&Number.isSafeInteger(s.uncertainMicros)&&s.uncertainMicros>=0;
/** One model-only stage, at most two purchased calls. Tools/writes/features do
 * not enter this function. Storage provides a serialized compare-and-swap. */
export async function runRecoverableTextModel(input:{
 digest:string;
 load:()=>Promise<TextModelAttempt|undefined>;
 save:(expected:TextModelAttempt|undefined,next:TextModelAttempt)=>Promise<boolean>;
 verify:()=>Promise<void>;
 call:(attempt:number)=>Promise<ToolChatResult>;
 onRetry?:()=>Promise<void>;
 wait?:(ms:number)=>Promise<void>;
}):Promise<ToolChatResult>{
 if(!/^[a-f0-9]{64}$/.test(input.digest))throw new TextModelRecoveryError();
 await input.verify();
 let prior=await input.load();
 if(prior&&(!valid(prior,input.digest)||prior.state!=='retryable'||prior.attempt>=2))throw new TextModelRecoveryError();
 for(;;){
  await input.verify();
  const current:TextModelAttempt={version:1,digest:input.digest,attempt:(prior?.attempt??0)+1,state:'running',reservedMicros:0,uncertainMicros:prior?.uncertainMicros??0};
  if(!await input.save(prior,current))throw new TextModelRecoveryError();
  let result:ToolChatResult;
  try{
   result=await input.call(current.attempt);
  }catch(error){
   // Only the owner can record the reservation while this exact claim runs.
   const latest=await input.load();
   if(!valid(latest,input.digest)||latest!.state!=='running'||latest!.attempt!==current.attempt)throw new TextModelRecoveryError();
   const retry=textModelRetryable(error)&&latest!.reservedMicros>0&&current.attempt<2;
   const next:TextModelAttempt={...latest!,state:retry?'retryable':'exhausted',uncertainMicros:latest!.uncertainMicros+(textModelRetryable(error)?latest!.reservedMicros:0),reservedMicros:0};
   if(!await input.save(latest,next))throw new TextModelRecoveryError();
   if(!retry)throw error;
   // Recheck cancellation/Key before even announcing a retry, then again at
   // the next claim and reservation. All uncertain cost remains in the cap.
   await input.verify();await input.onRetry?.();
   await (input.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(1000);
   prior=next;continue;
  }
  await input.verify();
  const latest=await input.load();
  if(!valid(latest,input.digest)||latest!.state!=='running'||latest!.attempt!==current.attempt)throw new TextModelRecoveryError();
  if(!await input.save(latest,{...latest!,state:'completed',reservedMicros:0}))throw new TextModelRecoveryError();
  // length/filtered and returned tool instructions are real responses. Their
  // workflow classification retains partial text; they are never repurchased.
  return result;
 }
}
