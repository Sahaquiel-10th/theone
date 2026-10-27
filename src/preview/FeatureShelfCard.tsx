import {BadgeCheck,Check,Sparkles} from 'lucide-react';
import type {FeatureChoice} from './FeatureShelf';

/** A compact choice, with inspection and next-message selection kept distinct. */
export function FeatureShelfCard({feature,selected,inspecting,onInspect,onChoose}:{feature:FeatureChoice;selected:boolean;inspecting:boolean;onInspect:()=>void;onChoose:(feature:FeatureChoice,source:HTMLElement)=>void}) {
 const locked=feature.access==='locked';
 return <article className={`feature-shelf-card${selected?' is-selected':''}${inspecting?' is-inspecting':''}`} data-feature-id={feature.id} data-feature-access={feature.access||'free'} aria-label={`功能：${feature.name}`}>
  <header><span className="feature-shelf-symbol" aria-hidden="true"><Sparkles size={14}/></span><h3>{feature.name}</h3>{feature.author==='ONE'?<span className="feature-official-badge"><BadgeCheck size={12} aria-hidden="true"/>官方</span>:null}{locked?<span className="feature-shelf-access">未开通</span>:null}</header>
  <p className="feature-shelf-description">{feature.description}</p>
  <footer><button type="button" className="feature-detail-link" aria-label={`了解功能：${feature.name}`} aria-expanded={inspecting} onClick={onInspect}>查看详情 <span aria-hidden="true">↗</span></button><button type="button" className="feature-shelf-item" aria-label={locked?`了解开通：${feature.name}`:`${selected?'取消选择':'选择功能'}：${feature.name}`} aria-pressed={locked?undefined:selected} onClick={event=>locked?onInspect():onChoose(feature,event.currentTarget)}>{locked?'了解开通':selected?<><Check size={14}/>已选 · 取消</>:'下一条使用'}</button></footer>
 </article>;
}
