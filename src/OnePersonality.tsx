import {useEffect,useState} from 'react';
export const greetings=['我在。','嗯，听着呢。','今天想搞定什么？','有想法，尽管说。','来，把这件事聊明白。','准备好了。','开个头，我来接。','今天也一起想办法。','先说说你的想法。','这儿，给你留着位置。','想聊就聊，想做就做。','不急，我们一件件来。','有什么新点子？','好，轮到我们了。','随时可以开始。','脑洞可以大一点。','把难题拿过来吧。','今天从哪件事开始？','我听你说。','我们试试看。'];
export const waitingLines=['( •̀ᴗ•́ ) 在想了，先让我捋一捋。','( ˘ω˘ ) 给脑回路一点转弯的空间。','(ง •̀_•́)ง 这件事，认真想。','( •ω• ) 你的问题没丢，我还在。','(._.) 正在把思路排整齐。','(๑•̀ㅂ•́)و 先别急着下结论。','( ˙꒳˙ ) 脑内小齿轮转起来了。','( •̀ω•́ ) 让我换个角度想想。','(｡･ω･｡) 在呢，没溜走。','( •_• ) 想明白一点，再说出来。','( •̀ᴗ•́ ) 这回要讲清楚。','( ˘︶˘ ) 把零散思路收一收。','(ง •̀ᴗ•́)ง 再往前想一步。','(._.) 先给答案留点耐心。','( •ω• ) 不催自己，但也没偷懒。','(๑•̀ω•́) 想法正在排队。','( ˙ᵕ˙ ) 别担心，我还在琢磨。','( •̀_•́ ) 把重点找准。','(｡•̀ᴗ-)✧ 正在认真回应。','( •ω• ) 好问题值得多想一会儿。'];
export function chooseCopy(lines:readonly string[],previous=-1,random=Math.random){const value=Math.floor(random()*(lines.length-(previous>=0?1:0)));return value>=previous&&previous>=0?value+1:value;}
export function useOneGreeting(context=''){const [index,setIndex]=useState(()=>chooseCopy(greetings));useEffect(()=>setIndex(i=>chooseCopy(greetings,i)),[context]);return greetings[index];}
export function OneWaitingCopy(){
  const [index,setIndex]=useState(()=>chooseCopy(waitingLines));
  useEffect(()=>{
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(reduced)return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')setIndex(i=>chooseCopy(waitingLines,i));},8500);return()=>clearInterval(timer);
  },[]);
  return <div className="studio-wait one-waiting-copy" role="status" aria-label="正在准备回复" aria-live="off"><p key={index}>{waitingLines[index]}</p></div>;
}
