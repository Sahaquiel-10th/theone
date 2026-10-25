export type InitialTaskLinkState={opening:boolean;opened:boolean};

/** Models and coordinator state arrive independently. Do not consume a link
 * while the initial coordinator request is still deciding the routing mode. */
export function claimInitialTaskLink(state:InitialTaskLinkState,input:{modelsLoaded:boolean;demo:boolean;snapshotKnown:boolean}){
 if(state.opening||state.opened||!input.modelsLoaded||!input.demo&&!input.snapshotKnown)return false;
 state.opening=true;return true;
}
export function settleInitialTaskLink(state:InitialTaskLinkState,opened:boolean){state.opening=false;state.opened=opened;}

/** Viewing is a read, not a message, retry, resume or acknowledgement. The
 * actual detail reader also guards its cache against obsolete scope returns. */
export async function viewCoordinatorTask<T>(id:string|null,input:{isCurrent:()=>boolean;select:(id:string|null)=>void;load:(id:string)=>Promise<T>}):Promise<T|undefined>{
 if(!input.isCurrent())return;
 input.select(id);
 if(!id)return;
 const detail=await input.load(id);
 return input.isCurrent()?detail:undefined;
}

/** Linked historical tasks may be outside the current list page. Their live
 * details still replace the cached conversation used by the visible thread. */
export function coordinatorTaskConversation<T extends {id:string}>(conversation:T,details:Readonly<Record<string,{conversation:T}>>):T{
 const current=details[conversation.id]?.conversation;
 return current?{...current,messagesLoaded:true}:conversation;
}
