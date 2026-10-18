import {createRoot} from 'react-dom/client';
import {SettingsDialog} from './SettingsControls';

export type Confirmation={title:string;message:string;details?:string[];confirmLabel?:string;cancelLabel?:string;danger?:boolean};
/** A page-owned, keyboard-accessible confirmation. No API or side effect until accepted. */
export function ConfirmationContent({value,onFinish}:{value:Confirmation;onFinish:(accepted:boolean)=>void}){
  return <><p className="confirmation-message">{value.message}</p>{value.details?.length?<ul className="confirmation-details">{value.details.map((line,i)=><li key={i}>{line}</li>)}</ul>:null}<div className="confirmation-actions"><button type="button" className="secondary" data-dialog-focus onClick={()=>onFinish(false)}>{value.cancelLabel??'取消'}</button><button type="button" className={value.danger?'primary confirmation-danger':'primary'} onClick={()=>onFinish(true)}>{value.confirmLabel??'确认'}</button></div></>;
}
let pending:Promise<unknown>=Promise.resolve();
export function confirmAction(value:Confirmation,signal?:AbortSignal):Promise<boolean>{
  const show=()=>new Promise<boolean>(resolve=>{
    if(signal?.aborted){resolve(false);return;}
    const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);let settled=false;
    const cancel=()=>finish(false);
    const finish=(accepted:boolean)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);root.unmount();host.remove();resolve(accepted);};
    signal?.addEventListener('abort',cancel,{once:true});
    root.render(<SettingsDialog title={value.title} className="one-confirmation-dialog" onClose={()=>finish(false)}><ConfirmationContent value={value} onFinish={finish}/></SettingsDialog>);
  });
  const result=pending.then(show,show);pending=result.catch(()=>false);return result;
}
