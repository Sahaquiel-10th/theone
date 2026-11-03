import {recoveryGuidance} from './recoveryGuidance';
import type {TaskRecovery} from './taskRecovery';
import type {TaskWorkflowView} from './taskWorkflowView';

export function TaskRecoveryGuidance({recovery,workflow,compact=false}:{recovery:TaskRecovery;workflow?:TaskWorkflowView;compact?:boolean}){
 const guide=recoveryGuidance({recovery,workflow});
 return <div className="task-recovery-guidance" data-recovery-mode={guide.automatic?'automatic':recovery.kind}>
  {guide.completed.length?<p><strong>已完成：</strong>{guide.completed.slice(-3).join('、')}{guide.completed.length>3?'等':''}。</p>:null}
  {guide.step?<p><strong>{guide.automatic?'正在处理：':'停在：'}</strong>{guide.step}</p>:null}
  <p>{guide.reason}</p>
  <p role="status"><strong>{guide.automatic?'不用操作。':'下一步：'}</strong>{guide.next}</p>
  {recovery.requestId&&/^(?:req|coord|work|status)_[A-Za-z0-9_-]{1,120}$/.test(recovery.requestId)?<small>问题编号：{recovery.requestId}</small>:null}
  {!compact&&guide.completed.length>3?<details><summary>查看全部已完成步骤</summary><ul>{guide.completed.map((title,index)=><li key={index}>{title}</li>)}</ul></details>:null}
 </div>;
}
