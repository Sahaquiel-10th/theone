import {useState} from 'react';
import {OneEye} from './OneEye';
import type {AppearanceScene} from './appearancePreferences';

/** The authenticated workspace's first read keeps one visual shell throughout. */
export function WorkspaceStartup({scene,error,onRetry}:{scene:AppearanceScene;error?:string;onRetry:()=>Promise<void>}) {
 const [retrying,setRetrying]=useState(false);
 return <main className="one-shell one-studio one-fluid-workspace workspace-startup" data-fluid-material="optical" data-fluid-scene={scene} data-workspace-startup={error?'retry':'loading'}>
  <section className="workspace-startup-surface" aria-busy={!error||retrying} aria-label="正在打开 ONE 工作台">
   <div className="workspace-startup-status" role={error?'alert':'status'}>
    <OneEye mood={error?'attentive':'thinking'} size="lg" decorative/>
    <h1>{error?'工作台暂时没连上':'正在打开工作台'}</h1>
    {error?<><p>请检查网络与 ONE Key 连接，然后重试。</p><button type="button" disabled={retrying} onClick={()=>{setRetrying(true);void onRetry().catch(()=>{/* Keep the same retry surface; never render raw diagnostics. */}).finally(()=>setRetrying(false));}}>{retrying?'正在重连':'重新连接'}</button></>:null}
   </div>
  </section>
 </main>;
}
