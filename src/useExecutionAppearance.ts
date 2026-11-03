import {useLayoutEffect,useMemo,useState} from 'react';
import {advanceExecutionAppearance,endExecutionAppearanceWait,forgetExecutionAppearanceConversation,executionAppearanceActive,executionAppearanceWaiting,initialExecutionAppearance,readExecutionAppearance,writeExecutionAppearance,type AppearanceScope,type AppearanceTask} from './executionAppearance';
function optionalStorage(){try{return typeof window==='undefined'?undefined:window.sessionStorage;}catch{return undefined;}}

/** Layout reconciliation keeps the first frame of a terminal/confirming poll
 * consistent with the running frame, without mutating React state in render. */
export function useExecutionAppearance(scope:AppearanceScope,tasks:AppearanceTask[]) {
  const [stored,setStored]=useState(()=>readExecutionAppearance(optionalStorage(),scope));
  const current=useMemo(()=>{
    const scoped=stored.scope===initialExecutionAppearance(scope).scope?stored:readExecutionAppearance(optionalStorage(),scope);
    return advanceExecutionAppearance(scoped,scope,tasks);
  },[stored,scope.userId,scope.workspaceId,tasks]);
  useLayoutEffect(()=>{
    if(current!==stored)setStored(current);
    writeExecutionAppearance(optionalStorage(),scope,current);
  },[current,stored,scope.userId,scope.workspaceId]);
  return {active:executionAppearanceActive(current),waiting:executionAppearanceWaiting(current),
    endWait:(task:AppearanceTask)=>setStored(previous=>endExecutionAppearanceWait(previous,scope,task)),
    forgetConversation:(conversationId:string)=>setStored(previous=>forgetExecutionAppearanceConversation(previous,scope,conversationId))};
}
