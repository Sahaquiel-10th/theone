export type GameAttempt = { operationId:string; gameRevision:number };
export type GameAttemptReceipt = { operationId:string; gameRevision?:number };
/** A request lost in an earlier round must not keep the new round's editor locked. */
export function gameAttemptResolution(attempt:GameAttempt,revision:number,historyOperationIds:string[],prior?:GameAttemptReceipt|null):'accepted'|'previous_round'|'not_sent'|'lookup'|'pending' {
  if(historyOperationIds.includes(attempt.operationId))return 'accepted';
  if(attempt.gameRevision===revision)return 'pending';
  if(prior===null)return 'not_sent';
  if(prior?.operationId===attempt.operationId&&prior.gameRevision===attempt.gameRevision)return 'previous_round';
  return 'lookup';
}
