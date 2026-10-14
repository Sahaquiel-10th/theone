/** Only same-site task links are routed inside ONE; other links keep normal browser behavior. */
export function internalTaskId(href:string,base:string):string|undefined {
  try {
    const current=new URL(base),target=new URL(href,current);
    if(target.origin!==current.origin||target.pathname!=='/')return;
    const hash=target.hash.startsWith('#task:')?decodeURIComponent(target.hash.slice(6)):undefined;
    const query=target.searchParams.get('task');
    if(query&&hash&&query!==hash)return;
    const id=query||hash;
    return id&&/^[A-Za-z0-9_-]{1,200}$/.test(id)?id:undefined;
  } catch { return; }
}
