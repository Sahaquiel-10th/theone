/** Local synthetic interaction model. Never used by production chat routes. */
export type Message = { id: string; role: 'user' | 'assistant'; text: string; files?:{id:string;originalName:string}[]; featureName?:string; instruction?: string; kind?: 'result'; status?: 'running' | 'queued' | 'held' | 'done' | 'cancelled' | 'failed'; taskId?: string };
export type Task = { id: string; title: string; messages: Message[]; active: string[]; queue: string[]; dueAt: number | null; round: number; status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped'; result: string; unread: boolean };
export type Notice = { id: string; taskId: string; summary: string };
export type PreviewState = { tasks: Task[]; dialogue: Message[]; pending: null | { id: string; text: string; target: string | null; dueAt: number; notices: string[] }; notices: Notice[]; selected: string | null; boundTask: string | null; lastTarget: string | null; draft: string; schedulerMs: number; workerMs: number; manual: boolean };
export type Action =
 | { type: 'draft'; text: string }
 | { type: 'submit'; text: string; id: string; now: number; feature?:{id:string;name:string}; features?:{id:string;name:string}[] }
 | { type: 'ack'; id: string; now: number }
 | { type: 'finish'; taskId: string; now: number; failed?: boolean; round?: number }
 | { type: 'retry'; taskId: string; now: number }
 | { type: 'select'; taskId: string | null }
 | { type: 'bind'; taskId: string | null }
 | { type: 'task-send'; taskId: string; text: string; id: string; now: number }
 | { type: 'report' }
 | { type: 'settings'; schedulerMs?: number; workerMs?: number; manual?: boolean }
 | { type: 'reset' };

export function initialPreview(): PreviewState {
 const task = (id: string, title: string): Task => ({ id, title, messages: [], active: [], queue: [], dueAt: null, round: 0, status: 'idle', result: '', unread: false });
 const ui = task('ui', 'ONE 的 UI 设计');
 ui.messages = [{ id: 'ui-history', role: 'user', text: '上次的 UI 先保留独立输入框，事情像便利贴一样展开。', status: 'done' }, { id: 'ui-history-reply', role: 'assistant', text: '上一版方向已记下。新的想法可以直接告诉 ONE。' }];
 return { tasks: [ui, task('camp', '明天的露营安排')], dialogue: [], pending: null, notices: [], selected: null, boundTask: null, lastTarget: null, draft: '', schedulerMs: 1500, workerMs: 18000, manual: false };
}

export function previewTarget(text: string, last: string | null): string | null {
 if (/UI|界面|输入框|按钮|设计|便利贴/i.test(text)) return 'ui';
 if (/露营|明天|小王|帐篷|营地/.test(text)) return 'camp';
 if (/补充|这一点|刚才|继续|再加|先记|停一下|停止|先停|执行暂存/.test(text)) return last;
 return null;
}

/** Bounded UI demo of a handoff instruction, not an AI-generated semantic summary. */
export function previewInstruction(text:string):string {
 return `任务要求：${text.trim().replace(/^(我想了一下[，,]?|我觉得[，,]?|帮我|请你|好像)/,'').trim()}`;
}

function start(task: Task, ids: string[], now: number, delay: number): Task {
 return { ...task, active: ids, queue: [], dueAt: now + delay, status: 'running', round: task.round + 1, messages: task.messages.map(m => ids.includes(m.id) ? { ...m, status: 'running' } : m) };
}

export function previewReducer(state: PreviewState, action: Action): PreviewState {
 if (action.type === 'reset') return initialPreview();
 if (action.type === 'draft') return { ...state, draft: action.text };
 if (action.type === 'settings') return { ...state, schedulerMs: action.schedulerMs ?? state.schedulerMs, workerMs: action.workerMs ?? state.workerMs, manual: action.manual ?? state.manual };
 if (action.type === 'retry') return retryPreviewTask(state, action.taskId, action.now);
 if (action.type === 'task-send') {
  if (!state.tasks.some(task=>task.id===action.taskId) || !action.text.trim() || state.tasks.some(task=>task.messages.some(message=>message.id===action.id))) return state;
  const routed = previewReducer({...state,pending:{id:action.id,text:action.text.trim(),target:action.taskId,dueAt:action.now,notices:[]}}, {type:'ack',id:action.id,now:action.now});
  // Direct task follow-ups do not become another coordinator conversation turn.
  return {...state,tasks:routed.tasks};
 }
 if (action.type === 'bind') return action.taskId === null || state.tasks.some(t => t.id === action.taskId) ? { ...state, boundTask: action.taskId } : state;
 if (action.type === 'select') return { ...state, selected: action.taskId, notices:state.notices.filter(notice=>notice.taskId!==action.taskId), tasks: state.tasks.map(t => t.id === action.taskId ? { ...t, unread: false } : t) };
 if (action.type === 'report') {
  if (state.pending || state.draft.trim() || !state.notices.length) return state;
  return { ...state, notices: [], dialogue: [...state.dialogue, ...state.notices.map(n => ({ id: `report-${n.id}`, role: 'assistant' as const, kind:'result' as const, text: n.summary, taskId: n.taskId }))] };
 }
 if (action.type === 'submit') {
  const text = action.text.trim();
  if (state.pending || !text || state.dialogue.some(m => m.id === action.id)) return state;
  const features=Array.from(new Map((action.features??(action.feature?[action.feature]:[])).map(feature=>[feature.id,feature])).values());
  const name=features.map(feature=>feature.name).join(' ＋ ');
  // One request, one task: selected capabilities compose rather than duplicating execution.
  const target=features.length?`feature:${features.map(feature=>feature.id).sort().join('+')}`:state.boundTask||previewTarget(text,state.lastTarget);
  const tasks=features.length&&!state.tasks.some(task=>task.id===target)?[...state.tasks,{id:target!,title:name,messages:[],active:[],queue:[],dueAt:null,round:0,status:'idle' as const,result:'',unread:false}]:state.tasks;
  return { ...state,tasks, draft: '', dialogue: [...state.dialogue, { id: action.id, role: 'user', text,featureName:name||undefined }], pending: { id: action.id, text, target, dueAt: action.now + state.schedulerMs, notices: [] } };
 }
 if (action.type === 'ack') {
  const pending = state.pending;
  if (!pending || pending.id !== action.id) return state;
  const notices = state.notices.filter(n => pending.notices.includes(n.id));
  let reply = /账单|查询|天气|搜索/.test(pending.text)?'这件事需要实际工具，现在这个本地预览还没有接入。我先不编结果。':'嗯，我在。这个想法先留在我们这里，接着说。';
  let tasks = state.tasks;
  if (pending.target) {
   const held = /先记|别改|不要执行/.test(pending.text);
   const stop = /停一下|停止|先停/.test(pending.text);
   const resume = /执行暂存/.test(pending.text);
   tasks = tasks.map(task => {
    if (task.id !== pending.target) return task;
    let next: Task = { ...task, messages: [...task.messages, { id: pending.id, role: 'user', text: pending.text, instruction: action.type==='ack' && state.dialogue.some(message=>message.id===pending.id) ? previewInstruction(pending.text) : pending.text, status: held ? 'held' : 'queued' }] };
    if (stop) {
     reply = `好，${task.title}先停下。原话和已有成果都保留。`;
     return { ...next, status: 'stopped', dueAt: null, active: [], queue: [], messages: next.messages.map(m => m.status === 'queued' || m.status === 'running' ? { ...m, status: 'cancelled' } : m) };
    }
    if (held) { reply = `这条记到${task.title}了，先不执行。`; return next; }
    const ids = [...task.queue, ...(resume ? task.messages.filter(m => m.status === 'held').map(m => m.id) : []), pending.id];
    next.queue = [...new Set(ids)];
    if (task.status === 'running') { reply = `补充收到，接到${task.title}。这一轮结束后一起处理。`; return next; }
    if (task.status === 'failed') { reply = `补充已经记下。${task.title}上一轮失败了，请先在任务里重试。`; return next; }
    reply = `好，交给${task.title}了。你可以接着说别的。`;
    return start(next, next.queue, action.now, state.workerMs);
   });
  }
  return { ...state, tasks, pending: null, lastTarget: pending.target || state.lastTarget, notices: state.notices.filter(n => !pending.notices.includes(n.id)), dialogue: [...state.dialogue, { id: `ack-${pending.id}`, role: 'assistant', text: reply, taskId: pending.target || undefined }, ...notices.map(n => ({ id: `report-${n.id}`, role: 'assistant' as const, kind:'result' as const, text: `另外，${n.summary}`, taskId: n.taskId }))] };
 }
 if (action.type === 'finish') {
  const task = state.tasks.find(t => t.id === action.taskId);
  if (!task || task.status !== 'running' || (action.round !== undefined && action.round !== task.round)) return state;
  const noticeId = `${task.id}-round-${task.round}`;
  const requirements = task.messages.filter(m => task.active.includes(m.id)).map(m => m.instruction || m.text);
  const summary = action.failed ? `${task.title}这轮没有完成，要求都还在。我们可以打开这件事重试。` : `${task.title}第 ${task.round} 版好了。${task.id==='ui'?'这一版保留独立输入框，让当前事情展开，其他事情安静收起。':task.id==='camp'?'先确认地点和天气，再准备交通、帐篷和同行人员。':'已经按选中的功能整理了一版演示结果。'}${task.queue.length?'你的补充也接住了，正在处理下一轮。':'细节留在这件事里，你随时可以接着改。'}`;
  const result = `第 ${task.round} 版 · 模拟成果\n\n本轮收到的要求：\n${requirements.map(s => `• ${s}`).join('\n')}\n\n${task.id === 'ui' ? '保留独立输入框；当前事情展开，其他事情收起。结果只出现在自己的任务里，不挤走当前内容。' : task.id==='camp'?'建议先确认地点与天气，再准备交通、帐篷、饮水与同行人员。这是合成演示，不是真实查询的行程。':`已用“${task.title}”承接这条消息。这是功能选用与独立任务衔接的模拟，不读取真实知识库，也不调用真实模型。`}`;
  let next: Task = action.failed ? { ...task, status: 'failed', dueAt: null, messages: task.messages.map(m => task.active.includes(m.id) ? { ...m, status: 'failed' } : m) } : { ...task, active: [], dueAt: null, status: 'completed', result, unread: true, messages: [...task.messages.map(m => task.active.includes(m.id) ? { ...m, status: 'done' as const } : m), { id: noticeId, role: 'assistant', text: result }] };
  if (!action.failed && task.queue.length) next = start(next, task.queue, action.now, state.workerMs);
  return { ...state, tasks: state.tasks.map(t => t.id === task.id ? next : t), notices: [...state.notices, { id: noticeId, taskId: task.id, summary }] };
 }
 return state;
}

export function retryPreviewTask(state: PreviewState, taskId: string, now: number): PreviewState {
 const task = state.tasks.find(t => t.id === taskId);
 if (!task || task.status !== 'failed') return state;
 const ids = [...new Set([...task.active, ...task.queue])];
 return { ...state, tasks: state.tasks.map(t => t.id === taskId ? start(t, ids, now, state.workerMs) : t) };
}
