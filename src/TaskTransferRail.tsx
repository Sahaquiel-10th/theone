import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,Loader2,AlertCircle,ChevronDown,Clock3,X} from 'lucide-react';
import {transferStateLabel} from './noviceUx';
import {reportedCardTransitions,departingCardTransitions} from './taskTransferLifecycle';
import {flyTaskNote,type NoteRect} from './taskTransferMotion';
import {TaskReadAllButton} from './TaskReadAllButton';

export type Transfer={id:string;taskId:string;title:string;state:string;updatedAt?:string;reported?:boolean;read?:boolean;reportable?:boolean;outcome?:string;phase?:string;local?:boolean};
export const transferSettled=(state:string)=>['completed','returned','partial','needs_input','failed','interrupted','cancelled'].includes(state);
export const transferNeedsRecovery=(task:Transfer)=>transferSettled(task.state)&&!['completed','returned'].includes(task.outcome||task.state);
export const latestTransferNotes=(tasks:Transfer[])=>[...tasks].reverse().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5);
/** Capture only the rendered task's receipts, never a result arriving later. */
export const dismissibleReceiptIds=(tasks:Transfer[],taskId:string)=>tasks.filter(task=>task.taskId===taskId&&transferSettled(task.state)&&task.reportable!==false).map(task=>task.id);
/** Pending outcome IDs are for server capture, never an automatic client report trigger. */
export const newAutomaticReceiptIds=(tasks:Transfer[])=>tasks.filter(t=>transferSettled(t.state)&&!t.reported&&t.reportable!==false).map(t=>t.id);
export function visibleTransfers(tasks:Transfer[]) {
  const grouped=new Map<string,Transfer>();
  for(const task of tasks){
    if(transferSettled(task.state)&&(task.reported||task.read))continue;
    const previous=grouped.get(task.taskId);
    if(!previous||transferSettled(previous.state)||!transferSettled(task.state))grouped.set(task.taskId,task);
  }
  return [...grouped.values()];
}
/** Only the exact returning round is cached. A newer round for that task remains untouched. */
export function presentationTransfers(tasks:Transfer[],delivered:Set<string>,returning:Transfer[]) {
  const current=visibleTransfers(tasks).filter(task=>!delivered.has(task.id)),currentTasks=new Set(current.map(task=>task.taskId));
  return [...current,...visibleTransfers(returning).filter(task=>!currentTasks.has(task.taskId))];
}
export function transferFeedbackLabel(task:Transfer) {
  // A phase can belong to the last active step. It must not hide a newer
  // pause, permission request or unsuccessful result.
  if(task.state==='paused')return '已暂停';
  if(task.state==='cancelled'||task.outcome==='cancelled')return '已停止';
  if(task.state==='waiting')return '等待前一步完成';
  if(task.state==='prepared_local')return '等待确认本机执行';
  if(task.state==='reconciling')return task.phase||'正在核对保存结果';
  if(task.outcome==='needs_input'||task.state==='needs_input')return '需要你补充信息';
  if(task.outcome==='partial'||task.state==='partial')return '已有部分结果，需要核对';
  if(task.outcome==='failed'||task.state==='failed')return '未完成，查看原因';
  if(task.outcome==='interrupted'||task.state==='interrupted')return '结果待核对';
  if(task.state==='returned')return '结果已返回，查看内容';
  if(task.state==='completed')return '已完成';
  if(task.phase)return task.phase;
  return transferStateLabel(task.state);
}
function TransferStateIcon({task}:{task:Transfer}) {
  const outcome=task.outcome||task.state;
  if(['completed','returned'].includes(task.state)&&['completed','returned'].includes(outcome))return <Check size={14} aria-hidden="true"/>;
  if(transferSettled(task.state)||['paused','prepared_local','selecting_target'].includes(task.state))return <AlertCircle size={14} aria-hidden="true"/>;
  if(['queued','waiting'].includes(task.state))return <Clock3 size={14} aria-hidden="true"/>;
  return <Loader2 size={14} className="task-transfer-spinner" aria-hidden="true"/>;
}
type RailProps={tasks:Transfer[];busy:boolean;onOpen:(id:string)=>void;onOpenAll?:()=>void;onStop?:(task:Transfer,source:HTMLElement)=>Promise<void>;onReport?:(ids:string[])=>Promise<boolean|void>;onReadAll?:()=>Promise<void>;onDismiss?:(task:Transfer)=>Promise<void>;recentReportedReceiptIds?:string[];departureAnchor?:()=>HTMLElement|null;returnAnchor?:()=>HTMLElement|null;animateNotes?:boolean};
type CardGeometry={node:HTMLElement;rect:NoteRect};

/** Notes return only after the outcome reached the main dialogue. Motion never executes work or marks it read. */
export function TaskTransferRail({tasks,busy,onOpen,onOpenAll,onStop,onReadAll,onDismiss,recentReportedReceiptIds=[],departureAnchor,returnAnchor,animateNotes=true}:RailProps) {
  const [returning,setReturning]=useState<Transfer[]>([]),[departing,setDeparting]=useState<string[]>([]),[expanded,setExpanded]=useState(true);
  const [stopping,setStopping]=useState<string[]>([]),[stopError,setStopError]=useState(''),[readError,setReadError]=useState('');
  const previous=useRef<Map<string,Transfer>|null>(null),returned=useRef(new Set<string>()),rail=useRef<HTMLElement>(null);
  const nodes=useRef(new Map<string,HTMLElement>()),geometry=useRef(new Map<string,CardGeometry>()),animations=useRef(new Map<string,()=>void>());
  const live=useRef(true),anchors=useRef({departureAnchor,returnAnchor});anchors.current={departureAnchor,returnAnchor};
  const capturedReturns=reportedCardTransitions(previous.current,tasks,recentReportedReceiptIds).filter(task=>!returned.current.has(task.id));
  const returningCards=[...new Map([...returning,...capturedReturns].map(task=>[task.id,{...task,reported:false}])).values()];
  const visible=presentationTransfers(tasks,returned.current,returningCards),notes=latestTransferNotes(visible);
  const rememberNode=(id:string,node:HTMLElement|null)=>{
    const current=node||nodes.current.get(id);
    if(current){const rect=current.getBoundingClientRect();if(rect.width&&rect.height)geometry.current.set(id,{node:current,rect});}
    if(node)nodes.current.set(id,node);else nodes.current.delete(id);
  };
  useEffect(()=>{live.current=true;return()=>{live.current=false;for(const cancel of animations.current.values())cancel();animations.current.clear();};},[]);
  useLayoutEffect(()=>{
    const before=previous.current,departures=departingCardTransitions(before,tasks);
    const returns=reportedCardTransitions(before,tasks,recentReportedReceiptIds).filter(task=>!returned.current.has(task.id));
    previous.current=new Map(tasks.map(task=>[task.id,task]));
    if(returns.length)setReturning(old=>[...new Map([...old,...returns.map(task=>({...task,reported:false}))].map(task=>[task.id,task])).values()]);
    if(departures.length)setDeparting(old=>[...new Set([...old,...departures.map(task=>task.id)])]);
    const header=rail.current?.querySelector<HTMLElement>('.task-transfer-heading');
    const anchor=(direction:'depart'|'return')=>(direction==='depart'?anchors.current.departureAnchor?.():anchors.current.returnAnchor?.())||document.querySelector<HTMLElement>(direction==='depart'?'[data-task-dispatch-anchor]':'[data-task-return-anchor]');
    const start=(task:Transfer,direction:'depart'|'return',index:number)=>{
      if(direction==='return')returned.current.add(task.id);
      const key=`${direction}:${task.id}`;
      const current=nodes.current.get(task.id),cached=geometry.current.get(task.id),node=current||cached?.node||header;
      const target=anchor(direction),rect=current?.getBoundingClientRect()||cached?.rect||header?.getBoundingClientRect();
      const finish=()=>{
        animations.current.delete(key);
        if(!live.current)return;
        if(direction==='return')setReturning(old=>old.filter(item=>item.id!==task.id));
        else setDeparting(old=>old.filter(id=>id!==task.id));
      };
      if(!animateNotes||!node||!target||!rect){queueMicrotask(finish);return;}
      animations.current.set(key,flyTaskNote(node,direction==='depart'?target.getBoundingClientRect():rect,direction==='depart'?rect:target.getBoundingClientRect(),direction,finish,index*70));
    };
    departures.forEach((task,index)=>start(task,'depart',index));
    returns.forEach((task,index)=>start(task,'return',index));
  },[tasks,recentReportedReceiptIds,animateNotes]);
  if(!visible.length)return null;
  const feedbackCount=new Set(visible.filter(task=>transferSettled(task.state)).map(task=>task.taskId)).size;
  const unreadCount=visible.filter(task=>transferSettled(task.state)&&task.read!==true).length;
  return <aside ref={rail} className="task-transfer-rail task-rail-clarity" aria-label="任务动态">
    <button type="button" className="task-transfer-bubble task-transfer-heading" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>
      <strong>{visible.length} 项任务</strong><ChevronDown size={14} aria-hidden="true"/>
    </button>
    {onReadAll&&feedbackCount?<TaskReadAllButton count={unreadCount} onReadAll={onReadAll}/> : null}
    {expanded?notes.map(task=><div className="task-transfer-row" data-task-transfer-id={task.taskId} data-task-receipt-id={task.id} key={task.id}>
      <button ref={node=>rememberNode(task.id,node)} type="button" className={`task-transfer-bubble ${returningCards.some(item=>item.id===task.id)?'is-returning':''} ${departing.includes(task.id)?'is-departing':''} ${transferSettled(task.state)?'is-settled':''}`} onClick={()=>onOpen(task.taskId)}>
        <TransferStateIcon task={task}/>
        <span><strong>{task.title}</strong><small>{transferFeedbackLabel(task)}</small></span><ArrowUpRight size={12} aria-hidden="true"/>
      </button>
      {(transferNeedsRecovery(task)||transferSettled(task.state)&&onDismiss||task.state==='paused'||task.state==='prepared_local'||!transferSettled(task.state)&&onStop)?<div className="task-transfer-actions">
        {transferNeedsRecovery(task)?<button type="button" className="task-transfer-more task-retry-action" title="打开任务详情，核对结果后再决定是否继续" onClick={()=>onOpen(task.taskId)}>查看并处理</button>:null}
        {transferSettled(task.state)&&onDismiss?<button type="button" className="task-transfer-more task-dismiss-action" aria-label={`收起${task.title}的提醒`} title="只收起提醒，不删除任务或文件" onClick={()=>{setReadError('');void onDismiss(task).catch(()=>setReadError('暂时没能收起提醒，请再试一次'));}}>{transferNeedsRecovery(task)?'收起提醒':<X size={12} aria-hidden="true"/>}</button>:null}
        {task.state==='paused'||task.state==='prepared_local'?<button type="button" className="task-transfer-more task-retry-action" onClick={()=>onOpen(task.taskId)}>{task.state==='prepared_local'?'查看并确认':'查看并处理'}</button>:null}
        {!transferSettled(task.state)&&onStop?<button type="button" className="task-transfer-more task-stop-action" aria-label={`停止任务：${task.title}`} disabled={stopping.includes(task.id)} onClick={event=>{const source=event.currentTarget;setStopError('');setStopping(old=>[...old,task.id]);void onStop(task,source).catch(()=>setStopError('尚未确认任务已停止，请打开任务查看状态，或重试停止')).finally(()=>setStopping(old=>old.filter(id=>id!==task.id)));}}>{stopping.includes(task.id)?'正在停止':'停止任务'}</button>:null}
      </div>:null}
    </div>):null}
    {stopError?<small role="alert">{stopError}</small>:null}
    {expanded&&visible.length>5&&onOpenAll?<button type="button" className="task-transfer-more" onClick={onOpenAll}>另有 {visible.length-5} 件 · 查看全部任务</button>:null}
    {readError?<small role="alert">{readError}</small>:null}
  </aside>;
}
