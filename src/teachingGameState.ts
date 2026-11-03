export type GameAttempt = { operationId:string; gameRevision:number };
export type GameAttemptReceipt = { operationId:string; gameRevision?:number };
export type GameDraftAttempt = GameAttempt & {content:string};
export type GameDraft = {content?:string;attempt?:GameDraftAttempt};
/** Browser storage is optional and may contain old or malformed drafts. */
export function decodeGameDraft(raw:string|null|undefined):GameDraft {
  try {
    const value:unknown=JSON.parse(raw??'{}');
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    const saved=value as Record<string,unknown>,result:GameDraft={};
    if(saved.content!==undefined){if(typeof saved.content!=='string'||saved.content.length>6000)return {};result.content=saved.content;}
    if(saved.attempt!==undefined){
      if(!saved.attempt||typeof saved.attempt!=='object'||Array.isArray(saved.attempt))return {};
      const attempt=saved.attempt as Record<string,unknown>;
      if(typeof attempt.operationId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(attempt.operationId)||typeof attempt.content!=='string'||!attempt.content.trim()||attempt.content.length>6000||!Number.isSafeInteger(attempt.gameRevision)||(attempt.gameRevision as number)<0)return {};
      result.attempt={operationId:attempt.operationId,content:attempt.content,gameRevision:attempt.gameRevision as number};
    }
    return result;
  }catch{return {};}
}
/** A request lost in an earlier round must not keep the new round's editor locked. */
export function gameAttemptResolution(attempt:GameAttempt,revision:number,historyOperationIds:string[],prior?:GameAttemptReceipt|null):'accepted'|'previous_round'|'not_sent'|'lookup'|'pending' {
  if(historyOperationIds.includes(attempt.operationId))return 'accepted';
  // The visible window can omit an accepted request even within the same game.
  // A read by its original ID is safe; a 404 does not authorize a paid resend.
  if(prior===null)return attempt.gameRevision===revision?'pending':'not_sent';
  if(prior?.operationId===attempt.operationId&&prior.gameRevision===attempt.gameRevision)return attempt.gameRevision===revision?'accepted':'previous_round';
  return 'lookup';
}
