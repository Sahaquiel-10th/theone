import {useEffect,useRef,useState} from 'react';
import {BookOpen,Download,Share2,X} from 'lucide-react';
import {api} from './oneApi';

type Preview={html:string;name:string;shared:boolean};
function download(bytes:Blob,name:string){const url=URL.createObjectURL(bytes),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function WelcomeGuideCard({id,title}:{id:string;title:string}){
  const [open,setOpen]=useState(false),[preview,setPreview]=useState<Preview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[share,setShare]=useState('');
  const close=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;close.current?.focus();let active=true;setError('');void api<Preview>(`/api/welcome-pages/${encodeURIComponent(id)}`).then(p=>{if(active)setPreview(p);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[open,id]);
  function hide(){setOpen(false);opener.current?.focus();}
  async function poster(){setBusy(true);setError('');try{
    const p=await api<{svg:string;name:string}>(`/api/welcome-pages/${encodeURIComponent(id)}?format=poster`);
    const image=new window.Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('大图暂时没保存好，可以先保存网页。'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(p.svg);});const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法导出大图，可以先保存网页。');ctx.drawImage(image,0,0);const bytes=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));if(!bytes)throw new Error('大图暂时没保存好，可以先保存网页。');download(bytes,p.name.replace(/\.svg$/,'.png'));
  }catch(e){setError(e instanceof Error?e.message:'大图暂时没保存好。');}finally{setBusy(false);}}
  async function publish(){
    if(!window.confirm('创建分享链接后，拿到链接的人能看到你的称呼、说明图片、用途和已连接平台名称。不含知识正文、聊天记录或本地文件。链接 7 天有效，你可以随时关闭。确定分享吗？'))return;
    setBusy(true);setError('');try{const p=await api<{url:string}>(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'POST',body:JSON.stringify({confirm:true})});setShare(new URL(p.url,window.location.origin).href);setPreview(old=>old?{...old,shared:true}:old);}catch(e){setError(e instanceof Error?e.message:'分享暂时没创建好。');}finally{setBusy(false);}
  }
  async function revoke(){setBusy(true);setError('');try{await api(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'DELETE'});setShare('');setPreview(old=>old?{...old,shared:false}:old);}catch(e){setError(e instanceof Error?e.message:'分享暂时没关闭。');}finally{setBusy(false);}}
  return <><section className="welcome-guide-card"><span className="welcome-guide-card-icon"><BookOpen size={24}/></span><div><strong>{title.replace(/\.(png|jpe?g|webp)$/i,'')}</strong><small>你的图文使用说明 · 可以展开、保存和分享</small></div><button ref={opener} type="button" onClick={()=>setOpen(true)}>打开看看 ↗</button></section>
    {open?<div className="welcome-guide-overlay" role="dialog" aria-modal="true" aria-label="ONE 使用说明" onKeyDown={e=>{if(e.key==='Escape')hide();}}><section className="welcome-guide-window"><header><strong>你的 ONE 使用说明</strong><div>{preview?<><button type="button" onClick={()=>download(new Blob([preview.html],{type:'text/html;charset=utf-8'}),preview.name)} disabled={busy}><Download size={15}/>保存网页</button><button type="button" onClick={()=>void poster()} disabled={busy}>保存大图</button><button type="button" onClick={()=>void publish()} disabled={busy}><Share2 size={15}/>{preview.shared?'创建新分享':'分享'}</button>{preview.shared?<button type="button" onClick={()=>void revoke()} disabled={busy}>关闭分享</button>:null}</>:null}<button ref={close} type="button" onClick={hide} aria-label="关闭使用说明"><X size={20}/></button></div></header>
      {share?<div className="welcome-guide-share"><span>链接 7 天有效</span><input aria-label="使用说明分享链接" value={share} readOnly/><button onClick={()=>void navigator.clipboard.writeText(share).catch(()=>setError('请选中链接后复制。'))}>复制链接</button></div>:null}
      {error?<p role="alert" className="welcome-guide-error">{error}</p>:null}
      {preview?<iframe title="你的 ONE 图文使用说明" sandbox="allow-downloads" src={`/api/welcome-pages/${encodeURIComponent(id)}/view`} referrerPolicy="no-referrer"/>:!error?<p className="welcome-guide-loading" role="status">在打开你的使用说明…</p>:<button onClick={()=>{setOpen(false);setTimeout(()=>setOpen(true),0);}}>重新打开</button>}
    </section></div>:null}
  </>;
}
