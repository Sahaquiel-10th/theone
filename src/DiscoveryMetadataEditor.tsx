import type {DiscoveryMetadata} from '../server/discoveryMetadata';
import {useEffect,useState} from 'react';

const parseTags=(text:string)=>text.split(/[,，、;；\n]/).map(item=>item.trim()).filter(Boolean);
function TagsInput({value=[],onChange,disabled,placeholder}:{value?:string[];onChange:(items:string[])=>void;disabled:boolean;placeholder:string}) {
  const [text,setText]=useState(value.join('，'));
  useEffect(()=>{if(JSON.stringify(parseTags(text))!==JSON.stringify(value))setText(value.join('，'));},[value]);
  return <input disabled={disabled} value={text} maxLength={730} placeholder={placeholder} onChange={event=>{setText(event.target.value);onChange(parseTags(event.target.value));}}/>;
}

export function DiscoveryMetadataEditor({value,onChange,disabled=false}:{value?:DiscoveryMetadata;onChange:(value:DiscoveryMetadata)=>void;disabled?:boolean}) {
  return <details><summary>调度如何找到这个能力</summary>
    <p className="hint">用途填写在“什么时候用”。这里补充可跨分类匹配的关键词，不会增加权限；发布后生效。</p>
    {([['industries','适用行业','例如：宠物、餐饮；通用能力可留空'],['scenarios','适用场景','例如：开业促销、会议准备、客户跟进'],['aliases','常用叫法','例如：攻略、导览、使用手册']] as const).map(([key,label,placeholder])=><label key={key}>{label}<TagsInput disabled={disabled} value={value?.[key]} placeholder={placeholder} onChange={items=>onChange({...value,[key]:items})}/></label>)}
    <label>什么情况不适用<textarea disabled={disabled} rows={2} maxLength={500} value={value?.avoidWhen??''} placeholder="例如：一句话就能回答的问题，不必生成网页" onChange={event=>onChange({...value,avoidWhen:event.target.value})}/></label>
  </details>;
}
