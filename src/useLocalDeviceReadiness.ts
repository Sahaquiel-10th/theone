import {useCallback,useEffect,useMemo,useSyncExternalStore} from 'react';
import type {api as Api} from './oneApi';
import {localDeviceReadinessResource,ONE_LOCAL_SETTINGS_EVENT} from './localDeviceReadinessStore';
import {localDeviceCanRequestExecution} from './localDeviceReadiness';

export function useLocalDeviceReadiness(api:typeof Api){
 const resource=useMemo(()=>localDeviceReadinessResource(api),[api]);
 const snapshot=useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot);
 useEffect(()=>{
  void resource.refresh();
  const refresh=()=>void resource.refresh(true);
  window.addEventListener('focus',refresh);window.addEventListener('online',refresh);window.addEventListener(ONE_LOCAL_SETTINGS_EVENT,refresh);
  return()=>{window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener(ONE_LOCAL_SETTINGS_EVENT,refresh);};
 },[resource]);
 const refresh=useCallback(()=>resource.refresh(true),[resource]);
 return{...snapshot,ready:snapshot.status==='confirmed'&&snapshot.value?.ready===true,canRequestExecution:snapshot.status==='confirmed'&&localDeviceCanRequestExecution(snapshot.value),refresh};
}
