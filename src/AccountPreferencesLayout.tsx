import type {ReactNode} from 'react';
import {BookOpen,Monitor,UserRound,Wallet} from 'lucide-react';
export const preferenceSections=[{id:'profile',label:'外观与偏好',hint:'工作台、称呼与使用说明',icon:UserRound},{id:'device',label:'本机执行',hint:'工作区与执行工具',icon:Monitor},{id:'knowledge',label:'连接与授权',hint:'知识来源与访问权限',icon:BookOpen},{id:'power',label:'会员与额度',hint:'查看电力与使用记录',icon:Wallet}];
export function AccountPreferencesLayout({section,onChange,children}:{section:string;onChange:(section:string)=>void;children:ReactNode}){
  return <div className="account-preferences-layout"><nav className="account-preferences-nav" aria-label="设置栏目">{preferenceSections.map(({id,label,hint,icon:Icon})=><button type="button" key={id} aria-current={section===id?'page':undefined} aria-pressed={section===id} onClick={()=>onChange(id)}><Icon size={18}/><span><strong>{label}</strong><small>{hint}</small></span></button>)}</nav><div className="account-body settings-account-body account-preferences-content">{children}</div></div>;
}
