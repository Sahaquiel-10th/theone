/** Visual waiting feedback, not a measurement of work completed. Never reaches full before a result. */
export function waitingProgress(elapsedMs:number,previous=0) {
  const seconds=Math.max(0,elapsedMs)/1000;
  const paced=3+72*(1-Math.exp(-seconds/30))+21*(1-Math.exp(-seconds/160));
  return Math.min(96,Math.max(previous,paced));
}
export function receiptMayBeMissing(sending:boolean,serverOperation:string|undefined,operation:string){
  return !sending && serverOperation!==operation;
}
