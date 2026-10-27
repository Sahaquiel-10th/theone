import { useEffect, useState } from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsDialog} from './SettingsControls';
import type { api as Api } from './oneApi';
import type { FeatureApproval, FeaturePrice } from '../server/featurePricing';

export async function approveFeaturePrices(api:typeof Api, featureIds:string[], taskId?:string):Promise<FeatureApproval[]> {
  const quote=await api<{approvalThreshold:number;features:FeaturePrice[]}>('/api/features/quote',{method:'POST',body:JSON.stringify({featureIds,taskId})});
  const high=quote.features.filter(f=>f.multiplier>quote.approvalThreshold);
  if(high.length&&!await confirmFeatureBudget(high,quote.approvalThreshold))throw new Error('已取消使用这些功能，任务尚未提交。');
  return high.map(({id,releaseId,version,multiplier})=>({id,releaseId,version,multiplier}));
}
function confirmFeatureBudget(features:FeaturePrice[],threshold:number):Promise<boolean>{
  return new Promise(resolve=>{
    const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
    const finish=(accepted:boolean)=>{root.unmount();host.remove();resolve(accepted);};
    root.render(<SettingsDialog title="确认本次功能费用" onClose={()=>finish(false)}><p>以下功能的费用倍率高于你设置的 {threshold} 倍，需要先确认：</p><ul>{features.map(f=><li key={f.id}>{f.name} · {f.multiplier} 倍</li>)}</ul><p>各功能按实际用量分别计费，费用相加。此次确认只用于这次任务，不会修改你的费用设置。</p><div className="settings-tabs"><button type="button" onClick={()=>finish(false)}>取消使用</button><button type="button" className="primary" onClick={()=>finish(true)}>确认使用</button></div></SettingsDialog>);
  });
}
export function FeatureBudgetSettings({api}:{api:typeof Api}) {
  const [value,setValue]=useState('2'),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[help,setHelp]=useState(false);
  useEffect(()=>{let live=true;void api<{approvalThreshold:number}>('/api/features/budget-policy').then(p=>{if(live)setValue(String(p.approvalThreshold));}).catch(e=>{if(live)setNotice(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api]);
  return <section className="account-panel feature-budget-settings"><header className="settings-card-heading"><h3>功能费用确认</h3><button type="button" className="settings-help-button" aria-label="查看功能计费说明" onClick={()=>setHelp(true)}>ⓘ</button></header><label>费用倍率超过以下数值时，使用前先确认<div className="settings-value-field"><input aria-label="功能费用确认倍率" type="number" min="0.001" max="100" step="0.1" value={value} disabled={loading||busy} onChange={e=>setValue(e.target.value)}/><span>倍</span></div></label><button type="button" disabled={loading||busy||!Number.isFinite(Number(value))||Number(value)<.001||Number(value)>100} onClick={async()=>{setBusy(true);setNotice('');try{await api('/api/features/budget-policy',{method:'POST',body:JSON.stringify({approvalThreshold:Number(value)})});setNotice('费用确认设置已保存');}catch(e){setNotice(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}}>{busy?'正在保存…':'保存设置'}</button>{notice?<p role="status">{notice}</p>:null}{help?<SettingsDialog title="功能费用怎么算？" onClose={()=>setHelp(false)}><p>每项功能的费用倍率会在详情里列出。使用后按实际用量计费，从 ONE 电力额度中扣除；多项功能的费用分别相加。</p><p>此设置决定何时先向你确认费用，不是消费总额上限。选择功能本身不扣费，创建任务前仍可设置本次电力上限。</p></SettingsDialog>:null}</section>;
}
