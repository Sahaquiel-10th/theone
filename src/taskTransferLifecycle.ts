export type ReceiptCard = {id:string;taskId:string;state:string;reported?:boolean;reportable?:boolean};
const settled=(state:string)=>['completed','returned','partial','needs_input','failed','interrupted','cancelled'].includes(state);

/** A disappeared task is not evidence that the dispatcher received its outcome. */
export function reportedCardTransitions<T extends ReceiptCard>(previous:Map<string,T>|null,current:T[],reportedIds:string[]=[]):T[] {
  if(!previous)return [];
  const next=new Map(current.map(card=>[card.id,card])),confirmed=new Set(reportedIds);
  const returned=[...previous.values()].filter(card=>settled(card.state)&&!card.reported&&card.reportable!==false&&(next.get(card.id)?.reported===true||confirmed.has(card.id)));
  // A short task can finish AND be reported between two polls. Its work card
  // and result have different IDs; only the server-confirmed result may return.
  for(const card of current){
    if(!settled(card.state)||card.reportable===false||!card.reported||previous.has(card.id))continue;
    if([...previous.values()].some(before=>before.taskId===card.taskId&&!settled(before.state)))returned.push(card);
  }
  return [...new Map(returned.map(card=>[card.id,card])).values()];
}
/** Existing cards restored on initial load do not replay their dispatch animation. */
export function departingCardTransitions<T extends ReceiptCard>(previous:Map<string,T>|null,current:T[]):T[] {
  if(!previous)return [];
  return current.filter(card=>!settled(card.state)&&!previous.has(card.id));
}
/** Read receipts are captured server-side. Newer results and their report status stay unchanged. */
export function applyReviewedReceipts<T extends {id:string;read?:boolean;reported?:boolean}>(notices:T[],ids:string[]):T[] {
  const selected=new Set(ids);
  return notices.map(notice=>selected.has(notice.id)?{...notice,read:true}:notice).filter(notice=>!notice.read||!notice.reported);
}
