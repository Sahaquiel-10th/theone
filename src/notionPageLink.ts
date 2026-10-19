/** Parse identifiers only. Never follow a pasted URL or infer access from its host. */
export function parseNotionPageLink(value:unknown):{pageId:string;error?:never}|{pageId?:never;error:string}{
  const help='在 Notion 打开目标页面，点右上角“分享 → 复制链接”，再贴到这里；不用发布页面。';
  if(typeof value!=='string'||!value.trim())return{error:'还没填保存位置。'+help};
  if(value.length>4096)return{error:'链接太长了。'+help};
  let text=value.trim();
  const markdown=text.match(/^\[[^\]\r\n]*\]\(([^\s()]+)\)$/);
  if(markdown)text=markdown[1];
  else if(text.startsWith('<')&&text.endsWith('>'))text=text.slice(1,-1);
  const exactId=/^(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{32})$/i;
  const normalize=(id:string)=>id.replaceAll('-','').toLowerCase();
  if(exactId.test(text))return{pageId:normalize(text)};
  try{
    const url=new URL(text);
    const host=url.hostname.toLowerCase();
    const knownHost=['notion.so','www.notion.so','notion.com','www.notion.com','app.notion.com'].includes(host)||host.endsWith('.notion.site');
    if(!['https:','notion:'].includes(url.protocol)||!knownHost||url.username||url.password||url.port)return{error:'这个链接暂时识别不了。'+help};
    // A database may open a particular page via ?p=. Never select the view (?v=)
    // or a block fragment as the writing destination.
    const selected=url.searchParams.get('p');
    if(selected!==null)return exactId.test(selected)?{pageId:normalize(selected)}:{error:'链接中的页面编号不完整。'+help};
    const leaf=decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)||'');
    const match=leaf.match(/(?:^|[^a-f\d])([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{32})$/i);
    if(match)return{pageId:normalize(match[1])};
  }catch{/* Malformed input never reaches the connector. */}
  return{error:'这个链接里没找到具体页面。'+help};
}
