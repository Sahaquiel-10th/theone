import {useEffect,useId,useRef,useState} from 'react';
import {Check,Copy,ExternalLink,Link2,X} from 'lucide-react';
import {SHARE_LINK_FISSION_MS,shareLinkFissionFrame} from './shareLinkFission';
import './share-link-bubble.css';
export type ShareLinkReceipt={url:string;name:string;updated:boolean;fresh:boolean;sequence:number};
export function ShareLinkBubble({receipt,onDismiss,surfaceOwned=false,availability='active'}:{receipt:ShareLinkReceipt;onDismiss:()=>void;surfaceOwned?:boolean;availability?:'active'|'inactive'}) {
  const [frame,setFrame]=useState(()=>shareLinkFissionFrame(receipt.fresh?0:1)),[copied,setCopied]=useState(false),[error,setError]=useState('');
  const heading=useRef<HTMLHeadingElement>(null),titleId=useId();
  useEffect(()=>{if(!surfaceOwned)heading.current?.focus({preventScroll:true});},[surfaceOwned]);
  useEffect(()=>{const preference=window.matchMedia('(prefers-reduced-motion: reduce)');let raf=0;let start:number|undefined;const settle=()=>{cancelAnimationFrame(raf);setFrame(shareLinkFissionFrame(1));};const tick=(time:number)=>{start??=time;const progress=Math.min(1,(time-start)/SHARE_LINK_FISSION_MS);setFrame(shareLinkFissionFrame(progress));if(progress<1)raf=requestAnimationFrame(tick);};const change=()=>{if(preference.matches)settle();};if(surfaceOwned||!receipt.fresh||preference.matches)settle();else raf=requestAnimationFrame(tick);preference.addEventListener('change',change);return()=>{cancelAnimationFrame(raf);preference.removeEventListener('change',change);};},[receipt.sequence,receipt.fresh,surfaceOwned]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),1800);return()=>clearTimeout(timer);},[copied]);
  async function copy(){try{await navigator.clipboard.writeText(receipt.url);setError('');setCopied(true);}catch{setError('未能复制，请选中下面的链接手动复制。');}}
  const content=<div className={surfaceOwned?'share-link-owned-content':'share-link-child'} style={surfaceOwned?undefined:{transform:`translateX(${frame.offset}px)`}}>
      <header><h4 id={titleId} ref={heading} tabIndex={-1}><Link2 size={16}/>{receipt.name||'分身'}的分享链接</h4><button type="button" className="share-link-dismiss" aria-label="收起分享链接" onClick={onDismiss}><X size={16}/></button></header>
      <input readOnly aria-label="分享链接" value={receipt.url} onFocus={event=>event.currentTarget.select()}/>
      <footer><p role="status">{availability==='inactive'?'这份分享已关闭或到期，链接当前不能提供问答。':surfaceOwned?'链接属于这个分身。配置、使用范围与费用规则随该分身生效。':receipt.fresh?receipt.updated?'原链接已更新，历史消耗保留。':'分身已准备好，可以把链接分享给朋友。':'链接保留在分身列表里，随时可以找回。'}</p><div><button type="button" onClick={()=>void copy()}><span className={`share-copy-icon ${copied?'is-copied':''}`}>{copied?<Check size={14}/>:<Copy size={14}/>}</span>{copied?'已复制':'复制链接'}</button>{availability==='active'?<a href={receipt.url} target="_blank" rel="noopener noreferrer">打开<ExternalLink size={13}/></a>:<button type="button" disabled>链接已停用</button>}</div></footer>
      {error?<p className="share-link-error" role="alert">{error}</p>:null}
    </div>;
  if(surfaceOwned)return <section className="share-link-owned" aria-labelledby={titleId}>{content}</section>;
  return <section className="share-link-fission" aria-labelledby={titleId} data-share-link-state={frame.neck?'separating':'ready'}>
    <div className="share-link-origin" style={{transform:`translateX(${frame.sourcePressure}px)`}} aria-hidden="true"><span><Check size={23}/></span><small>{receipt.updated?'已更新':'已创建'}</small></div>
    <svg className="share-link-neck" viewBox="0 0 170 108" aria-hidden="true"><path d={frame.neck}/></svg>
    {content}
  </section>;
}
