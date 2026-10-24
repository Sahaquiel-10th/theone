import {Check,Sparkles} from 'lucide-react';
import type {FeatureChoice} from './FeatureShelf';

/** A compact choice, with inspection and next-message selection kept distinct. */
export function FeatureShelfCard({feature,selected,inspecting,onInspect,onChoose}:{feature:FeatureChoice;selected:boolean;inspecting:boolean;onInspect:()=>void;onChoose:(feature:FeatureChoice,source:HTMLElement)=>void}) {
 const locked=feature.access==='locked';
 return <article className={`feature-shelf-card${selected?' is-selected':''}${inspecting?' is-inspecting':''}`} data-feature-id={feature.id} data-feature-access={feature.access||'free'} aria-label={`功能：${feature.name}`}>
  <header><span className="feature-shelf-symbol" aria-hidden="true"><Sparkles size={14}/></span><h3>{feature.name}</h3><span className="feature-shelf-access">{feature.access==='purchased'?'已购':feature.access==='enterprise'?'企业已开通':locked?'未开通':'可使用'}</span></header>
  <p className="feature-shelf-description">{feature.description}</p>
  <div className="feature-cost"><span>{feature.purchaseLabel||'已为你开放'}</span><small>{feature.author==='ONE'?'ONE 官方':feature.author||'精选'} · <span title="仅对本功能实际用量计费">{feature.usageMultiplier??.6} 倍</span> · 按实际用量扣除</small></div>
  <footer><button type="button" className="feature-detail-link" aria-label={`了解功能：${feature.name}`} aria-expanded={inspecting} onClick={onInspect}>详情与运行 <span aria-hidden="true">↗</span></button><button type="button" className="feature-shelf-item" aria-label={locked?`了解开通：${feature.name}`:`${selected?'取消选择':'选择功能'}：${feature.name}`} aria-pressed={locked?undefined:selected} onClick={event=>locked?onInspect():onChoose(feature,event.currentTarget)}>{locked?'了解开通':selected?<><Check size={14}/>已选 · 取消</>:'下一条使用'}</button></footer>
 </article>;
}
