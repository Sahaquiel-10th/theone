/** Messages are accepted only from the viewer's exact iframe by its owner. */
export function guideDraftText(raw:unknown):string|undefined{
 if(!raw||typeof raw!=='object')return;
 const value=raw as Record<string,unknown>;
 if(value.type!=='one-guide-draft'||value.version!==1||typeof value.text!=='string'||!value.text.trim()||value.text.length>2000||value.taskId!==undefined&&(typeof value.taskId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value.taskId)))return;
 return value.text.trim();
}
export function canReceiveGuideDraft(input:{text:string;attachments:number;features:number;mode:string}){
 return !input.text.trim()&&!input.attachments&&!input.features&&input.mode==='chat';
}
export function guideDraftFromMessage(event:{source:unknown;data:unknown},viewer:unknown):string|undefined{
 return viewer&&event.source===viewer?guideDraftText(event.data):undefined;
}
