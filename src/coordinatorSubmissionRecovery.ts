import {ApiError} from './oneApi';
import type {CoordinatorReceipt} from './coordinatorHistory';
import type {CoordinatorFailure} from './coordinatorRecovery';

export const invalidCoordinatorReceipt=()=>new ApiError('这次返回的进度暂时无法核对，正在查看原结果。',undefined,undefined,'INVALID_COORDINATOR_RECEIPT',false,{code:'invalid_receipt',stage:'receipt',outcome:'unknown'});

/** Reads only: a lost acknowledgement never authorizes another submission. */
export async function recoverCoordinatorSubmission(input:{
  isCurrent:()=>boolean;
  known:()=>CoordinatorReceipt|undefined;
  refresh:()=>Promise<unknown>;
  read:()=>Promise<CoordinatorReceipt>;
  accept:(receipt:CoordinatorReceipt)=>void;
  unknown:(failure:CoordinatorFailure)=>void;
  error:unknown;
}):Promise<CoordinatorReceipt|undefined> {
  if(!input.isCurrent())return;
  let known=input.known();
  if(known&&known.status!=='pending')return known;
  try{await input.refresh();}catch{/* The independent receipt read still gets a chance. */}
  if(!input.isCurrent())return;
  known=input.known();
  if(known)return known;
  let error=input.error;
  try{
    const receipt=await input.read();
    if(!input.isCurrent())return;
    input.accept(receipt);
    return input.known()??receipt;
  }catch(cause){error=cause;}
  if(!input.isCurrent())return;
  // A concurrent read may have completed while the independent GET failed.
  known=input.known();
  if(known)return known;
  const cause=error instanceof ApiError&&error.failure?error.failure:input.error instanceof ApiError?input.error.failure:undefined;
  const failure:CoordinatorFailure=cause?{...cause,stage:'receipt',outcome:'unknown'}:{code:'transport_unknown',stage:'receipt',outcome:'unknown'};
  input.unknown(failure);
}
