import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import type { OfficialFeatureRecord } from "../server/officialFeatures";
import { Pagination } from "./SettingsControls";

export function FeatureRelease({api,record,disabled,onChanged}:{api:typeof Api;record:OfficialFeatureRecord;disabled:boolean;onChanged:()=>Promise<void>}) {
  const [q,setQ]=useState(''),[page,setPage]=useState(1),[data,setData]=useState<{items:{id:string;name:string}[];total:number}>({items:[],total:0});
  const [selected,setSelected]=useState<string[]>(record.release?.userIds??[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;void api<typeof data>(`/api/admin/official-features/recipients?q=${encodeURIComponent(q)}&page=${page}`).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,q,page]);
  async function act(action:'publish'|'unpublish') {
    if(!confirm(action==='publish'?`将已认定 v${record.current?.version} 上架给 ${selected.length} 个账号？使用者自行承担模型电力，旧版本进行中的任务将停止后续步骤。`:'下架后不再允许新任务，进行中的任务停止后续步骤。确认？'))return;
    setBusy(true);setError('');try{await api(`/api/admin/official-features/${record.id}/release`,{method:'POST',body:JSON.stringify({action,revision:record.revision,version:record.current?.version,userIds:selected,confirmed:true})});await onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}
  }
  return <details><summary>上架与内测账号{record.release?` · 已上架 v${record.release.version}`:' · 未上架'}</summary><p className="hint">先认定，再指定账号上架。此处不开放创作者上传；上架不赋予用户任何人的知识权限。</p>
    <input type="search" aria-label="搜索内测账号" placeholder="搜索账号" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/>
    {data.items.map(u=><label className="sharing-check" key={u.id}><input type="checkbox" checked={selected.includes(u.id)} disabled={busy||disabled} onChange={e=>setSelected(e.target.checked?[...selected,u.id]:selected.filter(id=>id!==u.id))}/>{u.name}</label>)}
    <Pagination page={page} total={data.total} onChange={setPage}/><p>已选 {selected.length} 个账号 <button type="button" disabled={busy} onClick={()=>setSelected([])}>清空选择</button></p>
    <button type="button" disabled={busy||disabled||record.status!=='approved'||!record.current||!selected.length||selected.length>100} onClick={()=>void act('publish')}>将已认定版本上架给所选账号</button>
    {record.release?<button type="button" disabled={busy||disabled} onClick={()=>void act('unpublish')}>下架</button>:null}
    {error?<p role="alert">{error}</p>:null}
  </details>;
}
