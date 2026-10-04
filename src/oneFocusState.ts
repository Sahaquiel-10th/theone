/** Waiting belongs to a turn, never to the global assistant or another task. */
export function waitingForCurrentReply(loading:boolean,messages:readonly {role:string;content:string}[]){
  if(!loading)return false;
  let start=-1;for(let i=messages.length-1;i>=0;i--)if(messages[i].role==='user'){start=i;break;}
  return start>=0&&!messages.slice(start+1).some(m=>m.role==='assistant'&&m.content.trim());
}
export function canPeekAtFeatures(idle:boolean,busy:boolean,draft:string){return idle&&!busy&&!draft.trim();}
