import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {BookOpen,Download,Share2,X} from 'lucide-react';
import {api} from './oneApi';

type Preview={html:string;name:string;shared:boolean;shareable?:boolean};
function download(bytes:Blob,name:string){const url=URL.createObjectURL(bytes),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function WelcomeGuideCard({id,title,showShareAction=false}:{id:string;title:string;showShareAction?:boolean}){
  const [open,setOpen]=useState(false),[preview,setPreview]=useState<Preview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[share,setShare]=useState('');
  const close=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement>(null);
  const requestShare=useRef(false);
  // Task panes use transforms and clipping. Mount the viewer outside them so
  // fixed positioning always belongs to the viewport, not the selected task.
  useEffect(()=>{if(!open)return;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=overflow;};},[open]);
  useEffect(()=>{if(!open)return;close.current?.focus();let active=true;setError('');void api<Preview>(`/api/welcome-pages/${encodeURIComponent(id)}`).then(p=>{if(active){setPreview(p);if(requestShare.current){requestShare.current=false;if(p.shareable!==false)void publish();}}}).catch(e=>{if(active){requestShare.current=false;setError(e.message);}});return()=>{active=false;};},[open,id]);
  function hide(){setOpen(false);opener.current?.focus();}
  async function poster(){setBusy(true);setError('');try{
    const p=await api<{svg:string;name:string;width:number;height:number}>(`/api/welcome-pages/${encodeURIComponent(id)}?format=poster`);
    const image=new window.Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('大图暂时没保存好，可以先保存网页。'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(p.svg);});const canvas=document.createElement('canvas');canvas.width=p.width;canvas.height=p.height;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法导出大图，可以先保存网页。');ctx.drawImage(image,0,0);const bytes=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));if(!bytes)throw new Error('大图暂时没保存好，可以先保存网页。');download(bytes,p.name.replace(/\.svg$/,'.png'));
  }catch(e){setError(e instanceof Error?e.message:'大图暂时没保存好。');}finally{setBusy(false);}}
  async function publish(){
    if(!window.confirm('创建分享链接后，拿到链接的人能看到整份使用说明，包括称呼、图片、用途、已连接平台和文中提到的分身名称。不含知识正文、聊天记录或本地文件。链接 7 天有效，你可以随时关闭。确定分享吗？'))return;
    setBusy(true);setError('');try{const p=await api<{url:string}>(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'POST',body:JSON.stringify({confirm:true})});setShare(new URL(p.url,window.location.origin).href);setPreview(old=>old?{...old,shared:true}:old);}catch(e){setError(e instanceof Error?e.message:'分享暂时没创建好。');}finally{setBusy(false);}
  }
  async function revoke(){setBusy(true);setError('');try{await api(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'DELETE'});setShare('');setPreview(old=>old?{...old,shared:false}:old);}catch(e){setError(e instanceof Error?e.message:'分享暂时没关闭。');}finally{setBusy(false);}}
  return <><section className="welcome-guide-card"><span className="welcome-guide-card-icon"><BookOpen size={24}/></span><div><strong>{title.replace(/\.(png|jpe?g|webp|html|svg)$/i,'')}</strong><small>你的图文使用说明 · 可以展开、保存和分享</small></div><button ref={opener} type="button" onClick={()=>{requestShare.current=false;setOpen(true);}}>打开看看 ↗</button>{showShareAction?<button type="button" onClick={()=>{requestShare.current=true;setOpen(true);}}><Share2 size={15}/>分享</button>:null}</section>
    {open?createPortal(<div className="welcome-guide-overlay" role="dialog" aria-modal="true" aria-label="ONE 使用说明" onKeyDown={e=>{if(e.key==='Escape')hide();}}><section className="welcome-guide-window"><header><strong>{preview?.name.replace(/\.html$/i,'')||title.replace(/\.(html|png|jpe?g|webp)$/i,'')}</strong><div>{preview?<><button type="button" onClick={()=>download(new Blob([preview.html],{type:'text/html;charset=utf-8'}),preview.name)} disabled={busy}><Download size={15}/>保存网页</button><button type="button" onClick={()=>void poster()} disabled={busy}>保存流程图</button><button type="button" hidden={preview.shareable===false} onClick={()=>void publish()} disabled={busy}><Share2 size={15}/>{preview.shared?'创建新分享':'分享'}</button>{preview.shared?<button type="button" onClick={()=>void revoke()} disabled={busy}>关闭分享</button>:null}</>:null}<button ref={close} type="button" onClick={hide} aria-label="关闭使用说明"><X size={20}/></button></div></header>
      {share?<div className="welcome-guide-share"><span>链接 7 天有效</span><input aria-label="使用说明分享链接" value={share} readOnly/><button onClick={()=>void navigator.clipboard.writeText(share).catch(()=>setError('请选中链接后复制。'))}>复制链接</button></div>:null}
      {error?<p role="alert" className="welcome-guide-error">{error}</p>:null}
      {preview?<iframe title="你的 ONE 图文使用说明" sandbox="allow-downloads allow-scripts" src={`/api/welcome-pages/${encodeURIComponent(id)}/view`} referrerPolicy="no-referrer"/>:!error?<p className="welcome-guide-loading" role="status">在打开你的使用说明…</p>:<button onClick={()=>{setOpen(false);setTimeout(()=>setOpen(true),0);}}>重新打开</button>}
    </section></div>,document.body):null}
  </>;
}
