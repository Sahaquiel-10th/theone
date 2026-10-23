import {useEffect,useRef,useState} from 'react';
import {confirmAction} from './ConfirmAction';

type Api=<T>(url:string,options?:RequestInit)=>Promise<T>;
type Preview={userId:string;workspaceId:string;username:string;balanceMicros:number;current:{id:string;remainingMicros:number;grantedMicros:number;reservedMicros:number;endsAt:string}|null};
type Pending={userId:string;kind:'gift'|'reset';payload:Record<string,unknown>};
const power=(micros:number)=>(micros/1e6).toLocaleString('zh-CN',{maximumFractionDigits:6});
/** Intent: account restoration, not pricing. Hierarchy: account -> before/after
 * -> two actions. Use existing ONE paper/ink/olive surfaces, form type weights,
 * subtle borders and 16px density; no new visual system or decorative metrics. */
export function AdminPowerControls({actorId,users,api,reload}:{actorId:string;users:{id:string;username:string;enabled:boolean;profile?:{displayName?:string}}[];api:Api;reload:()=>Promise<void>}){
  const [userId,setUserId]=useState(''),[amount,setAmount]=useState('10'),[remark,setRemark]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const pending=useRef<Pending|null>(null),lock=useRef(false);
  const [recovery,setRecovery]=useState(false),[storageError,setStorageError]=useState(false);
  const storageKey=`one-account-power-pending:${actorId}`;
  useEffect(()=>{try{const stored=localStorage.getItem(storageKey);if(stored){const p=JSON.parse(stored) as Pending;if(!p.userId||!['gift','reset'].includes(p.kind)||typeof p.payload?.operationId!=='string')throw Error();pending.current=p;setUserId(p.userId);setRecovery(true);setNotice('上次操作还没取得确认，请先核对；不会重复入账。');}}catch{setStorageError(true);setNotice('无法读取操作记录，暂未开放提交，请检查浏览器存储。');}},[storageKey]);
  useEffect(()=>{let current=true;setPreview(null);if(!userId){setLoading(false);return;}setLoading(true);api<Preview>(`/api/admin/users/${encodeURIComponent(userId)}/power-controls`).then(p=>{if(current)setPreview(p);}).catch(e=>{if(current)setNotice(e instanceof Error?e.message:'额度读取失败，请重新选择账号');}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[userId,api]);
  async function refresh(id:string){const p=await api<Preview>(`/api/admin/users/${encodeURIComponent(id)}/power-controls`);setPreview(p);}
  async function submit(kind:'gift'|'reset'){
    if(lock.current||storageError)return;lock.current=true;setBusy(true);
    try{
      let p=pending.current;
      if(!p){
        if(!preview||preview.userId!==userId)throw Error('先选择账号并等额度读取完成');
        if(kind==='gift'&&(!Number.isSafeInteger(Number(amount)*1e6)||Number(amount)<=0||Number(amount)>1e6||!remark.trim()))throw Error('请输入有效电力和赠送备注');
        const period=preview.current;
        if(kind==='reset'&&!period)throw Error('这个账号当前没有生效中的套餐');
        if(!await confirmAction({title:kind==='gift'?'确认赠送电力':'重置本期套餐额度',message:kind==='gift'?`给 ${preview.username} 赠送 ${amount} 电力？\n备注：${remark.trim()}`:`${preview.username}：本期剩余 ${power(period!.remainingMicros)} → ${power(period!.grantedMicros)} 电力`,details:kind==='reset'?['不改变到期日、永久电力和后续月份；正在使用的预留仍保留。']:undefined,confirmLabel:kind==='gift'?'确认赠送':'恢复本期额度'}))return;
        p={userId,kind,payload:kind==='gift'?{operationId:crypto.randomUUID(),power:Number(amount),title:remark.trim()}:{operationId:crypto.randomUUID(),periodId:period!.id,expectedRemainingMicros:period!.remainingMicros,expectedGrantedMicros:period!.grantedMicros}};
        // Persist BEFORE sending, so a reload/network interruption cannot create
        // a second gift/reset. Recovery always resends the frozen payload.
        localStorage.setItem(storageKey,JSON.stringify(p));pending.current=p;setRecovery(true);
      }
      await api(`/api/admin/users/${encodeURIComponent(p.userId)}/${p.kind==='gift'?'power':'reset-membership'}`,{method:'POST',body:JSON.stringify(p.payload)});
      localStorage.removeItem(storageKey);pending.current=null;setRecovery(false);
      setNotice(p.kind==='gift'?'电力已赠送，备注已保存。':'本期套餐额度已恢复。');
      try{await refresh(p.userId);await reload();}catch{setNotice((p.kind==='gift'?'赠送已成功。':'本期额度已恢复。')+'页面刷新失败，请稍后刷新查看，不要重复操作。');}
    }catch(error){const message=error instanceof Error?error.message:'操作未确认';
      // This typed conflict is a definitive rejection before any mutation, not
      // an ambiguous transport failure. Fetch a fresh preview before retrying.
      if(message.includes('本期额度已变化')){localStorage.removeItem(storageKey);pending.current=null;setRecovery(false);await refresh(userId).catch(()=>setPreview(null));}
      setNotice(message+(pending.current?'；请核对上次操作，不要另开一次。':''));
    }finally{lock.current=false;setBusy(false);}
  }
  return <section className="admin-form" aria-label="账户额度操作">
    <h3>账户额度</h3>
    <label>选择用户<select aria-label="额度操作用户" value={userId} disabled={busy||recovery||storageError} onChange={e=>{setUserId(e.target.value);setNotice('');}}><option value="">请选择账号</option>{users.filter(u=>u.enabled).map(u=><option key={u.id} value={u.id}>{u.profile?.displayName||u.username} · {u.username}</option>)}</select></label>
    {loading?<p role="status">正在读取额度…</p>:preview?<p>永久电力：{power(preview.balanceMicros)}<br/>{preview.current?<>本期剩余：{power(preview.current.remainingMicros)} / {power(preview.current.grantedMicros)} 电力{preview.current.reservedMicros>0?`（其中 ${power(preview.current.reservedMicros)} 已预留）`:''}</>:'当前没有生效中的套餐'}</p>:null}
    <fieldset disabled={busy||recovery||storageError||!preview}><legend>赠送电力</legend><label>电力数量<input type="number" min="0.000001" max="1000000" step="0.000001" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>赠送备注<input value={remark} maxLength={80} onChange={e=>setRemark(e.target.value)} placeholder="例如：本次故障补偿"/></label><button type="button" className="primary" onClick={()=>void submit('gift')}>确认赠送</button></fieldset>
    <div><h4>重置本期套餐额度</h4><p className="hint">只恢复本期额度，不修改套餐到期日和永久电力。</p><button type="button" className="secondary" disabled={busy||recovery||storageError||!preview?.current} onClick={()=>void submit('reset')}>恢复本期额度</button></div>
    {recovery?<button type="button" className="primary" disabled={busy} onClick={()=>void submit(pending.current!.kind)}>{busy?'核对中…':'核对上次操作'}</button>:null}
    {notice?<p className="notice" role="status">{notice}</p>:null}
  </section>;
}
