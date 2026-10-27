/** Elapsed wall time is useful context; it is never a completion estimate. */
export function responseElapsedSeconds(startedAt:string|undefined,now:number):number|null {
  if(!startedAt||!Number.isFinite(now))return null;
  const started=Date.parse(startedAt);
  if(!Number.isFinite(started))return null;
  return Math.max(0,Math.floor((now-started)/1000));
}
export function responseWaitLabel(seconds:number|null) {
  if(seconds===null||!Number.isFinite(seconds)||seconds<10)return '';
  const whole=Math.floor(seconds),minutes=Math.floor(whole/60),remaining=whole%60;
  return minutes?`已等待 ${minutes} 分 ${remaining} 秒`:`已等待 ${whole} 秒`;
}
export function receiptMayBeMissing(sending:boolean,serverOperation:string|undefined,operation:string){
  return !sending && serverOperation!==operation;
}
