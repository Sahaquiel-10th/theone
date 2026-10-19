import { useState } from "react";
import type { api as Api } from "./oneApi";
import type { OfficialFeatureRecord } from "../server/officialFeatures";
import { confirmAction } from './ConfirmAction';

export function FeatureRelease({api,record,disabled,onChanged}:{api:typeof Api;record:OfficialFeatureRecord;disabled:boolean;onChanged:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function act(action:'publish'|'unpublish') {
    if(!await confirmAction({title:action==='publish'?'向所有用户上架？':'下架这个功能？',message:action==='publish'?`将已认定 v${record.current?.version} 向现有和之后的新用户开放，仍按当前规则计费。`:'下架后不再允许新任务，进行中的任务停止后续步骤。',details:action==='publish'?['不会开放任何人的知识库、本机文件或私人凭证。','重新发布会让旧发布版本的任务停止后续步骤。']:undefined,confirmLabel:action==='publish'?'确认上架':'确认下架',danger:action==='unpublish'}))return;
    setBusy(true);setError('');try{await api(`/api/admin/official-features/${record.id}/release`,{method:'POST',body:JSON.stringify({action,revision:record.revision,version:record.current?.version,confirmed:true})});await onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}
  }
  if(record.workspaceId)return <p className="hint">这是公司私有功能，请在公司交付入口管理，不会向其他用户公开。</p>;
  return <details><summary>上架与开放范围{record.release?` · 已上架 v${record.release.version} · 所有用户`:' · 未上架'}</summary><p className="hint">审核认定后上架，现有和之后的新用户都能使用，无需逐个开通。仍按实际使用计费；知识库、本机文件和私人凭证分别授权。</p>
    <button type="button" disabled={busy||disabled||record.status!=='approved'||!record.current} onClick={()=>void act('publish')}>将已认定版本向所有用户上架</button>
    {record.release?<button type="button" disabled={busy||disabled} onClick={()=>void act('unpublish')}>下架</button>:null}
    {error?<p role="alert">{error}</p>:null}
  </details>;
}
