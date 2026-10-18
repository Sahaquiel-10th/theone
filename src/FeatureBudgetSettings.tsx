import { useEffect, useState } from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsDialog} from './SettingsControls';
import type { api as Api } from './oneApi';
import type { FeatureApproval, FeaturePrice } from '../server/featurePricing';

export async function approveFeaturePrices(api:typeof Api, featureIds:string[], taskId?:string):Promise<FeatureApproval[]> {
  const quote=await api<{approvalThreshold:number;features:FeaturePrice[]}>('/api/features/quote',{method:'POST',body:JSON.stringify({featureIds,taskId})});
  const high=quote.features.filter(f=>f.multiplier>quote.approvalThreshold);
  if(high.length&&!await confirmFeatureBudget(high,quote.approvalThreshold))throw new Error('已取消高倍率功能授权，尚未提交任务。');
  return high.map(({id,releaseId,version,multiplier})=>({id,releaseId,version,multiplier}));
}
function confirmFeatureBudget(features:FeaturePrice[],threshold:number):Promise<boolean>{
  return new Promise(resolve=>{
    const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
    const finish=(accepted:boolean)=>{root.unmount();host.remove();resolve(accepted);};
    root.render(<SettingsDialog title="确认高倍率功能" onClose={()=>finish(false)}><p>以下功能超过你设置的 {threshold} 倍门槛：</p><ul>{features.map(f=><li key={f.id}>{f.name} · {f.multiplier} 倍</li>)}</ul><p>仅授权本轮。各功能按实际用量分别扣除，再相加，不会把倍率相乘，也不会修改你的默认门槛。</p><div className="settings-tabs"><button type="button" onClick={()=>finish(false)}>不使用</button><button type="button" className="primary" onClick={()=>finish(true)}>允许本轮使用</button></div></SettingsDialog>);
  });
}
export function FeatureBudgetSettings({api}:{api:typeof Api}) {
  const [value,setValue]=useState('2'),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[help,setHelp]=useState(false);
  useEffect(()=>{let live=true;void api<{approvalThreshold:number}>('/api/features/budget-policy').then(p=>{if(live)setValue(String(p.approvalThreshold));}).catch(e=>{if(live)setNotice(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api]);
  return <section className="account-panel feature-budget-settings"><header className="settings-card-heading"><h3>功能使用授权</h3><button type="button" className="settings-help-button" aria-label="查看功能计费说明" onClick={()=>setHelp(true)}>ⓘ</button></header><label>高于这个倍率，用前先问我<div className="settings-value-field"><input aria-label="功能单独授权倍率" type="number" min="0.001" max="100" step="0.1" value={value} disabled={loading||busy} onChange={e=>setValue(e.target.value)}/><span>倍</span></div></label><button type="button" disabled={loading||busy||!Number.isFinite(Number(value))||Number(value)<.001||Number(value)>100} onClick={async()=>{setBusy(true);setNotice('');try{await api('/api/features/budget-policy',{method:'POST',body:JSON.stringify({approvalThreshold:Number(value)})});setNotice('授权门槛已保存');}catch(e){setNotice(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}}>{busy?'正在保存…':'保存授权门槛'}</button>{notice?<p role="status">{notice}</p>:null}{help?<SettingsDialog title="功能怎么扣电力？" onClose={()=>setHelp(false)}><p>各功能按实际用量分别计费，再从同一份 ONE 额度扣除；倍率不会相乘。</p><p>默认超过 2 倍先问你。这个数是确认门槛，不是总消费上限；选择功能本身不扣费。</p></SettingsDialog>:null}</section>;
}
