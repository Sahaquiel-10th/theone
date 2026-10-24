/** A short, finite fission: the link keeps its full size while a material neck thins. */
export const SHARE_LINK_FISSION_MS=1080;
const clamp=(value:number)=>Math.max(0,Math.min(1,value));
const smooth=(value:number,start=0,end=1)=>{const t=clamp((value-start)/(end-start));return t*t*(3-2*t);};
const number=(...values:number[])=>values.map(value=>Number(value.toFixed(3))).join(' ');
export function shareLinkFissionFrame(progress:number) {
  const p=clamp(Number.isFinite(progress)?progress:1);
  const travel=smooth(p,0,.76),settle=clamp((p-.76)/.24);
  const offset=-42*(1-travel)+2.3*Math.sin(Math.PI*settle)*(1-settle);
  if(p>=.88)return {offset,neck:'',sourcePressure:0};
  const start=75,end=112+offset,center=(start+end)/2,cy=54;
  const retract=smooth(p,.76,.88),span=23*(1-retract);
  const half=(22*(1-smooth(p,.12,.73))+.14)*(1-retract);
  const split=(-2+(end-start)*.86)*smooth(p,.73,.82);
  const left=center-split/2,right=center+split/2,cap=Math.min(.7,half*.5);
  const neck=[`M ${number(start,cy-span)}`,`C ${number(start,cy-span*.36,left-(left-start)*.45,cy-half,left,cy-half)}`,`C ${number(left+cap,cy-half,left+cap,cy+half,left,cy+half)}`,`C ${number(left-(left-start)*.45,cy+half,start,cy+span*.36,start,cy+span)}`,'Z',`M ${number(end,cy-span)}`,`L ${number(end,cy+span)}`,`C ${number(end,cy+span*.36,right+(end-right)*.45,cy+half,right,cy+half)}`,`C ${number(right-cap,cy+half,right-cap,cy-half,right,cy-half)}`,`C ${number(right+(end-right)*.45,cy-half,end,cy-span*.36,end,cy-span)}`,'Z'].join(' ');
  return {offset,neck,sourcePressure:1.2*Math.sin(Math.PI*p)};
}
/** Only a server-confirmed slug becomes a public link. Never trust a pasted URL. */
export function publicationShareUrl(origin:string,slug:string) {
  if(!slug||!slug.trim())throw new Error('分身已保存，但服务器尚未返回分享链接。请在分身列表中查看。');
  return new URL(`/s/${encodeURIComponent(slug)}`,origin).href;
}
/** A failed list refresh must not turn a confirmed publication into a failed publish. */
export async function publishWithReceipt<T>({publish,onConfirmed,refresh}:{publish:()=>Promise<T>;onConfirmed:(response:T)=>void;refresh:()=>Promise<unknown>}) {
  const response=await publish();
  onConfirmed(response);
  try{await refresh();return {response,refreshError:undefined};}catch(refreshError){return {response,refreshError};}
}
