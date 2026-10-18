import {useEffect,useState} from 'react';
import type {api as Api} from './oneApi';
import {WelcomeGuideCard} from './WelcomeGuideCard';
type Guide={id:string;title:string;createdAt:string;taskId:string};
export function SavedWelcomeGuides({api}:{api:typeof Api}){
  const [guides,setGuides]=useState<Guide[]>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let live=true;void api<{guides:Guide[]}>('/api/me/welcome-guides').then(result=>{if(live){setGuides(result.guides);setError('');}}).catch(()=>{if(live)setError('已有说明暂时没打开，重试不会重新制作或扣费。');});return()=>{live=false;};},[api,refresh]);
  return <section className="account-panel saved-welcome-guides"><h3>我的 ONE 使用说明</h3>{error?<p role="alert">{error}<button type="button" onClick={()=>setRefresh(n=>n+1)}>重新读取</button></p>:!guides?<p role="status">在找你已有的说明…</p>:guides.length?<><WelcomeGuideCard id={guides[0].id} title={guides[0].title} showShareAction/>{guides.length>1?<details><summary>以前的说明（{guides.length-1}）</summary>{guides.slice(1).map(guide=><WelcomeGuideCard key={guide.id} id={guide.id} title={guide.title} showShareAction/>)}</details>:null}</>:<p>做好后会留在这里，随时可以打开、保存和分享。</p>}</section>;
}
