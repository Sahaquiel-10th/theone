import {useCallback,useRef,useState,type Dispatch,type SetStateAction} from 'react';

export type ScopedState<T>={scope:object;value:T};
export function scopedStateValue<T>(stored:ScopedState<T>,scope:object,initial:T):T{return stored.scope===scope?stored.value:initial;}
export function updateScopedState<T>(stored:ScopedState<T>,owner:object,current:object,initial:T,action:SetStateAction<T>):ScopedState<T>{
  if(owner!==current)return stored;
  const previous=scopedStateValue(stored,owner,initial);
  return{scope:owner,value:typeof action==='function'?(action as (old:T)=>T)(previous):action};
}

/** Hide a previous account/workspace synchronously, including already queued React updaters. */
export function useCoordinatorScopedState<T>(scope:object,initial:T):[T,Dispatch<SetStateAction<T>>]{
  const initialRef=useRef(initial),current=useRef(scope);current.current=scope;
  const [stored,setStored]=useState<ScopedState<T>>(()=>({scope,value:initialRef.current}));
  const set=useCallback<Dispatch<SetStateAction<T>>>((action)=>{
    if(current.current!==scope)return;
    setStored(old=>updateScopedState(old,scope,current.current,initialRef.current,action));
  },[scope]);
  return[scopedStateValue(stored,scope,initialRef.current),set];
}
