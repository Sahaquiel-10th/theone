import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {BookOpen,Download,Share2,X} from 'lucide-react';
import {api} from './oneApi';
import {confirmAction} from './ConfirmAction';
import {guideDraftFromMessage} from './guideDraft';

type Preview={html:string;name:string;shared:boolean;shareable?:boolean};
export function WelcomeShareButton({available,busy,shared,onClick}:{available:boolean;busy:boolean;shared:boolean;onClick:()=>void}){
  // Do not rely on hidden: layout CSS can override its browser display rule.
  return available?<button type="button" onClick={onClick} disabled={busy}><Share2 size={15}/>{shared?'创建新分享':'分享'}</button>:null;
}
function download(bytes:Blob,name:string){const url=URL.createObjectURL(bytes),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function WelcomeGuideCard({id,title,showShareAction=false,compact=false,caption,request=api}:{id:string;title:string;showShareAction?:boolean;compact?:boolean;caption?:string;request?:typeof api}){
  const [open,setOpen]=useState(false),[preview,setPreview]=useState<Preview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[share,setShare]=useState('');
  const close=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement>(null),viewer=useRef<HTMLDialogElement>(null),frame=useRef<HTMLIFrameElement>(null),sharing=useRef<AbortController|undefined>(undefined);
  const requestShare=useRef(false);
  // Task panes use transforms and clipping. Mount the viewer outside them so
  // fixed positioning always belongs to the viewport, not the selected task.
  useEffect(()=>{if(!open)return;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=overflow;};},[open]);
  useEffect(()=>{if(!open)return;const dialog=viewer.current!,previous=document.activeElement;dialog.showModal();close.current?.focus();return()=>{sharing.current?.abort();dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[open]);
  useEffect(()=>()=>sharing.current?.abort(),[]);
  useEffect(()=>{
    if(!open)return;
    const receive=(event:MessageEvent)=>{
      const text=guideDraftFromMessage(event,frame.current?.contentWindow);if(!text)return;
      const draft=new CustomEvent('one-welcome-guide-draft',{detail:{type:'one-guide-draft',version:1,text,...(event.data.taskId?{taskId:event.data.taskId}:{})},cancelable:true});
      // The exact viewer frame may prepare a draft; it cannot send messages.
      if(window.dispatchEvent(draft))hide();
      else setError('输入区已有草稿、附件或选定功能。请先保留或处理它们，再带入这句话；也可以直接选中示例复制。');
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[open,id]);
  useEffect(()=>{if(!open)return;close.current?.focus();let active=true;setError('');setPreview(undefined);setShare('');void request<Preview>(`/api/welcome-pages/${encodeURIComponent(id)}`).then(p=>{if(active){setPreview(p);if(requestShare.current){requestShare.current=false;if(p.shareable!==false)void publish();}}}).catch(e=>{if(active){requestShare.current=false;setError(e.message);}});return()=>{active=false;};},[open,id,request]);
  function hide(){sharing.current?.abort();setOpen(false);}
  async function poster(){setBusy(true);setError('');try{
    const p=await request<{svg:string;name:string;width:number;height:number}>(`/api/welcome-pages/${encodeURIComponent(id)}?format=poster`);
    const image=new window.Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('大图暂时没保存好，可以先保存网页。'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(p.svg);});const canvas=document.createElement('canvas');canvas.width=p.width;canvas.height=p.height;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法导出大图，可以先保存网页。');ctx.drawImage(image,0,0);const bytes=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));if(!bytes)throw new Error('大图暂时没保存好，可以先保存网页。');download(bytes,p.name.replace(/\.svg$/,'.png'));
  }catch(e){setError(e instanceof Error?e.message:'大图暂时没保存好。');}finally{setBusy(false);}}
  async function publish(){
    if(preview?.shareable===false)return;
    if(sharing.current)return;const controller=new AbortController();sharing.current=controller;
    try{if(!await confirmAction({title:'分享这份使用说明？',message:'拿到链接的人，可以查看整份说明。',details:['包括称呼、图片、用途、平台、选中资料的标题、示例要求和任务入口，以及文中提到的分身名称。','不含知识正文、文章或方案正文、完整聊天记录或本地文件；任务内容仍需登录原账号查看。','链接 7 天有效，随时可以关闭。'],confirmLabel:'创建分享链接',cancelLabel:'先不分享'},controller.signal)||controller.signal.aborted)return;
      setBusy(true);setError('');const p=await request<{url:string}>(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'POST',body:JSON.stringify({confirm:true})});if(!controller.signal.aborted){setShare(new URL(p.url,window.location.origin).href);setPreview(old=>old?{...old,shared:true}:old);}
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'分享暂时没创建好。');}finally{if(sharing.current===controller){sharing.current=undefined;setBusy(false);}}
  }
  async function revoke(){setBusy(true);setError('');try{await request(`/api/welcome-pages/${encodeURIComponent(id)}/share`,{method:'DELETE'});setShare('');setPreview(old=>old?{...old,shared:false}:old);}catch(e){setError(e instanceof Error?e.message:'分享暂时没关闭。');}finally{setBusy(false);}}
  return <><section className={`welcome-guide-card${compact?' welcome-guide-card-compact':''}`}><span className="welcome-guide-card-icon"><BookOpen size={compact?20:24}/></span><div><strong>{title.replace(/\.(png|jpe?g|webp|html|svg)$/i,'')}</strong><small>{caption??(compact?'可保存网页和大图':'图文成果 · 可以打开、放大和保存')}</small></div><button ref={opener} type="button" onClick={()=>{requestShare.current=false;setOpen(true);}}>{compact?'打开':'打开看看'} ↗</button>{showShareAction?<button type="button" className="welcome-guide-share-action" onClick={()=>{requestShare.current=true;setOpen(true);}}><Share2 size={15}/>分享</button>:null}</section>
    {open?createPortal(<dialog ref={viewer} className="welcome-guide-overlay welcome-guide-dialog" aria-label="ONE 使用说明" onCancel={e=>{e.preventDefault();hide();}}><section className="welcome-guide-window"><header><strong>{preview?.name.replace(/\.html$/i,'')||title.replace(/\.(html|png|jpe?g|webp)$/i,'')}</strong><div>{preview?<><button type="button" onClick={()=>download(new Blob([preview.html],{type:'text/html;charset=utf-8'}),preview.name)} disabled={busy}><Download size={15}/>保存网页</button><button type="button" onClick={()=>void poster()} disabled={busy}>保存流程图</button><WelcomeShareButton available={preview.shareable!==false} busy={busy} shared={preview.shared} onClick={()=>void publish()}/>{preview.shared?<button type="button" onClick={()=>void revoke()} disabled={busy}>关闭分享</button>:null}</>:null}<button ref={close} type="button" onClick={hide} aria-label="关闭使用说明"><X size={20}/></button></div></header>
      {share?<div className="welcome-guide-share"><span>链接 7 天有效</span><input aria-label="使用说明分享链接" value={share} readOnly/><button onClick={()=>void navigator.clipboard.writeText(share).catch(()=>setError('请选中链接后复制。'))}>复制链接</button></div>:null}
      {error?<p role="alert" className="welcome-guide-error">{error}</p>:null}
      {preview?<iframe ref={frame} title="你的 ONE 图文使用说明" sandbox="allow-downloads allow-scripts" src={`/api/welcome-pages/${encodeURIComponent(id)}/view`} referrerPolicy="no-referrer"/>:!error?<p className="welcome-guide-loading" role="status">在打开你的使用说明…</p>:<button onClick={()=>{setOpen(false);setTimeout(()=>setOpen(true),0);}}>重新打开</button>}
    </section></dialog>,document.body):null}
  </>;
}
