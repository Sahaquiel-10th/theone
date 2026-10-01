import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import type { OfficialFeatureRecord, OfficialFeatureValues } from "../server/officialFeatures";
import { Pagination, SettingsDialog,SearchPicker } from "./SettingsControls";
import {featureCategories} from '../server/featureCategories';
import { FeatureBuilder, FeatureTrial } from "./FeatureBuilder";
import { FeatureRelease } from "./FeatureRelease";
import {PublicCommercePolicyPanel} from './PublicServicePanels';

type Row={id:string;name:string;author:string;status:string;version:number;releaseVersion?:number;hasChanges:boolean};
type Detail=OfficialFeatureRecord & {total:number};
const initial:OfficialFeatureValues={name:"",description:"",author:"ONE",instructions:"",limitations:"",integration:"question_answer"};
const status:Record<string,string>={draft:"草稿",approved:"配置已认定",paused:"已停用"};
export function OfficialFeaturePanel({api}:{api:typeof Api}){
  const [data,setData]=useState<{items:Row[];total:number}>({items:[],total:0}),[q,setQ]=useState(""),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState("");
  useEffect(()=>{let live=true;void api<typeof data>(`/api/admin/official-features?page=${page}&q=${encodeURIComponent(q)}`).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,page,q,refresh]);
  return <section className="official-feature-admin"><header className="section-toolbar"><h3>官方智能体</h3><button className="primary" type="button" onClick={()=>setSelected("")}>＋ 新增功能</button></header>
    <PublicCommercePolicyPanel api={api}/>
    <input type="search" aria-label="搜索官方功能" placeholder="搜索名称、作者或标识" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/>
    <div className="settings-choice-list">{data.items.map(r=><button type="button" key={r.id} onClick={()=>setSelected(r.id)}><span><strong>{r.name}</strong><small>{r.author} · {status[r.status]}{r.version?` · v${r.version}`:""}{r.releaseVersion?` · 已上架 v${r.releaseVersion}`:' · 未上架'}{r.hasChanges?" · 草稿有修改":""}</small></span><span>配置</span></button>)}</div>
    {data.total>10?<Pagination page={page} total={data.total} onChange={setPage}/>:null}{error?<p role="alert">{error}</p>:null}
    {selected!==null?<SettingsDialog title={selected?"官方功能配置":"新增官方功能"} onClose={()=>setSelected(null)}><FeatureEditor key={selected} api={api} featureId={selected} onChanged={()=>setRefresh(n=>n+1)}/></SettingsDialog>:null}
  </section>;
}
function FeatureEditor({api,featureId,onChanged}:{api:typeof Api;featureId:string;onChanged:()=>void}){
  const [id,setId]=useState(featureId),[saved,setSaved]=useState(!!featureId),[detail,setDetail]=useState<Detail>(),[values,setValues]=useState<OfficialFeatureValues>(initial),[evidence,setEvidence]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[page,setPage]=useState(1);
  const [history,setHistory]=useState<Detail>();
  useEffect(()=>{if(!featureId)return;let live=true;void api<Detail>(`/api/admin/official-features/${featureId}`).then(d=>{if(live){setDetail(d);setHistory(d);setValues(d.draft);}}).catch(e=>{if(live)setNotice(e.message);});return()=>{live=false;};},[api,featureId]);
  useEffect(()=>{if(!saved)return;let live=true;void api<Detail>(`/api/admin/official-features/${id}?page=${page}`).then(d=>{if(live)setHistory(d);}).catch(e=>{if(live)setNotice(e.message);});return()=>{live=false;};},[api,id,saved,page]);
  async function act(action:string,version?:number){setBusy(true);setNotice("");try{
    await api(`/api/admin/official-features/${id}`,{method:"POST",body:JSON.stringify({revision:detail?.revision??0,action,values,evidence,confirmed,version})});
    const next=await api<Detail>(`/api/admin/official-features/${id}`);setDetail(next);setHistory(next);setValues(next.draft);setSaved(true);setPage(1);setConfirmed(false);setEvidence("");onChanged();setNotice(action==="approve"?"新版本已认定；请在上架区选择是否发布或替换线上版本":"已保存");
  }catch(e){setNotice(e instanceof Error?e.message:"未能完成");}finally{setBusy(false);}}
  const changed=!!detail&&JSON.stringify(detail.draft)!==JSON.stringify(values);
  return <div className="sharing-form">
    <label>功能标识<input value={id} disabled={saved||busy} placeholder="例如 industry-report" maxLength={64} onChange={e=>setId(e.target.value)}/></label>
    <label>功能分类<SearchPicker label="分类" value={values.category??'general'} options={featureCategories.map(c=>({value:c.id,label:c.name}))} onChange={category=>setValues({...values,category:category as OfficialFeatureValues['category']})}/></label>
    {([['name','名称',60],['author','作者或合作方',100],['description','用途',500],['instructions','执行要求',12000],['limitations','适用边界与限制',2000]] as const).map(([key,label,max])=><label key={key}>{label}{key==='name'||key==='author'?<input value={values[key]} maxLength={max} disabled={busy} onChange={e=>setValues({...values,[key]:e.target.value})}/>:<textarea rows={key==='instructions'?5:3} value={values[key]} maxLength={max} disabled={busy} onChange={e=>setValues({...values,[key]:e.target.value})}/>}</label>)}
    <FeatureBuilder api={api} values={values} onChange={setValues} disabled={busy}/>
    <button type="button" className="primary" disabled={busy|| (!!featureId&&!detail)} onClick={()=>void act("save")}>保存草稿</button>
    {saved&&detail?<FeatureTrial key={`${id}:${detail.revision}`} api={api} id={id} revision={detail.revision} disabled={busy||changed||!values.modelId||detail.status==='paused'}/>:null}
    {saved&&detail?<FeatureRelease key={`release:${detail.revision}`} api={api} record={detail} disabled={busy||changed} onChanged={async()=>{const next=await api<Detail>(`/api/admin/official-features/${id}`);setDetail(next);setHistory(next);setValues(next.draft);onChanged();}}/>:null}
    {saved&&detail?<><details><summary>官方认定</summary><p>认定已保存的配置版本，不会自动接入服务或上架。请勿填写客户私密资料、密钥或凭证。</p><label>验收记录<textarea rows={4} value={evidence} maxLength={4000} onChange={e=>setEvidence(e.target.value)} placeholder="测试范围、结果、局限及维护责任，至少 20 字"/></label><label className="sharing-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认只认定配置，不代表已开放运行</label><button type="button" disabled={busy||changed||!confirmed||evidence.trim().length<20} onClick={()=>void act("approve")}>认定保存的版本</button>{changed?<p>请先保存当前修改。</p>:null}</details>
      {detail.current?<button type="button" disabled={busy||detail.status==='paused'} onClick={()=>{if(confirm("停用当前认定版本？历史记录会保留。"))void act("pause");}}>停用当前版本</button>:null}
      <details><summary>版本记录 · {history?.total??0}</summary>{history?.history.map(v=><article key={v.version}><strong>v{v.version} · {v.values.name}</strong><p>{new Date(v.approvedAt).toLocaleString()}</p><details><summary>配置与验收</summary><p style={{whiteSpace:'pre-wrap'}}>{v.values.instructions}</p><p>{v.values.limitations}</p><p style={{whiteSpace:'pre-wrap'}}>{v.evidence}</p></details><button type="button" disabled={busy} onClick={()=>{if(confirm("恢复此版本到草稿？当前未保存的修改将被替换，不会自动重新启用。"))void act("restore",v.version);}}>恢复到草稿</button></article>)}<Pagination page={page} total={history?.total??0} size={5} onChange={setPage}/></details></>:null}
    {notice?<p role="status">{notice}</p>:null}
  </div>;
}
