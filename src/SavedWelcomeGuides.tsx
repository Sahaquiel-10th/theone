import {useEffect,useState} from 'react';
import {History} from 'lucide-react';
import type {api as Api} from './oneApi';
import {WelcomeGuideCard} from './WelcomeGuideCard';
import {SettingsDialog} from './SettingsControls';
export type SavedGuide={id:string;title:string;createdAt:string;taskId:string};
export function guideDate(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric'}):'以前保存的说明';}
export function GuideHistoryList({guides,api}:{guides:SavedGuide[];api:typeof Api}){
  return <div className="saved-guide-history-list">{guides.map(guide=><WelcomeGuideCard key={guide.id} id={guide.id} title={guide.title} compact caption={guideDate(guide.createdAt)} showShareAction request={api}/>)}</div>;
}
export function SavedWelcomeGuides({api}:{api:typeof Api}){
  const [guides,setGuides]=useState<SavedGuide[]>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[historyOpen,setHistoryOpen]=useState(false);
  useEffect(()=>{let live=true;void api<{guides:SavedGuide[]}>('/api/me/welcome-guides').then(result=>{if(live){setGuides(result.guides);setError('');}}).catch(()=>{if(live)setError('已有说明暂时没打开。');});return()=>{live=false;};},[api,refresh]);
  return <section className="account-panel saved-welcome-guides account-span-full"><header className="settings-card-heading"><h3>我的 ONE 使用说明</h3>{guides&&guides.length>1?<button type="button" className="settings-history-button" onClick={()=>setHistoryOpen(true)}><History size={15}/>以前的说明 <span>{guides.length-1}</span></button>:null}</header>{error?<div className="settings-inline-error" role="alert"><span>{error}</span><button type="button" onClick={()=>setRefresh(n=>n+1)}>重新读取</button></div>:!guides?<p role="status" className="settings-muted">在找你已有的说明…</p>:guides.length?<WelcomeGuideCard id={guides[0].id} title={guides[0].title} compact caption={`最近制作 · ${guideDate(guides[0].createdAt)}`} showShareAction request={api}/>:<p className="settings-muted">做好后会留在这里，随时回来打开。</p>}
    {historyOpen?<SettingsDialog title="以前的使用说明" className="saved-guide-history-dialog" onClose={()=>setHistoryOpen(false)}><GuideHistoryList guides={guides?.slice(1)??[]} api={api}/></SettingsDialog>:null}
  </section>;
}
