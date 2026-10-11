import type {FeatureExperience} from '../server/featureExperience';
type Experience=Omit<FeatureExperience,'actions'>&{actions:{id:string;label:string}[]};
export function featureDefaults(experience?:Experience){return Object.fromEntries(experience?.inputs.filter(f=>f.default!==undefined).map(f=>[f.id,f.default!])??[]);}
export function FeatureOptions({experience,value,onChange,disabled=false}:{experience?:Experience;value:Record<string,string|number|boolean>;onChange:(v:Record<string,string|number|boolean>)=>void;disabled?:boolean}){
 if(!experience?.inputs.length)return null;
 return <fieldset disabled={disabled} className="feature-options"><legend>这次怎么做</legend>{experience.inputs.map(f=>{
 const v=value[f.id]??f.default??(f.type==='checkbox'?false:'');const change=(next:string|number|boolean)=>onChange({...value,[f.id]:next});
 return <label key={f.id} className={f.type==='checkbox'?'sharing-check':''}>{f.type==='checkbox'?<><input type="checkbox" checked={v===true} onChange={e=>change(e.target.checked)}/>{f.label}</>:<>{f.label}{f.required?' *':''}{f.type==='select'?<select value={String(v)} onChange={e=>change(e.target.value)}>{!f.default?<option value="">请选择</option>:null}{f.options?.map(o=><option key={o}>{o}</option>)}</select>:<input type={f.type==='number'?'number':'text'} min={f.min} max={f.max} maxLength={1500} placeholder={f.placeholder} value={typeof v==='boolean'?'':v} onChange={e=>change(f.type==='number'&&e.target.value!==''?Number(e.target.value):e.target.value)}/>}</>}</label>;
 })}</fieldset>;
}
