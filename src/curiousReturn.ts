type ReturnMark={sessionId:string;at:number};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const key=(userId:string,workspaceId:string)=>`one-curious-return:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
export function saveCuriousReturn(storage:StorageLike,userId:string,workspaceId:string,sessionId:string,now=Date.now()){
  try{storage.setItem(key(userId,workspaceId),JSON.stringify({sessionId,at:now}));}catch{/* Server still retains the conversation. */}
}
export function readCuriousReturn(storage:StorageLike,userId:string,workspaceId:string,now=Date.now()):ReturnMark|undefined{
  try{const value=JSON.parse(storage.getItem(key(userId,workspaceId))??'null');if(value&&typeof value.sessionId==='string'&&Number.isFinite(value.at)&&now>=value.at&&now-value.at<2*60*60*1000)return value;}catch{/* Optional navigation hint only. */}
}
export function clearCuriousReturn(storage:StorageLike,userId:string,workspaceId:string){try{storage.removeItem(key(userId,workspaceId));}catch{}}
