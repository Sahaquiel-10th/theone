import type {IndustryWorkspaceId} from './industryWorkspaceState';
import {clearTeachingWorkbenchParams} from './teachingWorkbenchNavigation';

export type OnePageSurface='chat'|'things'|'features'|'avatars'|'account'|'admin'|'company'|'agents'|'agentEditor';
export type IndustryPageLocation={open:boolean;workspace:IndustryWorkspaceId|null;surface:OnePageSurface};
type NavigationRecord={version:1;scopeKey:string;surface:OnePageSurface};
export type IndustryNavigationBrowser={
  location:{href:string};
  history:{state:unknown;pushState:(data:unknown,unused:string,url?:string|URL|null)=>void;replaceState:(data:unknown,unused:string,url?:string|URL|null)=>void};
  sessionStorage?:Pick<Storage,'getItem'|'setItem'>;
};
type ResizeTarget={addEventListener:(type:'resize',listener:()=>void)=>void;removeEventListener:(type:'resize',listener:()=>void)=>void};
/** Viewport changes must keep working while the chat canvas is hidden or not yet mounted. */
export function observeWorkspaceViewport(browser:ResizeTarget&{innerWidth:number;innerHeight:number;visualViewport?:ResizeTarget|null},onChange:(size:{width:number;height:number})=>void){
  const measure=()=>onChange({width:browser.innerWidth,height:browser.innerHeight}),visualViewport=browser.visualViewport;
  browser.addEventListener('resize',measure);visualViewport?.addEventListener('resize',measure);measure();
  return()=>{browser.removeEventListener('resize',measure);visualViewport?.removeEventListener('resize',measure);};
}
const historyKey='oneIndustryPage';
const ownerKey='one-industry-page-owner:v1';
const workspaces:readonly string[]=['teaching','product_creative','image_edit','review_reply'];
const surfaces:readonly string[]=['chat','things','features','avatars','account','admin','company','agents','agentEditor'];
const recordObject=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function navigationRecord(value:unknown):NavigationRecord|undefined{
  const entry=recordObject(recordObject(value)[historyKey]);
  if(entry.version===1&&typeof entry.scopeKey==='string'&&surfaces.includes(entry.surface as string))return entry as NavigationRecord;
}
function previousOwner(browser:IndustryNavigationBrowser){try{return browser.sessionStorage?.getItem(ownerKey)??undefined;}catch{return;}}
function own(browser:IndustryNavigationBrowser,scopeKey:string){try{browser.sessionStorage?.setItem(ownerKey,scopeKey);}catch{/* URLs and history work even when storage is unavailable. */}}
function relative(url:URL){return `${url.pathname}${url.search}${url.hash}`;}
function historyState(current:unknown,scopeKey:string,surface:OnePageSurface){return {...recordObject(current),[historyKey]:{version:1,scopeKey,surface} satisfies NavigationRecord};}

/** A URL contains a public workflow kind only. Task and draft identifiers stay in their existing scoped stores. */
export function industryWorkspaceFromHref(href:string,base=href):IndustryWorkspaceId|null|undefined{
  try{
    const url=new URL(href,base),origin=new URL(base).origin;
    if(url.origin!==origin)return;
    const match=/^\/workbenches(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if(!match)return;
    if(!match[1])return null;
    return workspaces.includes(match[1])?match[1] as IndustryWorkspaceId:undefined;
  }catch{return;}
}

export function readIndustryPageNavigation(browser:IndustryNavigationBrowser,scopeKey:string,fallback:OnePageSurface='chat'):{page:IndustryPageLocation;href:string}{
  const url=new URL(browser.location.href),record=navigationRecord(browser.history.state),storedOwner=previousOwner(browser);
  const changedOwner=Boolean(record&&record.scopeKey!==scopeKey||storedOwner&&storedOwner!==scopeKey);
  const open=/^\/workbenches(?:\/|$)/.test(url.pathname);
  const workspace=open&&!changedOwner?industryWorkspaceFromHref(url.href)??null:null;
  const connectorReturn=!changedOwner&&!record&&(url.searchParams.has('notion')||url.searchParams.has('knowledge'));
  const surface=connectorReturn?'account':!changedOwner&&record?.scopeKey===scopeKey?record.surface:fallback;
  if(changedOwner){url.pathname=open?'/workbenches':'/';url.search='';url.hash='';}
  else if(open)url.pathname=workspace?`/workbenches/${workspace}`:'/workbenches';
  return {page:{open,workspace,surface},href:relative(url)};
}

/** Claim the current entry, also used by popstate. Reading never pushes a new entry. */
export function syncIndustryPageNavigation(browser:IndustryNavigationBrowser,scopeKey:string,fallback:OnePageSurface='chat'):IndustryPageLocation{
  const {page,href}=readIndustryPageNavigation(browser,scopeKey,fallback);
  browser.history.replaceState(historyState(browser.history.state,scopeKey,page.surface),'',href);
  own(browser,scopeKey);
  return page;
}

export function openIndustryPageNavigation(browser:IndustryNavigationBrowser,scopeKey:string,workspace:IndustryWorkspaceId|null,surface:OnePageSurface):IndustryPageLocation{
  // Stamp the departing ONE entry so Back restores its destination without resetting its chat.
  const current=syncIndustryPageNavigation(browser,scopeKey,surface),url=new URL(browser.location.href);
  if(!current.open)browser.history.replaceState(historyState(browser.history.state,scopeKey,surface),'',relative(url));
  clearTeachingWorkbenchParams(url);
  url.pathname=workspace?`/workbenches/${workspace}`:'/workbenches';
  const state=historyState(browser.history.state,scopeKey,surface);
  if(relative(url)!==relative(new URL(browser.location.href)))browser.history.pushState(state,'',relative(url));
  else browser.history.replaceState(state,'',relative(url));
  return {...current,open:true,workspace,surface};
}

/** Ordinary ONE sections keep their current URL parameters; only the industry pathname is removed. */
export function exitIndustryPageNavigation(browser:IndustryNavigationBrowser,scopeKey:string,surface:OnePageSurface):IndustryPageLocation{
  const current=syncIndustryPageNavigation(browser,scopeKey,surface),url=new URL(browser.location.href);
  if(current.open)url.pathname='/';
  clearTeachingWorkbenchParams(url);
  const state=historyState(browser.history.state,scopeKey,surface);
  if(current.open)browser.history.pushState(state,'',relative(url));
  else browser.history.replaceState(state,'',relative(url));
  return {open:false,workspace:null,surface};
}
